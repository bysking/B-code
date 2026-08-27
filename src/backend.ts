import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import type { SystemBlock } from './prompt.js';
import { flattenSystemBlocks } from './prompt.js';

/**
 * 网络层：自包含的 undici v6（与 Node 22 内置同源）。
 *
 * 为什么不用 Node 全局 fetch：1) Node 22 的全局 fetch 不读 HTTP(S)_PROXY，
 * 挂外部 undici v8 的 dispatcher 又会因内部协议版本不匹配而报
 * "invalid onRequestStart method"。所以两端都用本包自己的 fetch + 自己的
 * EnvHttpProxyAgent，版本自洽。
 *
 * EnvHttpProxyAgent 自动生效 HTTP_PROXY / HTTPS_PROXY / NO_PROXY（含小写变体）；
 * 未设置代理时直连，无副作用。否则代理环境下表现为神秘 401/超时。
 */
// undici 每次构造 EnvHttpProxyAgent 都会 emit 一条"experimental"警告，
// 污染 stderr 与测试输出；在构造瞬间临时压制该条特定警告。
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((...args: Parameters<typeof process.emitWarning>) => {
  if (String(args[0]).includes('EnvHttpProxyAgent')) return;
  originalEmitWarning(...args);
}) as typeof process.emitWarning;
const proxyAgent = new EnvHttpProxyAgent();
process.emitWarning = originalEmitWarning;

// 类型注意：@anthropic-ai/sdk 间接带 undici-types@8 的 Response，与 undici@6 的
// Response 不可互assign，因此用结构类型把自己的返回类型隔离在 undici 一侧。
type ProxiedFetch = (
  input: string | URL,
  init?: Record<string, unknown>,
) => Promise<Awaited<ReturnType<typeof undiciFetch>>>;

const proxiedFetch: ProxiedFetch = (input, init) =>
  undiciFetch(input as never, { ...init, dispatcher: proxyAgent } as never);

/**
 * 模型后端（P2：流式 + 双后端）
 *
 * 核心约定：**b-code 内部统一用 Anthropic 形状的消息/工具/system blocks**，
 * OpenAI 兼容后端在边界处转换（toOpenAIMessages / fromOpenAIResponse），
 * 这样 Agent 主循环对后端无感知——这正是施工图"内核稳定"的第一步。
 *
 * 流式：两后端都走增量，文本 delta 通过 onText 实时回调（UI 逐字打印）；
 * 返回仍归一化为完整 content（tool_use 提取/历史记录不受影响）。
 *
 * 后端选择：同时存在 OPENAI_API_KEY + OPENAI_BASE_URL → OpenAI 兼容；
 * 否则 Anthropic SDK。
 */

export interface ModelInput {
  model: string;
  system: SystemBlock[];
  tools: Anthropic.Tool[];
  messages: MessageParam[];
  /** 流式文本增量回调（UI 层逐字打印）；非流式调用方可不传 */
  onText?: (delta: string) => void;
  /** 思考块增量回调（extended thinking）；供应商不回 thinking 时不触发 */
  onThinking?: (delta: string) => void;
  /** 硬中断：用户取消时 abort——在飞请求/流式读取立即终止（抛 AbortError） */
  signal?: AbortSignal;
}

export interface ModelOutput {
  /** 归一化后的内容块（参数侧类型）：text / tool_use，与 Anthropic 消息协议一致 */
  content: Anthropic.ContentBlockParam[];
  /** 归一化 token 用量（input=提示词、output=生成）；后端未返回时缺省（优雅降级） */
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * 粗略 token 估算（执行期实时展示用，非计费精确值）：
 * CJK 汉字/全角/假名/谚文 ≈ 1 token，其余字符 ≈ len/4。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
      (code >= 0x3000 && code <= 0x303f) || // 全角标点
      (code >= 0xff00 && code <= 0xffef) || // 全角/半角形式
      (code >= 0x3040 && code <= 0x30ff) || // 假名
      (code >= 0xac00 && code <= 0xd7af); // 谚文
    if (isCjk) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 模型后端策略（P7 固化）：新增一个 Provider = 实现这个接口 + createBackend 注册选择。
 * 内核（Agent 循环）只依赖该接口，不关心实现——"策略可替换"原则的最小落地。
 */
export interface ModelBackend {
  readonly kind: string;
  call(input: ModelInput): Promise<ModelOutput>;
}

/** 惰性读取：测试可在调用间切换环境，不依赖导入顺序 */
export function useOpenAI(): boolean {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL);
}

export function defaultModel(): string {
  if (process.env.B_CODE_MODEL) return process.env.B_CODE_MODEL;
  return useOpenAI() ? 'gpt-4o-mini' : 'claude-sonnet-4-5-20250929';
}

// ── OpenAI 兼容 方向转换（导出供测试；纯函数，不读环境）──────────

export function toOpenAITools(tools: Anthropic.Tool[]): any[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** Anthropic 消息数组 → OpenAI 消息数组（assistant 的 text/tool_use 合并为一条） */
export function toOpenAIMessages(messages: MessageParam[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const texts = m.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const tu = b as Anthropic.ToolUseBlock;
          return {
            id: tu.id,
            type: 'function',
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          };
        });
      out.push({
        role: 'assistant',
        content: texts || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    } else {
      // user 消息：遍历所有块（text / image / tool_result）
      const contentParts: any[] = [];
      const toolResults: any[] = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const tr = b as Anthropic.ToolResultBlockParam;
          toolResults.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: String(tr.content) });
        } else if (b.type === 'image') {
          // Anthropic ImageBlockParam → OpenAI image_url content part
          const img = b as {
            type: 'image';
            source: { type: string; media_type?: string; data?: string; url?: string };
          };
          const src = img.source;
          if (src.type === 'base64' && src.data && src.media_type) {
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${src.media_type};base64,${src.data}` },
            });
          } else if (src.type === 'url' && src.url) {
            contentParts.push({ type: 'image_url', image_url: { url: src.url } });
          }
        } else if (b.type === 'text') {
          contentParts.push(b);
        }
      }
      // 先推 content 块（text + image 在同一 user 消息中），再推 tool_result
      if (contentParts.length > 0) out.push({ role: 'user', content: contentParts });
      out.push(...toolResults);
    }
  }
  return out;
}

/** OpenAI 响应 → Anthropic 参数侧形状（tool_calls 到齐后是一次性 JSON） */
export function fromOpenAIResponse(data: any): ModelOutput {
  const msg = data.choices?.[0]?.message;
  const content: Anthropic.ContentBlockParam[] = [];
  if (msg?.content) content.push({ type: 'text', text: String(msg.content) });
  for (const tc of msg?.tool_calls ?? []) {
    let input: Record<string, any> = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      // 参数 JSON 损坏时保留空对象，避免循环崩溃
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return { content, usage: usageFromOpenAI(data) };
}

/** OpenAI usage(prompt_tokens/completion_tokens)→ 归一化 input/output;字段缺失返回 undefined */
export function usageFromOpenAI(data: any): { input_tokens: number; output_tokens: number } | undefined {
  const u = data?.usage;
  if (!u) return undefined;
  const input_tokens = u.prompt_tokens ?? u.input_tokens;
  const output_tokens = u.completion_tokens ?? u.output_tokens;
  if (typeof input_tokens !== 'number' || typeof output_tokens !== 'number') return undefined;
  return { input_tokens, output_tokens };
}

// ── 前缀缓存断点（Anthropic 0.1× 计费的关键）──────────────────────

/**
 * 给 tools 数组最后一个元素打 cache_control 断点：Anthropic 将整个工具定义
 * 前缀加入缓存，多轮对话里每轮 tools 都相同 → 第二轮起按 0.1× 计费。
 * 已带断点（如测试注入）则原样返回，不重复打。
 */
export function withToolCacheBreakpoint(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1]!;
  if ((last as { cache_control?: unknown }).cache_control) return tools;
  return [...tools.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } }];
}

/**
 * 给最后一条消息打缓存断点：缓存覆盖到最新消息之前的全部历史（每轮多打一次）。
 * 仅当最后一条是纯文本 user 消息——tool_result 消息不动（其 text 块加断点会
 * 改变块数组结构，且 tool_result 不参与工具前缀缓存语义）。
 */
export function withMessageCacheBreakpoint(messages: MessageParam[]): MessageParam[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1]!;
  if (typeof last.content !== 'string') return messages;
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }],
    },
  ];
}

// ── 统一调用入口 ──────────────────────────────────────────────────

/** OpenAI 兼容后端请求参数：重试次数 / 退避基数 / 流式空闲超时 */
export const OPENAI_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 800;

/** 流式空闲超时（ms）：超过该时长没有新 chunk 就 abort——防 API 半挂时会话永久挂死 */
export const IDLE_TIMEOUT_MS = (() => {
  const n = Number(process.env.B_CODE_HTTP_TIMEOUT ?? '120000');
  return Number.isFinite(n) && n > 0 ? n : 120_000;
})();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 幂等重试：5xx/429 与网络错误指数退避重试，4xx 客户端错误直接原样返回。
 * signal 已 abort → 立即抛 AbortError；退避等待期间也响应取消。 */
async function fetchWithRetry(
  url: string,
  init: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof proxiedFetch>>> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    try {
      const resp = await proxiedFetch(url, { ...init, ...(signal ? { signal } : {}) });
      const retryable = resp.status >= 500 || resp.status === 429;
      if (resp.ok || !retryable || attempt >= OPENAI_MAX_RETRIES) return resp;
      await resp.body?.cancel(); // 释放连接以便重试
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
      if (attempt >= OPENAI_MAX_RETRIES) throw err;
    }
    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, signal); // 800ms → 1600ms 指数退避
  }
}

/**
 * OpenAI SSE 流的增量解析状态
 * 修复要点：之前用 resp.text() 一次性读完才解析，"流"在读取点就断了——
 * 打字机/流式效果必须在读取的同时逐块回调。这里存中间态，reader 边收边喂。
 */
interface OpenAIStreamCtx {
  content: string;
  toolMap: Map<number, { id: string; name: string; args: string }>;
  onText?: (delta: string) => void;
  /** 流式末尾的 usage chunk(include_usage 开启时);原始 OpenAI 形状，finish 时归一化 */
  usage?: any;
}

function applyOpenAIDelta(ctx: OpenAIStreamCtx, delta: any): void {
  if (delta.content) {
    ctx.content += delta.content;
    ctx.onText?.(delta.content);
  }
  // OpenAI 的 tool_calls 按 index 分多个 chunk 到达，逐块拼接
  for (const tc of delta.tool_calls ?? []) {
    const idx: number = tc.index ?? 0;
    const entry = ctx.toolMap.get(idx) ?? { id: `call_${idx}`, name: '', args: '' };
    ctx.toolMap.set(idx, entry);
    if (tc.id) entry.id = tc.id;
    if (tc.function?.name) entry.name = tc.function.name; // name 整块到达，覆盖式
    if (tc.function?.arguments) entry.args += tc.function.arguments; // arguments 分片，拼接式
  }
}

function finishOpenAIStream(ctx: OpenAIStreamCtx): ModelOutput {
  const toolCalls = [...ctx.toolMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return fromOpenAIResponse({
    choices: [
      {
        message: {
          content: ctx.content || null,
          tool_calls: toolCalls.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: t.args },
          })),
        },
      },
    ],
    // 流式末尾 usage chunk(stream_options.include_usage)可能独立于 choices 到达
    usage: ctx.usage,
  });
}

/** 逐行喂给 SSE 解析器：多块 TCP 到达时 buffer 残尾，下一段续接 */
function feedSSELine(ctx: OpenAIStreamCtx, line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return;
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return;
  let chunk: any;
  try {
    chunk = JSON.parse(data);
  } catch {
    return; // 忽略心跳/非 JSON 行
  }
  const delta = chunk.choices?.[0]?.delta;
  if (delta) applyOpenAIDelta(ctx, delta);
  // usage chunk：OpenAI 流式在流末尾发一个 choices 为空的块携带 usage（include_usage 开启时）
  if (chunk.usage) ctx.usage = chunk.usage;
}

/**
 * 真正流式读取：resp.body reader 边收边解析，onText 随数据到达即时触发
 * （不再等整包响应体落地）。这是打次字号效果的地基。
 * 空闲超时：> IDLE_TIMEOUT_MS 无新 chunk → abort（防 API 半挂时永久挂死）。
 */
async function streamOpenAISSE(
  resp: Awaited<ReturnType<typeof undiciFetch>>,
  onText?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<ModelOutput> {
  const ctx: OpenAIStreamCtx = { content: '', toolMap: new Map(), onText };
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let idleTimer: NodeJS.Timeout | null = null;
  let timedOut = false;
  let aborted = false;

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {}); // 触发 read() 返回，下方抛错
    }, IDLE_TIMEOUT_MS);
  };

  // 硬中断：用户 abort → 取消 reader，read() 立即返回，下方抛 AbortError
  const onAbort = () => {
    aborted = true;
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) throw signal.reason ?? new Error('Aborted');
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    armIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (aborted) throw signal?.reason ?? new Error('Aborted');
      if (timedOut) throw new Error(`stream idle timeout after ${IDLE_TIMEOUT_MS}ms`);
      if (done) break;
      armIdle(); // 有数据到达 → 重置空闲计时
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // 残尾留待下段
        for (const line of lines) feedSSELine(ctx, line);
      }
    }
    if (buffer.trim()) feedSSELine(ctx, buffer); // 流结束的最后一截
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
  }

  // 非流式降级服务可能发出普通 JSON 行而非 SSE：data: 前缀缺失 → 空输出。
  // 降级由调用方（content-type 判断）分流，这里不重复处理。
  return finishOpenAIStream(ctx);
}

/** OpenAI 兼容后端：SSE 流式 + 边界转换，零 SDK 依赖（fetch 直连） */
export class OpenAIBackend implements ModelBackend {
  readonly kind = 'openai-compatible';

  async call(input: ModelInput): Promise<ModelOutput> {
    const systemText = flattenSystemBlocks(input.system);
    const resp = await fetchWithRetry(
      `${process.env.OPENAI_BASE_URL}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: 'system', content: systemText }, ...toOpenAIMessages(input.messages)],
          tools: toOpenAITools(input.tools),
          stream: true,
          // 流式末尾回传 usage 块（不支持的兼容服务会忽略该字段，优雅降级）
          stream_options: { include_usage: true },
        }),
      },
      input.signal,
    );
    if (!resp.ok) {
      throw new Error(`OpenAI API ${resp.status}: ${await resp.text()}`);
    }

    // 兼容性：部分 OpenAI 兼容服务即使请求 stream:true 也返回普通 JSON → 非流式降级
    const isSSE = (resp.headers.get('content-type') ?? '').includes('text/event-stream');
    if (!isSSE) {
      return fromOpenAIResponse(JSON.parse(await resp.text()));
    }
    // 真·流式：reader 边收边回调，onText 随数据到达即时触发
    return streamOpenAISSE(resp, input.onText, input.signal);
  }
}

/** Anthropic 原生后端：官方 SDK 流式（ANTHROPIC_BASE_URL 可自定义端点） */
export class AnthropicBackend implements ModelBackend {
  readonly kind = 'anthropic';
  private client = (() => {
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    return new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      // SDK 走 fetch；注入代理穿透的包装，保持双后端行为一致
      fetch: proxiedFetch as unknown as ClientOptions['fetch'],
      ...(baseURL ? { baseURL } : {}),
    });
  })();

  async call(input: ModelInput): Promise<ModelOutput> {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        '[b-code] Missing ANTHROPIC_API_KEY in .env (or set OPENAI_API_KEY + OPENAI_BASE_URL for a compatible backend)',
      );
    }
    // B_CODE_THINKING 设为正整数时开启 extended thinking（预算 token 数）。
    // 默认不启用，避免 token 成本/行为突变；供应商本身回 thinking 时纯管道也能显示。
    const thinkingBudget = Number(process.env.B_CODE_THINKING ?? '');
    // B_CODE_MAX_TOKENS：输出上限可配（默认 4096；无效值回退默认）
    const maxTokens = Number(process.env.B_CODE_MAX_TOKENS ?? '4096');
    const stream = this.client.messages.stream(
      {
        model: input.model,
        max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
        system: input.system,
        // 前缀缓存断点：tools 尾部 + 最后一条消息（0.1× 缓存命中计费的关键）
        tools: withToolCacheBreakpoint(input.tools),
        messages: withMessageCacheBreakpoint(input.messages),
        ...(Number.isFinite(thinkingBudget) && thinkingBudget > 0
          ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }
          : {}),
      },
      // 硬中断：用户取消时透传 AbortSignal，SDK 中止在飞请求与流式读取
      input.signal ? { signal: input.signal } : undefined,
    );
    if (input.onText) {
      stream.on('text', (text) => input.onText!(text));
    }
    if (input.onThinking) {
      // SDK MessageStream 对 thinking_delta 事件 emit 这个签名：(delta, snapshot)
      stream.on('thinking', (delta) => input.onThinking!(delta));
    }
    const reply = await stream.finalMessage();
    return {
      content: reply.content as Anthropic.ContentBlock[],
      usage: reply.usage
        ? { input_tokens: reply.usage.input_tokens, output_tokens: reply.usage.output_tokens }
        : undefined,
    };
  }
}

/** 后端工厂：env 决定用哪个实现（新增 Provider 在这里加分支） */
export function createBackend(): ModelBackend {
  return useOpenAI() ? new OpenAIBackend() : new AnthropicBackend();
}

/**
 * 默认后端入口（向后兼容的薄壳：策略可替换的最小体现）。
 * Agent 默认用它；测试/高级用法可注入任意 ModelInput → ModelOutput 函数。
 */
export const callModel = (input: ModelInput): Promise<ModelOutput> => createBackend().call(input);
