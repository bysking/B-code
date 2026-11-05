import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Registry } from './registry.js';
import { resolveMcpConfigs, transportKind, type McpServerConfig } from './mcp-config.js';
import { log } from './utils/log.js';

/**
 * MCP 客户端 + mcp-loader（官方 SDK 版）
 *
 * 传输：stdlib 子进程（stdio）或远程端点（Streamable HTTP）。
 * 协议细节（JSON-RPC 编解码、版本协商、错误码、重连、session 管理）全部交给
 * `@modelcontextprotocol/sdk`——手写那版只覆盖了 5 个方法，缺 HTTP 传输、
 * 资源订阅、动态工具通知、sampling/roots/elicitation 等反向调用。
 *
 * 对 Agent 循环而言，MCP 工具与内置工具没有区别：都是 name + schema + handler，
 * 统一挂进 Registry（名字前缀 mcp__<server>__<tool>）。
 *
 * 打包体积：SDK 有 exports 分路径 + sideEffects:None，只 import client/stdio 时
 * esbuild 会把 express/hono/auth 那套全部 tree-shake 掉（实测 280KB → 加 HTTP 也只 316KB）。
 */

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** server 声明的只读提示（MCP annotations.readOnlyHint） */
  readOnly?: boolean;
  /** server 声明的破坏性提示（destructiveHint） */
  destructive?: boolean;
}

/** MCP 资源（resources/list）：以只读工具形态暴露给模型 */
export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** 反向调用（server → client）的宿主能力注入点。
 *
 * MCP 规范允许 server 请求**客户端**代为完成它自己做不到的事：
 *   - sampling   让宿主用自家模型跑一次补全（server 没有 LLM 凭证）
 *   - roots      查宿主的"工作区根目录"（server 不知道用户在哪个项目里）
 *   - elicitation 向用户提问（server 没有 UI）
 *
 * 这些都是可选能力：不注入就相当于"声明不支持"，server 会自行降级。
 */
export interface McpHostCapabilities {
  /** 代跑一次模型补全；返回文本。未注入 = 不支持 sampling。 */
  sample?: (req: {
    messages: { role: 'user' | 'assistant'; content: unknown }[];
    maxTokens: number;
    systemPrompt?: string;
  }) => Promise<string>;
  /** 列出工作区根目录；返回 uri 列表（file:// 形式）。未注入 = 不支持 roots。 */
  roots?: () => { uri: string; name?: string }[];
  /** 向用户提问并等待回答；返回表单值。未注入 = 不支持 elicitation。 */
  elicit?: (req: {
    message: string;
    requestedSchema: Record<string, unknown>;
  }) => Promise<Record<string, unknown> | null>;
}

export interface McpConnection {
  /** 连接/重连时的工具快照（server 动态增删后由 onToolsChanged 更新） */
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  readResource(uri: string): Promise<string>;
  /** 订阅某资源的变更（subscription 能力）；不支持则返回 false */
  subscribeResource(uri: string): Promise<boolean>;
  /** 底层进程 pid（stdio 传输才有；HTTP 返回 undefined） */
  pid(): number | undefined;
  close(): void;
}

/** 单次请求超时（防 server 不回包时挂死） */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// MCP server 是长驻子进程，若不主动关闭会拖住主进程事件循环，导致 chat 完成后进程永不退出。
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

/** 把 SDK 的 content 块数组拍平成文本（与旧实现行为一致：模型只看到文本） */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((c: any) => {
      if (!c || typeof c !== 'object') return String(c);
      switch (c.type) {
        case 'text':
          return String(c.text ?? '');
        case 'image':
          // 图片块不把 base64 塞进上下文（会撑爆 token）——给出可辨识的占位
          return `[image ${c.mimeType ?? 'unknown'}${c.data ? `, ${Math.round(String(c.data).length / 1024)}KB` : ''}]`;
        case 'resource':
          return typeof c.resource?.text === 'string'
            ? c.resource.text
            : JSON.stringify(c.resource ?? c);
        default:
          return JSON.stringify(c);
      }
    })
    .join('\n');
}

/** 把 resources/read 的 contents 拍平成文本 */
function flattenResourceContents(contents: unknown): string {
  if (!Array.isArray(contents)) return JSON.stringify(contents);
  return contents
    .map((c: any) => {
      if (typeof c?.text === 'string') return c.text;
      if (typeof c?.blob === 'string') {
        return `[binary resource ${c.mimeType ?? 'unknown'}, ${Math.round(c.blob.length / 1024)}KB base64]`;
      }
      return JSON.stringify(c);
    })
    .join('\n');
}

/** 由配置造 SDK 传输（stdio 或 HTTP） */
function createTransport(cfg: McpServerConfig): Transport {
  const kind = transportKind(cfg);

  if (kind === 'stdio') {
    return new StdioClientTransport({
      command: cfg.command!,
      args: cfg.args ?? [],
      ...(cfg.env ? { env: { ...process.env, ...cfg.env } as Record<string, string> } : {}),
      // stderr 必须 pipe 而不是 inherit（SDK 默认继承，会把子进程输出直接打进我们的 TUI）。
      // TTY 下终端已被 ink 接管，子进程随便吐一行就能打乱画面；重连时被杀进程
      // 残留的未刷出字节还会在屏幕上留下 `^[[A^[[B` 这类乱码。
      stderr: 'pipe',
    });
  }

  if (kind === 'http') {
    return new StreamableHTTPClientTransport(new URL(cfg.url!), {
      ...(cfg.headers
        ? { requestInit: { headers: cfg.headers } }
        : {}),
    });
  }

  throw new Error(`MCP server 配置缺少 command 或 url`);
}

/** 从 SDK 的 tool 描述里取只读/破坏性提示（MCP annotations） */
function toolHints(tool: any): { readOnly?: boolean; destructive?: boolean } {
  const a = tool?.annotations;
  if (!a || typeof a !== 'object') return {};
  return {
    ...(typeof a.readOnlyHint === 'boolean' ? { readOnly: a.readOnlyHint } : {}),
    ...(typeof a.destructiveHint === 'boolean' ? { destructive: a.destructiveHint } : {}),
  };
}

export interface ConnectMcpOptions {
  /** 单次 JSON-RPC 请求超时（防 server 没回包时挂死）；默认 30s */
  requestTimeoutMs?: number;
  /**
   * server 动态增删工具时回调（notifications/tools/list_changed）。
   * 传了才会注册通知处理器——不传等于不关心，省一次重新拉取。
   */
  onToolsChanged?: (tools: McpToolInfo[]) => void;
  /** 资源内容变更回调（notifications/resources/updated，需先 subscribeResource） */
  onResourceUpdated?: (uri: string) => void;
  /** 宿主侧能力（反向调用）；不传则声明为不支持 */
  host?: McpHostCapabilities;
}

/**
 * 连接一个 MCP server（stdio 或 HTTP），返回统一的能力快照。
 *
 * 失败一律抛错，由调用方（connectMcpServer）决定记日志还是提示用户——
 * 这里不做 fail-open，因为调用方需要区分"连上了几个工具"与"为什么连不上"。
 */
export async function connectMcp(
  cfg: McpServerConfig,
  opts: ConnectMcpOptions = {},
): Promise<McpConnection> {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const transport = createTransport(cfg);

  // 按注入的宿主能力声明 client capabilities。
  // 关键：**不注入就不声明**——server 会据此判断"这个客户端做不到"，自行降级，
  // 而不是发一个永远没人处理的请求然后超时。
  const capabilities: Record<string, unknown> = {};
  if (opts.host?.sample) capabilities.sampling = {};
  if (opts.host?.roots) capabilities.roots = { listChanged: true };
  if (opts.host?.elicit) capabilities.elicitation = {};

  const client = new Client(
    { name: 'b-code', version: '1.0.0' },
    { capabilities },
  );

  // stdio 传输的 stderr 转进日志系统（不写终端）。HTTP 传输没有这一步。
  if (transport instanceof StdioClientTransport) {
    const stderrStream = (transport as unknown as { stderr?: NodeJS.ReadableStream }).stderr;
    if (stderrStream) {
      stderrStream.setEncoding?.('utf8');
      stderrStream.on('data', (chunk: string) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim()) log.info(`[mcp] ${line.trim()}`);
        }
      });
    }
  }

  await client.connect(transport);

  const requestOpts = { timeout: timeoutMs };

  // ── 反向调用（server → client）──────────────────────────────
  // 每个处理器只在对应能力被声明时才注册（否则规范上不该收到该请求）。
  if (opts.host?.sample) {
    const host = opts.host;
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
      const text = await host.sample!({
        messages: (req.params.messages ?? []) as any,
        maxTokens: req.params.maxTokens ?? 1024,
        ...(req.params.systemPrompt ? { systemPrompt: req.params.systemPrompt } : {}),
      });
      return { role: 'assistant', content: { type: 'text', text }, model: 'b-code' };
    });
  }
  if (opts.host?.roots) {
    const host = opts.host;
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: host.roots!().map((r) => ({ uri: r.uri, ...(r.name ? { name: r.name } : {}) })),
    }));
  }
  if (opts.host?.elicit) {
    const host = opts.host;
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const result = await host.elicit!({
        message: String((req.params as any).message ?? ''),
        requestedSchema: ((req.params as any).requestedSchema ?? {}) as Record<string, unknown>,
      });
      // null = 用户取消；规范要求返回 action:'decline'
      return result ? { action: 'accept', content: result } : { action: 'decline' };
    });
  }

  // ── 通知：server 动态增删工具 ───────────────────────────────
  // 拉取失败不清空旧列表（宁可暂时用旧的，也不要让工具凭空消失）。
  if (opts.onToolsChanged) {
    const notifyTools = opts.onToolsChanged;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        const fresh = await client.listTools(undefined, requestOpts);
        notifyTools(
          (fresh.tools ?? []).map((t: any) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
            ...toolHints(t),
          })),
        );
      } catch (err) {
        log.warn(`mcp tools/list_changed 刷新失败`, (err as Error).message);
      }
    });
  }

  // ── 通知：资源内容变更（需先 subscribeResource）──────────────
  if (opts.onResourceUpdated) {
    const notifyResource = opts.onResourceUpdated;
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
      notifyResource(String((n.params as any)?.uri ?? ''));
    });
  }

  const listed = await client.listTools(undefined, requestOpts);
  const tools: McpToolInfo[] = (listed.tools ?? []).map((t: any) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    ...toolHints(t),
  }));

  // resources/list 是可选能力：server 未声明/报错时优雅降级为空（不阻断 tools）
  let resources: McpResourceInfo[] = [];
  try {
    const res = await client.listResources(undefined, requestOpts);
    resources = (res.resources ?? [])
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
      const resp = await client.callTool({ name, arguments: callArgs }, undefined, requestOpts);
      // 工具执行失败时 SDK 会带回 isError，明确告诉模型（否则它会以为成功而继续瞎猜）
      const text = flattenContent(resp.content);
      return resp.isError ? `[tool error] ${text}` : text;
    },
    async readResource(uri) {
      const resp = await client.readResource({ uri }, requestOpts);
      return flattenResourceContents(resp.contents);
    },
    async subscribeResource(uri) {
      // 订阅是可选能力：server 未声明 resources.subscribe 时直接跳过（不报错）
      if (!client.getServerCapabilities()?.resources?.subscribe) return false;
      try {
        await client.subscribeResource({ uri }, requestOpts);
        return true;
      } catch (err) {
        log.warn(`mcp resource subscribe 失败: ${uri}`, (err as Error).message);
        return false;
      }
    },
    pid() {
      return transport instanceof StdioClientTransport ? transport.pid ?? undefined : undefined;
    },
    close() {
      // client.close() 会连带关掉 transport（含杀子进程）
      void client.close().catch(() => {
        // 已关闭/已断开
      });
    },
  };

  installExitCleanup();
  return conn;
}

/** 单 server 连接结果（连接失败不抛，交由调用方决定提示方式） */
export interface McpConnectResult {
  ok: boolean;
  /** 启动的进程 pid（重连后变化，便于用户确认真的换了进程）；HTTP 无 pid */
  pid?: number;
  /** 注册的工具数（含 read_resource） */
  toolCount?: number;
  error?: string;
}

/** server 的注册名前缀（统一口径，避免各处手拼字符串漏掉尾随下划线） */
function prefixOf(serverName: string): string {
  return `mcp__${serverName}__`;
}

/**
 * 把一批工具注册进 registry（首连与"动态变更"共用）。
 *
 * 权限模式三级判定（优先级从高到低）：
 *   1. server 级 `mode: 'read'` —— 用户显式声明信任整个 server
 *   2. 工具自带 `annotations.readOnlyHint` —— MCP 规范的语义标注，可信
 *   3. 其余 → `external`（fail-closed，确认框 / auto 分类器都拦）
 */
function registerTools(
  registry: Registry,
  serverName: string,
  cfg: McpServerConfig,
  conn: McpConnection,
  tools: McpToolInfo[],
): void {
  for (const tool of tools) {
    const mode = cfg.mode === 'read' || tool.readOnly ? 'read' : ('external' as const);
    registry.register({
      name: `${prefixOf(serverName)}${tool.name}`,
      description:
        (tool.description || `[MCP:${serverName}] ${tool.name}`) +
        (tool.destructive ? ' ⚠️ destructive' : ''),
      inputSchema: tool.inputSchema,
      kind: 'mcp',
      mode,
      handler: async (input) => conn.callTool(tool.name, input),
    });
  }
}

/**
 * 资源聚合为单个只读工具 `mcp__<server>__read_resource`（参数 uri）。
 * server 不提供资源时跳过——不影响工具发现。
 */
function registerResourceTool(
  registry: Registry,
  serverName: string,
  conn: McpConnection,
): void {
  if (conn.resources.length === 0) return;
  const catalog = conn.resources
    .map((r) => `- ${r.uri}${r.description ? ` — ${r.description}` : ''}`)
    .join('\n');
  registry.register({
    name: `${prefixOf(serverName)}read_resource`,
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

/**
 * 连接单个 server 并把它的工具注册进 registry。
 *
 * 重连复用同一函数：先摘旧工具、关旧连接，再走一遍完整握手。这样"首次连接"和
 * "重连"共享一条代码路径，不会出现两套注册逻辑各写一半的情况。
 */
export async function connectMcpServer(
  registry: Registry,
  serverName: string,
  cfg: McpServerConfig,
  host?: McpHostCapabilities,
): Promise<McpConnectResult> {
  // 先清理：旧连接（若有）+ 旧工具，避免 handler 指向死连接或注册重复
  closeMcpConnection(serverName);
  registry.unregisterByPrefix(prefixOf(serverName));

  try {
    // 动态工具变更：server 主动增删工具时无需用户手动 R 重连。
    // 回调里复用同一套注册逻辑（只重注册工具，资源工具保持不变）。
    let conn: McpConnection;
    conn = await connectMcp(cfg, {
      ...(host ? { host } : {}),
      onToolsChanged: (tools) => {
        conn.tools = tools;
        registry.unregisterByPrefix(prefixOf(serverName));
        registerTools(registry, serverName, cfg, conn, tools);
        log.info(`mcp tools changed: ${serverName} (${tools.length} tools)`);
      },
    });
    serverConnections.set(serverName, conn);

    registerTools(registry, serverName, cfg, conn, conn.tools);
    registerResourceTool(registry, serverName, conn);

    const toolCount = conn.tools.length + (conn.resources.length > 0 ? 1 : 0);
    log.info(`mcp connected: ${serverName} (${toolCount} tools)`);
    return { ok: true, toolCount, ...(conn.pid() ? { pid: conn.pid() } : {}) };
  } catch (err) {
    const error = (err as Error).message;
    log.warn(`mcp server failed to connect: ${serverName}`, error);
    return { ok: false, error };
  }
}

/**
 * 重连单个 server（/mcp 面板的 R 键）：重新建立传输 → 重新握手 → 重新注册工具。
 * 失败时 registry 里不留该 server 的任何工具（等价"未连接"），
 * 否则会留下指向上一个死连接的 handler，模型调用时得到一个诡异的挂起。
 */
export async function reconnectMcpServer(
  registry: Registry,
  serverName: string,
  cwd = process.cwd(),
  host?: McpHostCapabilities,
): Promise<McpConnectResult> {
  const cfg = resolveMcpConfigs(cwd)[serverName];
  if (!cfg) return { ok: false, error: `未在 mcp.json 中找到 ${serverName}` };
  return connectMcpServer(registry, serverName, cfg, host);
}

/**
 * 前缀注册：把 mcp.json 里配置的 server 都接上、每个工具注册为 mcp__<server>__<tool>。
 * server 连接失败只记日志，不阻塞其余能力（fail-open 于配置层，fail-closed 于权限层）。
 */
export async function loadMcpServers(
  registry: Registry,
  cwd = process.cwd(),
  host?: McpHostCapabilities,
): Promise<void> {
  const configs = resolveMcpConfigs(cwd);
  // 并行连接：N 个 server 的挂载总耗时 ≈ 最慢者，且单个失败不影响其余与主流程
  await Promise.all(
    Object.entries(configs).map(([serverName, cfg]) =>
      connectMcpServer(registry, serverName, cfg, host),
    ),
  );
}
