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

export interface McpConnection {
  tools: McpToolInfo[];
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): void;
}

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// MCP server 是长驻子进程，若不 kill 会拖住主进程事件循环，导致 chat 完成后进程永不退出。
// 关键：不能挂在 process "exit" 上——正是子进程句柄阻止进程退出，exit 事件根本不会触发。
// 用 beforeExit（事件循环即将空时触发，杀掉子进程后循环才有机会真正变空）＋业务终点显式关闭。
const activeConnections: McpConnection[] = [];
let cleanupInstalled = false;
function installExitCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('beforeExit', closeAllMcpConnections);
}

/** 显式关闭全部已连接 server（业务终点调用：one-shot 结束、REPL 关闭） */
export function closeAllMcpConnections(): void {
  while (activeConnections.length > 0) {
    const conn = activeConnections.pop();
    try {
      conn?.close();
    } catch {
      // 已关闭
    }
  }
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
    stdio: ['pipe', 'pipe', 'inherit'],
    env: env ? { ...process.env, ...env } : process.env,
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
    capabilities: {},
    clientInfo: { name: 'b-code', version: '0.1.0' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const listed = await request('tools/list');
  const tools: McpToolInfo[] = (listed.result?.tools ?? []).map((t: any) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

  const conn: McpConnection = {
    tools,
    async callTool(name, callArgs) {
      const resp = await request('tools/call', { name, arguments: callArgs });
      // MCP 返回 content 块数组；取文本，纯结构化内容 JSON 兜底
      const content = resp.result?.content;
      if (Array.isArray(content)) {
        return content.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
      }
      return JSON.stringify(resp.result);
    },
    close() {
      try {
        proc.stdin.end();
      } catch {
        // 已关闭
      }
      proc.kill();
    },
  };

  activeConnections.push(conn);
  installExitCleanup();
  return conn;
}

/**
 * 前缀注册：把 mcp.json 里配置的 server 都接上、每个工具注册为 mcp__<server>__<tool>。
 * server 连接失败只记日志，不阻塞其余能力（fail-open 于配置层，fail-closed 于权限层）。
 */
export async function loadMcpServers(registry: Registry, cwd = process.cwd()): Promise<void> {
  const configs = resolveMcpConfigs(cwd);
  // 并行连接：N 个 server 的挂载总耗时 ≈ 最慢者，且单个失败不影响其余与主流程
  await Promise.all(
    Object.entries(configs).map(async ([serverName, cfg]) => {
      try {
        const conn = await connectMcp(cfg.command, cfg.args ?? [], cfg.env);
        for (const tool of conn.tools) {
          const prefixed = `mcp__${serverName}__${tool.name}`;
          registry.register({
            name: prefixed,
            description: tool.description || `[MCP:${serverName}] ${tool.name}`,
            inputSchema: tool.inputSchema,
            kind: 'mcp',
            // 外部工具默认 fail-closed → confirm；读类 server 可在 mcp.json 里显式标注
            mode: cfg.mode === 'read' ? 'read' : 'external',
            handler: async (input) => conn.callTool(tool.name, input),
          });
        }
        log.info(`mcp connected: ${serverName} (${conn.tools.length} tools)`);
      } catch (err) {
        log.warn(`mcp server failed to connect: ${serverName}`, (err as Error).message);
      }
    }),
  );
}
