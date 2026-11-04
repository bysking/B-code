import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Registry } from './registry.js';
import { resolveMcpConfigs } from './mcp-config.js';
import { log } from './utils/log.js';

/**
 * MCP 客户端 + mcp-loader（施工图 §12）
 *
 * 协议：spawn 子进程 → JSON-RPC(stdin/stdout 逐行) → initialize 握手 →
 *       notifications/initialized → tools/list 发现 → 前缀注册 mcp__server__tool
 * 对 Agent 循环而言，MCP 工具与内置工具没有区别：都是 name + schema + handler。
 *
 * 本实现不依赖 MCP SDK（零额外依赖），按官方 stdio 协议手写。
 */

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP 资源（resources/list）：以只读工具形态暴露给模型 */
export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpConnection {
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  readResource(uri: string): Promise<string>;
  close(): void;
}

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// MCP server 是长驻子进程，若不 kill 会拖住主进程事件循环，导致 chat 完成后进程永不退出。
// 关键：不能挂在 process "exit" 上——正是子进程句柄阻止进程退出，exit 事件根本不会触发。
// 用 beforeExit（事件循环即将空时触发，杀掉子进程后循环才有机会真正变空）＋业务终点显式关闭。
/**
 * server 名 → 连接。按 server 索引（而非扁平数组）是为了支持**单个 server 重连**：
 * 重连时替换这一条即可，不必惊动其他 server。
 */
const serverConnections = new Map<string, McpConnection>();
let cleanupInstalled = false;
function installExitCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('beforeExit', closeAllMcpConnections);
}

/** 显式关闭全部已连接 server（业务终点调用：one-shot 结束、REPL 关闭） */
export function closeAllMcpConnections(): void {
  for (const conn of serverConnections.values()) {
    try {
      conn.close();
    } catch {
      // 已关闭
    }
  }
  serverConnections.clear();
}

/** 关闭单个 server 的连接（重连前清理旧进程） */
export function closeMcpConnection(serverName: string): void {
  const conn = serverConnections.get(serverName);
  if (!conn) return;
  serverConnections.delete(serverName);
  try {
    conn.close();
  } catch {
    // 已关闭
  }
}

/** 该 server 当前是否持有活连接（/mcp 面板展示状态用） */
export function isMcpConnected(serverName: string): boolean {
  return serverConnections.has(serverName);
}

export interface ConnectMcpOptions {
  /** 单次 JSON-RPC 请求超时（防 server 没回包时挂死）；默认 15s */
  requestTimeoutMs?: number;
}

export async function connectMcp(
  command: string,
  args: string[],
  env?: Record<string, string>,
  opts: ConnectMcpOptions = {},
): Promise<McpConnection> {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // stdio 声明为 pipe 后 stdout/stdin 类型非空，无需强转
  const proc = spawn(command, args, {
    // stderr 必须 pipe 而不是 inherit。
    //
    // inherit 会让 server 的 stderr **直连我们的终端**——而 TTY 下终端已被 ink 接管
    // （光标定位、同步更新序列）。子进程随便吐一行日志就能打乱 ink 的帧；重连时
    // 被杀进程残留的未刷出字节会被强制写出来，屏幕上就出现 `^[[A^[[B^M` 这类乱码，
    // 看起来像"输入被中断、一直输出特殊字符"。
    //
    // 改为 pipe 后统一收进日志系统（Ctrl+O 的"日志"页可查），既保留可诊断性，又不污染画面。
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
  });

  // server 的 stderr 转成日志行（不写终端）。按行切，避免半行打断排版。
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.trim()) log.info(`[mcp] ${line.trim()}`);
    }
  });

  // spawn 失败（ENOENT 等）是异步 error 事件，必须有人接，否则 uncaughtException 炸整个进程
  const spawnError = new Promise((_, reject) => proc.once('error', reject));
  proc.on('error', () => {}); // 后续错误（如进程被杀）静默收尾
  try {
    await Promise.race([spawnError, new Promise<void>((r) => proc.once('spawn', r))]);
  } catch (err) {
    proc.off('error', () => {});
    throw err;
  }

  const rl = createInterface({ input: proc.stdout });
  let nextId = 1;
  const pending = new Map<number, { resolve: (msg: any) => void; reject: (err: Error) => void }>();

  // server 退出/报错：reject 所有在途请求（否则 initialize 永等 → 调用方挂死）
  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  proc.on('exit', (code) => failAll(new Error(`MCP server exited with code ${code}`)));
  proc.on('error', (err) => failAll(err));

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        entry.resolve(msg);
      }
    } catch {
      // 忽略非 JSON 行（如 server 启动日志）
    }
  });

  const request = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { resources: {} },
    clientInfo: { name: 'b-code', version: '0.1.0' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const listed = await request('tools/list');
  const tools: McpToolInfo[] = (listed.result?.tools ?? []).map((t: any) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

  // resources/list 为可选能力：server 未声明/报错时优雅降级为空（不阻断 tools）
  let resources: McpResourceInfo[] = [];
  try {
    const res = await request('resources/list');
    resources = (res.result?.resources ?? [])
      .filter((r: any) => r && typeof r.uri === 'string')
      .map((r: any) => ({
        uri: r.uri,
        name: typeof r.name === 'string' && r.name ? r.name : r.uri,
        description: r.description,
        mimeType: r.mimeType,
      }));
  } catch {
    resources = []; // 该 server 不支持资源
  }

  const conn: McpConnection = {
    tools,
    resources,
    async callTool(name, callArgs) {
      const resp = await request('tools/call', { name, arguments: callArgs });
      // MCP 返回 content 块数组；取文本，纯结构化内容 JSON 兜底
      const content = resp.result?.content;
      if (Array.isArray(content)) {
        return content.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
      }
      return JSON.stringify(resp.result);
    },
    async readResource(uri) {
      const resp = await request('resources/read', { uri });
      const contents = resp.result?.contents;
      if (Array.isArray(contents)) {
        return contents.map((c: any) => (typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
      }
      return JSON.stringify(resp.result);
    },
    close() {
      try {
        // 先关 stdin 让 server 有机会优雅收尾（多数实现收到 EOF 就退出）
        proc.stdin.end();
      } catch {
        // 已关闭
      }
      // 断开 readline，避免残留在途的 stdout 数据继续被解析成响应
      try {
        rl.close();
      } catch {
        // 忽略
      }
      // SIGTERM 给一个收尾机会，超时再 SIGKILL。重连是"先关旧再开新"，
      // 旧进程若没死干净会和新进程争抢同一份配置资源（端口、锁文件）。
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // 已退出
        }
      }, 2000);
      killTimer.unref?.();
      proc.once('exit', () => clearTimeout(killTimer));
      try {
        proc.kill();
      } catch {
        // 已退出
      }
    },
  };

  installExitCleanup();
  return conn;
}

/** 单 server 连接结果（连接失败不抛，交由调用方决定提示方式） */
export interface McpConnectResult {
  ok: boolean;
  /** 启动的进程 pid（重连后变化，便于用户确认真的换了进程） */
  pid?: number;
  /** 注册的工具数（含 read_resource） */
  toolCount?: number;
  error?: string;
}

/**
 * 连接单个 server 并把它的工具注册进 registry。
 *
 * 重连复用同一函数：先摘旧工具、关旧进程，再走一遍完整握手。这样"首次连接"和
 * "重连"共享一条代码路径，不会出现两套注册逻辑各写一半的情况。
 */
export async function connectMcpServer(
  registry: Registry,
  serverName: string,
  cfg: { command: string; args?: string[]; env?: Record<string, string>; mode?: 'read' },
): Promise<McpConnectResult> {
  // 先清理：旧连接（若有）+ 旧工具，避免 handler 指向死进程或注册重复
  closeMcpConnection(serverName);
  registry.unregisterByPrefix(`mcp__${serverName}__`);

  try {
    const conn = await connectMcp(cfg.command, cfg.args ?? [], cfg.env);
    serverConnections.set(serverName, conn);

    // 外部工具默认 fail-closed → confirm；读类 server 可在 mcp.json 里显式标注
    const toolMode = cfg.mode === 'read' ? 'read' : 'external';
    for (const tool of conn.tools) {
      registry.register({
        name: `mcp__${serverName}__${tool.name}`,
        description: tool.description || `[MCP:${serverName}] ${tool.name}`,
        inputSchema: tool.inputSchema,
        kind: 'mcp',
        mode: toolMode,
        handler: async (input) => conn.callTool(tool.name, input),
      });
    }

    // 资源以只读工具暴露（mcp__<server>__read_resource）：uri 作为参数，
    // 模型按需读取 server 提供的文件/数据（resources/read）。
    if (conn.resources.length > 0) {
      const catalog = conn.resources
        .map((r) => `- ${r.uri}${r.description ? ` — ${r.description}` : ''}`)
        .join('\n');
      registry.register({
        name: `mcp__${serverName}__read_resource`,
        description: `[MCP:${serverName}] Read a resource by URI. Available resources:\n${catalog}`,
        inputSchema: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: 'Resource URI to read' },
          },
          required: ['uri'],
        },
        kind: 'mcp',
        mode: 'read', // 只读：plan 模式放行、免确认
        handler: async (input) => conn.readResource(String(input.uri ?? '')),
      });
    }

    const toolCount =
      conn.tools.length + (conn.resources.length > 0 ? 1 : 0);
    log.info(`mcp connected: ${serverName} (${toolCount} tools)`);
    return { ok: true, toolCount };
  } catch (err) {
    const error = (err as Error).message;
    log.warn(`mcp server failed to connect: ${serverName}`, error);
    return { ok: false, error };
  }
}

/**
 * 重连单个 server（/mcp 面板的 R 键）：重开子进程 → 重新握手 → 重新注册工具。
 * 失败时 registry 里不留该 server 的任何工具（等价"未连接"），
 * 否则会留下指向上一个死进程的 handler，模型调用时得到一个诡异的挂起。
 */
export async function reconnectMcpServer(
  registry: Registry,
  serverName: string,
  cwd = process.cwd(),
): Promise<McpConnectResult> {
  const cfg = resolveMcpConfigs(cwd)[serverName];
  if (!cfg) return { ok: false, error: `未在 mcp.json 中找到 ${serverName}` };
  return connectMcpServer(registry, serverName, cfg);
}

/**
 * 前缀注册：把 mcp.json 里配置的 server 都接上、每个工具注册为 mcp__<server>__<tool>。
 * server 连接失败只记日志，不阻塞其余能力（fail-open 于配置层，fail-closed 于权限层）。
 */
export async function loadMcpServers(registry: Registry, cwd = process.cwd()): Promise<void> {
  const configs = resolveMcpConfigs(cwd);
  // 并行连接：N 个 server 的挂载总耗时 ≈ 最慢者，且单个失败不影响其余与主流程
  await Promise.all(
    Object.entries(configs).map(([serverName, cfg]) => connectMcpServer(registry, serverName, cfg)),
  );
}
