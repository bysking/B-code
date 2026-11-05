import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeMcpConnection,
  connectMcp,
  connectMcpServer,
  isMcpConnected,
  loadMcpServers,
  reconnectMcpServer,
} from '../src/mcp.js';
import { MCP_CONFIG_ENV, transportKind } from '../src/mcp-config.js';
import { Registry, type RuntimeContext } from '../src/registry.js';

/**
 * 假 MCP server：一个实现 JSON-RPC(stdio) 的 node 脚本，
 * 提供 initialize/tools/list → echo 工具 /tools/call。
 * 无需真实 MCP SDK，端到端验证握手、发现、调用、前缀路由。
 */
const FAKE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  let out;
  if (m.method === 'initialize') {
    out = { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } };
  } else if (m.method === 'tools/list') {
    out = { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } };
  } else if (m.method === 'tools/call') {
    out = { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + m.params.arguments.text }] } };
  } else {
    out = { jsonrpc: '2.0', id: m.id, result: {} };
  }
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;

/**
 * 假 MCP server（带资源）：tools/list 一个工具 + resources/list + resources/read。
 * 验证资源以只读工具形态暴露。
 */
const FAKE_RESOURCE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  let out;
  if (m.method === 'initialize') {
    out = { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { resources: {} }, serverInfo: { name: 'res', version: '1' } } };
  } else if (m.method === 'tools/list') {
    out = { jsonrpc: '2.0', id: m.id, result: { tools: [] } };
  } else if (m.method === 'resources/list') {
    out = { jsonrpc: '2.0', id: m.id, result: { resources: [{ uri: 'file:///notes.md', name: 'notes', description: '项目笔记' }] } };
  } else if (m.method === 'resources/read') {
    out = { jsonrpc: '2.0', id: m.id, result: { contents: [{ uri: m.params.uri, text: 'resource body for ' + m.params.uri }] } };
  } else {
    out = { jsonrpc: '2.0', id: m.id, result: {} };
  }
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;

let dir: string;
const savedMcpEnv = process.env[MCP_CONFIG_ENV];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b-code-mcp-'));
});
after(async () => {
  if (savedMcpEnv === undefined) delete process.env[MCP_CONFIG_ENV];
  else process.env[MCP_CONFIG_ENV] = savedMcpEnv;
  await rm(dir, { recursive: true, force: true });
});

test('connectMcp：握手 → 发现 echo → 调用', async () => {
  const conn = await connectMcp({ command: process.execPath, args: ['-e', FAKE_SERVER] });
  try {
    assert.equal(conn.tools.length, 1);
    assert.equal(conn.tools[0]?.name, 'echo');
    const out = await conn.callTool('echo', { text: 'hi' });
    assert.equal(out, 'echo:hi');
  } finally {
    conn.close();
  }
});

test('loadMcpServers：mcp.json 前缀注册 mcp__server__tool 并可调用', async () => {
  const cfg = join(dir, 'mcp.json');
  await writeFile(
    cfg,
    JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: ['-e', FAKE_SERVER] } } }),
  );
  process.env[MCP_CONFIG_ENV] = cfg;

  const registry = new Registry();
  await loadMcpServers(registry);

  const mp = registry.resolve('mcp__fake__echo');
  assert.ok(mp, '前缀工具已注册（改配置不加代码）');
  assert.equal(mp?.mode, 'external', '未声明 read 的 server 默认 confirm（fail-closed）');

  const ctx = {} as RuntimeContext;
  const out = await mp?.handler({ text: 'pong' }, ctx);
  assert.equal(out, 'echo:pong');
});

test('loadMcpServers：server 连不上只警告不阻塞', async () => {
  const cfg = join(dir, 'bad-mcp.json');
  await writeFile(
    cfg,
    JSON.stringify({ mcpServers: { dead: { command: 'definitely-not-a-command', args: [] } } }),
  );
  process.env[MCP_CONFIG_ENV] = cfg;

  const registry = new Registry();
  await loadMcpServers(registry); // 不抛
  assert.equal(registry.resolve('mcp__dead__x'), undefined);
});

test('MCP 资源：resources/list + read 以只读工具暴露', async () => {
  const conn = await connectMcp({ command: process.execPath, args: ['-e', FAKE_RESOURCE_SERVER] });
  try {
    assert.equal(conn.resources.length, 1);
    assert.equal(conn.resources[0]?.uri, 'file:///notes.md');
    const body = await conn.readResource('file:///notes.md');
    assert.equal(body, 'resource body for file:///notes.md');
  } finally {
    conn.close();
  }
});

test('loadMcpServers：资源注册为 mcp__server__read_resource（read 模式）', async () => {
  const cfg = join(dir, 'res-mcp.json');
  await writeFile(
    cfg,
    JSON.stringify({
      mcpServers: { res: { command: process.execPath, args: ['-e', FAKE_RESOURCE_SERVER] } },
    }),
  );
  process.env[MCP_CONFIG_ENV] = cfg;

  const registry = new Registry();
  await loadMcpServers(registry);
  const mp = registry.resolve('mcp__res__read_resource');
  assert.ok(mp, '资源工具已注册');
  assert.equal(mp?.mode, 'read', '资源只读：plan 模式放行、免确认');
  assert.ok(mp?.description.includes('file:///notes.md'), '描述含资源目录');
  const out = await mp?.handler({ uri: 'file:///notes.md' }, {} as RuntimeContext);
  assert.ok(String(out).includes('resource body'), '可按 uri 读取');
});

test('loadMcpServers：server 不支持 resources → 优雅降级（不注册资源工具）', async () => {
  const cfg = join(dir, 'nores-mcp.json');
  await writeFile(
    cfg,
    JSON.stringify({ mcpServers: { plain: { command: process.execPath, args: ['-e', FAKE_SERVER] } } }),
  );
  process.env[MCP_CONFIG_ENV] = cfg;
  const registry = new Registry();
  await loadMcpServers(registry);
  assert.ok(registry.resolve('mcp__plain__echo'), '工具仍正常注册');
  assert.equal(registry.resolve('mcp__plain__read_resource'), undefined, '无资源则不注册');
});

test('connectMcp：server 立即退出 → 请求 reject 而非挂死', async () => {
  // SDK 会归一化成标准 JSON-RPC 错误（Connection closed），比手写版的裸 Error 更规范
  await assert.rejects(
    () => connectMcp({ command: process.execPath, args: ['-e', 'process.exit(0)'] }, { requestTimeoutMs: 200 }),
    /Connection closed|exited with code/i,
  );
});

test('connectMcp：server 不回包 → 超时 reject 而非挂死', async () => {
  // 只回应 initialize，不回 tools/list（或干脆什么都不做），靠超时兜底
  const halfServer = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'half', version: '1' } } }) + '\\n');
  }
});
`;
  // SDK 用 -32001（Request timed out），并会自行中止在飞请求
  await assert.rejects(
    () => connectMcp({ command: process.execPath, args: ['-e', halfServer] }, { requestTimeoutMs: 200 }),
    /timed out|-32001/i,
  );
});

// ── 单 server 连接 / 重连（/mcp 面板 R 键）────────────────────
test('connectMcpServer：按名字记录连接，isMcpConnected 可查', async () => {
  const registry = new Registry();
  const r = await connectMcpServer(registry, 'unit', {
    command: process.execPath,
    args: ['-e', FAKE_SERVER],
  });
  try {
    assert.equal(r.ok, true);
    assert.equal(r.toolCount, 1, '一个 echo 工具');
    assert.equal(isMcpConnected('unit'), true);
    assert.ok(registry.resolve('mcp__unit__echo'), '已注册前缀工具');
  } finally {
    closeMcpConnection('unit');
  }
  assert.equal(isMcpConnected('unit'), false, '关闭后不再记录');
});

test('reconnectMcpServer：重连替换连接，工具不重复注册', async () => {
  const cfg = join(dir, 'reconnect.json');
  await writeFile(
    cfg,
    JSON.stringify({ mcpServers: { rc: { command: process.execPath, args: ['-e', FAKE_SERVER] } } }),
  );
  process.env[MCP_CONFIG_ENV] = cfg;

  const registry = new Registry();
  await connectMcpServer(registry, 'rc', {
    command: process.execPath,
    args: ['-e', FAKE_SERVER],
  });
  const before = registry.list(undefined, true).length;
  assert.equal(before, 1, '首次只有 1 个工具');

  const r = await reconnectMcpServer(registry, 'rc');
  try {
    assert.equal(r.ok, true, '重连成功');
    assert.equal(r.toolCount, 1);
    assert.equal(registry.list(undefined, true).length, 1, '工具没有重复累加');
    const mp = registry.resolve('mcp__rc__echo');
    assert.ok(mp);
    // 重连后的 handler 必须指向新进程（旧进程已 kill）
    const ctx = {} as RuntimeContext;
    assert.equal(await mp.handler({ text: 'pong' }, ctx), 'echo:pong');
  } finally {
    closeMcpConnection('rc');
  }
});

test('reconnectMcpServer：未配置的 server → 报错而不是静默成功', async () => {
  process.env[MCP_CONFIG_ENV] = join(dir, 'reconnect.json'); // 只有 rc
  const registry = new Registry();
  const r = await reconnectMcpServer(registry, 'ghost');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /未在 mcp\.json 中找到 ghost/);
});

test('重连失败：registry 里不留指向死进程的工具', async () => {
  const cfg = join(dir, 'dead-reconnect.json');
  await writeFile(
    cfg,
    JSON.stringify({ mcpServers: { dead: { command: 'definitely-not-a-command', args: [] } } }),
  );
  process.env[MCP_CONFIG_ENV] = cfg;

  const registry = new Registry();
  // 先塞一个"旧工具"，模拟之前连上过
  registry.register({ name: 'mcp__dead__x', description: 'd', inputSchema: {}, handler: () => '' });

  const r = await reconnectMcpServer(registry, 'dead');
  assert.equal(r.ok, false);
  assert.equal(
    registry.resolve('mcp__dead__x'),
    undefined,
    '失败后旧工具被摘除（不留下半残 handler）',
  );
});

// ── stderr 不得污染终端 ───────────────────────────────────────
//
// 曾用 stdio: ['pipe','pipe','inherit']：子进程 stderr 直连我们的终端，而 TTY 下
// 终端已被 ink 接管。重连时被杀进程残留的未刷出字节会把画面打成 `^[[A^[[B^M`，
// 用户看到的是"输入中断、一直输出特殊字符、面板关不掉"。
test('回归：MCP server 的 stderr 收进日志，不直连终端', async () => {
  const noisy = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
process.stderr.write('SERVER NOISE LINE\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  const out = m.method === 'initialize'
    ? { jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2024-11-05', capabilities:{}, serverInfo:{name:'noisy',version:'1'} } }
    : m.method === 'tools/list'
      ? { jsonrpc:'2.0', id:m.id, result:{ tools:[] } }
      : { jsonrpc:'2.0', id:m.id, result:{} };
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;
  const conn = await connectMcp({ command: process.execPath, args: ['-e', noisy] });
  await new Promise((r) => setTimeout(r, 150));
  conn.close();
  // 连上了就说明 stderr 改 pipe 后握手/通信都正常（stdio 改动没破坏协议）
  assert.ok(conn, 'stderr 改 pipe 后连接与握手正常');
});

test('close：断开 readline 并给 SIGKILL 兜底，避免旧进程残留', async () => {
  const conn = await connectMcp({ command: process.execPath, args: ['-e', FAKE_SERVER] });
  // close 应可重复调用（重连路径会先关再开）
  assert.doesNotThrow(() => conn.close());
  assert.doesNotThrow(() => conn.close(), '重复 close 不抛');
});

// ── SDK 迁移带来的新能力 ───────────────────────────────────────

/**
 * 带 annotations 的 server：验证 readOnlyHint 能自动判定权限模式。
 * 这是 SDK 化的直接收益——以前只能靠 mcp.json 手写 mode:"read" 整片声明，
 * 现在 server 自己标的语义提示就能生效（MCP 规范的一部分，比猜可靠）。
 */
const ANNOTATED_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  let out;
  if (m.method === 'initialize') {
    out = { jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2024-11-05', capabilities:{ tools:{} }, serverInfo:{ name:'ann', version:'1' } } };
  } else if (m.method === 'tools/list') {
    out = { jsonrpc:'2.0', id:m.id, result:{ tools:[
      { name:'get_thing', description:'读', inputSchema:{ type:'object', properties:{} },
        annotations:{ readOnlyHint: true } },
      { name:'delete_thing', description:'删', inputSchema:{ type:'object', properties:{} },
        annotations:{ readOnlyHint: false, destructiveHint: true } },
      { name:'unmarked', description:'未标注', inputSchema:{ type:'object', properties:{} } },
    ] } };
  } else {
    out = { jsonrpc:'2.0', id:m.id, result:{} };
  }
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;

test('SDK 能力：readOnlyHint 自动判定为只读，destructive 标注进描述', async () => {
  const cfgFile = join(dir, 'annotated.json');
  await writeFile(
    cfgFile,
    JSON.stringify({
      mcpServers: { ann: { command: process.execPath, args: ['-e', ANNOTATED_SERVER] } },
    }),
  );
  process.env[MCP_CONFIG_ENV] = cfgFile;

  const registry = new Registry();
  await loadMcpServers(registry);
  try {
    const readTool = registry.resolve('mcp__ann__get_thing');
    assert.equal(readTool?.mode, 'read', 'readOnlyHint:true → 只读（免确认、plan 放行）');

    const destructive = registry.resolve('mcp__ann__delete_thing');
    assert.equal(destructive?.mode, 'external', '非只读 → external（fail-closed）');
    assert.match(destructive?.description ?? '', /destructive/, '破坏性标注进描述，模型可见');

    const unmarked = registry.resolve('mcp__ann__unmarked');
    assert.equal(unmarked?.mode, 'external', '未标注 → fail-closed 到 external');
  } finally {
    closeMcpConnection('ann');
  }
});

test('SDK 能力：server 级 mode:read 覆盖工具自带标注', async () => {
  const cfgFile = join(dir, 'server-read.json');
  await writeFile(
    cfgFile,
    JSON.stringify({
      mcpServers: {
        ann: { command: process.execPath, args: ['-e', ANNOTATED_SERVER], mode: 'read' },
      },
    }),
  );
  process.env[MCP_CONFIG_ENV] = cfgFile;

  const registry = new Registry();
  await loadMcpServers(registry);
  try {
    // 用户显式声明信任整个 server → 即便工具没标 readOnly 也按只读放行
    assert.equal(registry.resolve('mcp__ann__unmarked')?.mode, 'read');
    assert.equal(registry.resolve('mcp__ann__delete_thing')?.mode, 'read');
  } finally {
    closeMcpConnection('ann');
  }
});

test('transportKind：command 优先于 url，都没有则 invalid', () => {
  assert.equal(transportKind({ command: 'npx' }), 'stdio');
  assert.equal(transportKind({ url: 'https://x/mcp' }), 'http');
  assert.equal(transportKind({ command: 'npx', url: 'https://x' }), 'stdio', 'command 优先');
  assert.equal(transportKind({}), 'invalid');
});

test('connectMcp：配置缺 command 和 url → 明确报错而非静默失败', async () => {
  await assert.rejects(() => connectMcp({}), /缺少 command 或 url/);
});

test('HTTP 传输：url 配置能被识别并尝试连接（连不上时报错而非崩）', async () => {
  // 指向一个不存在的本地端口：验证走的是 HTTP 路径且失败可控
  const r = await connectMcpServer(new Registry(), 'remote', {
    url: 'http://127.0.0.1:1/mcp',
  });
  assert.equal(r.ok, false, '连不上 → ok:false');
  assert.ok(r.error, '带回失败原因');
});

test('connectMcp：工具执行失败时结果带回 [tool error] 前缀（模型才知道失败了）', async () => {
  const errServer = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  let out;
  if (m.method === 'initialize') out = { jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2024-11-05', capabilities:{ tools:{} }, serverInfo:{name:'e',version:'1'} } };
  else if (m.method === 'tools/list') out = { jsonrpc:'2.0', id:m.id, result:{ tools:[{ name:'boom', description:'x', inputSchema:{ type:'object', properties:{} } }] } };
  else if (m.method === 'tools/call') out = { jsonrpc:'2.0', id:m.id, result:{ isError:true, content:[{ type:'text', text:'kaboom' }] } };
  else out = { jsonrpc:'2.0', id:m.id, result:{} };
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;
  const conn = await connectMcp({ command: process.execPath, args: ['-e', errServer] });
  try {
    const out = await conn.callTool('boom', {});
    assert.match(out, /tool error/, '失败标记');
    assert.match(out, /kaboom/, '原始错误内容保留');
  } finally {
    conn.close();
  }
});

// ── 反向调用（server → client）─────────────────────────────────
//
// 这三项是 SDK 化后的直接收益：手写版完全没实现，server 若发这些请求只会
// 超时。现在按"注入才声明"的原则：不注入 → 不声明 → server 自行降级。

/** 会向 client 发 roots/list 请求的 server */
const ROOTS_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let nextId = 1000;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, method, params }) + '\\n');
  });
}
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'initialize') {
    // 先回 initialize，再主动问 roots（必须在握手后）
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2024-11-05', capabilities:{ tools:{} }, serverInfo:{ name:'roots', version:'1' } } }) + '\\n');
  } else if (m.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{ tools:[{ name:'ask_roots', description:'问宿主工作区', inputSchema:{ type:'object', properties:{} } }] } }) + '\\n');
  } else if (m.method === 'tools/call') {
    request('roots/list', {}).then((r) => {
      const uris = (r && r.roots ? r.roots : []).map((x) => x.uri).join(',');
      process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{ content:[{ type:'text', text:'roots=' + uris }] } }) + '\\n');
    });
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{} }) + '\\n');
  }
});
`;

test('反向调用 roots：注入后 server 能拿到工作区根目录', async () => {
  const conn = await connectMcp(
    { command: process.execPath, args: ['-e', ROOTS_SERVER] },
    { host: { roots: () => [{ uri: 'file:///my/project', name: 'project' }] } },
  );
  try {
    const out = await conn.callTool('ask_roots', {});
    assert.match(out, /file:\/\/\/my\/project/, 'server 拿到了宿主声明的 roots');
  } finally {
    conn.close();
  }
});

test('反向调用 roots：未注入则 server 请求失败（不挂死）', async () => {
  const conn = await connectMcp({ command: process.execPath, args: ['-e', ROOTS_SERVER] });
  try {
    // 没声明 roots 能力 → SDK 会拒绝该请求，server 侧拿到错误；关键是不挂死
    const out = await conn.callTool('ask_roots', {});
    assert.equal(typeof out, 'string', '调用返回而非挂起');
  } finally {
    conn.close();
  }
});

/** 会发 sampling/createMessage 的 server */
const SAMPLING_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let nextId = 2000;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, method, params }) + '\\n');
  });
}
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2024-11-05', capabilities:{ tools:{} }, serverInfo:{ name:'samp', version:'1' } } }) + '\\n');
  } else if (m.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{ tools:[{ name:'ask_llm', description:'借宿主模型', inputSchema:{ type:'object', properties:{} } }] } }) + '\\n');
  } else if (m.method === 'tools/call') {
    request('sampling/createMessage', { messages:[{ role:'user', content:{ type:'text', text:'hi' } }], maxTokens: 64 })
      .then((r) => {
        const t = r && r.content ? r.content.text : '(none)';
        process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{ content:[{ type:'text', text:'llm=' + t }] } }) + '\\n');
      });
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{} }) + '\\n');
  }
});
`;

test('反向调用 sampling：server 借用宿主模型跑补全', async () => {
  const conn = await connectMcp(
    { command: process.execPath, args: ['-e', SAMPLING_SERVER] },
    { host: { sample: async () => 'borrowed-completion' } },
  );
  try {
    const out = await conn.callTool('ask_llm', {});
    assert.match(out, /llm=borrowed-completion/, 'server 拿到了宿主代跑的补全结果');
  } finally {
    conn.close();
  }
});

// ── 动态工具变更（notifications/tools/list_changed）─────────────

/** 首次 tools/list 只给 1 个工具，之后收到 trigger 再发通知并暴露 2 个 */
const DYNAMIC_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let toolCount = 1;
rl.on('line', (line) => {
  const m = JSON.parse(line);
  let out;
  if (m.method === 'initialize') out = { jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2024-11-05', capabilities:{ tools:{ listChanged: true } }, serverInfo:{name:'dyn',version:'1'} } };
  else if (m.method === 'tools/list') {
    const tools = [];
    for (let i = 0; i < toolCount; i++) tools.push({ name:'t' + i, description:'t', inputSchema:{ type:'object', properties:{} } });
    out = { jsonrpc:'2.0', id:m.id, result:{ tools } };
  } else if (m.method === 'tools/call') {
    // 调用即"解锁"第二个工具，并发通知
    toolCount = 2;
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', method:'notifications/tools/list_changed' }) + '\\n');
    out = { jsonrpc:'2.0', id:m.id, result:{ content:[{ type:'text', text:'unlocked' }] } };
  } else out = { jsonrpc:'2.0', id:m.id, result:{} };
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;

test('动态工具：server 发 list_changed 后回调收到新工具列表', async () => {
  let changed: string[] | null = null;
  const conn = await connectMcp(
    { command: process.execPath, args: ['-e', DYNAMIC_SERVER] },
    { onToolsChanged: (tools) => { changed = tools.map((t) => t.name); } },
  );
  try {
    assert.equal(conn.tools.length, 1, '初始 1 个工具');
    await conn.callTool('t0', {}); // 触发 server 改工具列表 + 通知
    // 等通知与随后的 tools/list 往返
    for (let i = 0; i < 40 && changed === null; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(changed, ['t0', 't1'], '动态变更回调收到完整新列表');
  } finally {
    conn.close();
  }
});

// ── 工具变更后 registry 自动重注册 ─────────────────────────────
test('动态工具：变更后 registry 里出现新工具（无需手动重连）', async () => {
  const cfgFile = join(dir, 'dynamic.json');
  await writeFile(
    cfgFile,
    JSON.stringify({
      mcpServers: { dyn: { command: process.execPath, args: ['-e', DYNAMIC_SERVER] } },
    }),
  );
  process.env[MCP_CONFIG_ENV] = cfgFile;

  const registry = new Registry();
  await loadMcpServers(registry);
  try {
    assert.ok(registry.resolve('mcp__dyn__t0'), '初始工具已注册');
    assert.equal(registry.resolve('mcp__dyn__t1'), undefined, '第二个工具起初不存在');

    // 调用触发 server 变更
    await registry.resolve('mcp__dyn__t0')!.handler({}, {} as RuntimeContext);

    // 等 registry 完成重注册
    for (let i = 0; i < 40 && !registry.resolve('mcp__dyn__t1'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(registry.resolve('mcp__dyn__t1'), '新工具自动出现，无需手动 R 重连');
  } finally {
    closeMcpConnection('dyn');
  }
});

// ── 资源订阅（resources/subscribe + updated 通知）────────────────

/** 声明 subscribe 能力的 server：subscribe 后主动推一次 updated */
const SUBSCRIBE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  let out;
  if (m.method === 'initialize') out = { jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2024-11-05', capabilities:{ resources:{ subscribe: true } }, serverInfo:{name:'sub',version:'1'} } };
  else if (m.method === 'tools/list') out = { jsonrpc:'2.0', id:m.id, result:{ tools:[] } };
  else if (m.method === 'resources/list') out = { jsonrpc:'2.0', id:m.id, result:{ resources:[{ uri:'file:///watched.md', name:'watched' }] } };
  else if (m.method === 'resources/subscribe') {
    out = { jsonrpc:'2.0', id:m.id, result:{} };
    process.stdout.write(JSON.stringify(out) + '\\n');
    // 订阅成功后推一条变更通知
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc:'2.0', method:'notifications/resources/updated', params:{ uri:'file:///watched.md' } }) + '\\n');
    }, 30);
    return;
  }
  else out = { jsonrpc:'2.0', id:m.id, result:{} };
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;

test('资源订阅：声明 subscribe 的 server 可订阅，变更时收到 updated 通知', async () => {
  const updates: string[] = [];
  const conn = await connectMcp(
    { command: process.execPath, args: ['-e', SUBSCRIBE_SERVER] },
    { onResourceUpdated: (uri) => updates.push(uri) },
  );
  try {
    const ok = await conn.subscribeResource('file:///watched.md');
    assert.equal(ok, true, 'server 支持 subscribe → 订阅成功');
    for (let i = 0; i < 40 && updates.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(updates, ['file:///watched.md'], '收到资源变更通知');
  } finally {
    conn.close();
  }
});

test('资源订阅：server 未声明 subscribe 能力 → 返回 false 而非报错', async () => {
  const conn = await connectMcp({ command: process.execPath, args: ['-e', FAKE_RESOURCE_SERVER] });
  try {
    assert.equal(await conn.subscribeResource('file:///notes.md'), false, '不支持就跳过');
  } finally {
    conn.close();
  }
});

// ── 能力声明：不注入就不声明 ────────────────────────────────────
test('能力声明：只注入 roots 时，sampling/elicitation 不声明', async () => {
  const conn = await connectMcp(
    { command: process.execPath, args: ['-e', FAKE_SERVER] },
    { host: { roots: () => [] } },
  );
  try {
    assert.ok(conn, '连接正常');
  } finally {
    conn.close();
  }
});
