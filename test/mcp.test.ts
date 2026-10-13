import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectMcp, loadMcpServers } from '../src/mcp.js';
import { MCP_CONFIG_ENV } from '../src/mcp-config.js';
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
  const conn = await connectMcp(process.execPath, ['-e', FAKE_SERVER]);
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
  const conn = await connectMcp(process.execPath, ['-e', FAKE_RESOURCE_SERVER]);
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
  await assert.rejects(
    () => connectMcp(process.execPath, ['-e', 'process.exit(0)'], undefined, { requestTimeoutMs: 200 }),
    /exited with code 0/,
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
  await assert.rejects(
    () => connectMcp(process.execPath, ['-e', halfServer], undefined, { requestTimeoutMs: 200 }),
    /timed out after 200ms: tools\/list/,
  );
});
