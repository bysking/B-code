import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
} from "undici";
import type { SystemBlock } from "./prompt.js";
import { flattenSystemBlocks } from "./prompt.js";

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
  if (String(args[0]).includes("EnvHttpProxyAgent")) return;
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
}

export interface ModelOutput {
  /** 归一化后的内容块（参数侧类型）：text / tool_use，与 Anthropic 消息协议一致 */
  content: Anthropic.ContentBlockParam[];
}

/** 惰性读取：测试可在调用间切换环境，不依赖导入顺序 */
export function useOpenAI(): boolean {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL);
}

export function defaultModel(): string {
  if (process.env.B_CODE_MODEL) return process.env.B_CODE_MODEL;
  return useOpenAI() ? "gpt-4o-mini" : "claude-sonnet-4-5-20250929";
}

// ── OpenAI 兼容 方向转换（导出供测试；纯函数，不读环境）──────────

export function toOpenAITools(tools: Anthropic.Tool[]): any[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** Anthropic 消息数组 → OpenAI 消息数组（assistant 的 text/tool_use 合并为一条） */
export function toOpenAIMessages(messages: MessageParam[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const texts = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const tu = b as Anthropic.ToolUseBlock;
          return {
            id: tu.id,
            type: "function",
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          };
        });
      out.push({
        role: "assistant",
        content: texts || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    } else {
      // user 消息的块：tool_result
      for (const b of m.content) {
        const tr = b as Anthropic.ToolResultBlockParam;
        if (tr.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: String(tr.content) });
        }
      }
    }
  }
  return out;
}

/** OpenAI 响应 → Anthropic 参数侧形状（tool_calls 到齐后是一次性 JSON） */
export function fromOpenAIResponse(data: any): ModelOutput {
  const msg = data.choices?.[0]?.message;
  const content: Anthropic.ContentBlockParam[] = [];
  if (msg?.content) content.push({ type: "text", text: String(msg.content) });
  for (const tc of msg?.tool_calls ?? []) {
    let input: Record<string, any> = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      // 参数 JSON 损坏时保留空对象，避免循环崩溃
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  return { content };
}

// ── 统一调用入口 ──────────────────────────────────────────────────

/**
 * OpenAI SSE 流的增量解析状态
 * 修复要点：之前用 resp.text() 一次性读完才解析，"流"在读取点就断了——
 * 打字机/流式效果必须在读取的同时逐块回调。这里存中间态，reader 边收边喂。
 */
interface OpenAIStreamCtx {
  content: string;
  toolMap: Map<number, { id: string; name: string; args: string }>;
  onText?: (delta: string) => void;
}

function applyOpenAIDelta(ctx: OpenAIStreamCtx, delta: any): void {
  if (delta.content) {
    ctx.content += delta.content;
    ctx.onText?.(delta.content);
  }
  // OpenAI 的 tool_calls 按 index 分多个 chunk 到达，逐块拼接
  for (const tc of delta.tool_calls ?? []) {
    const idx: number = tc.index ?? 0;
    const entry = ctx.toolMap.get(idx) ?? { id: `call_${idx}`, name: "", args: "" };
    ctx.toolMap.set(idx, entry);
    if (tc.id) entry.id = tc.id;
    if (tc.function?.name) entry.name = tc.function.name; // name 整块到达，覆盖式
    if (tc.function?.arguments) entry.args += tc.function.arguments; // arguments 分片，拼接式
  }
}

function finishOpenAIStream(ctx: OpenAIStreamCtx): ModelOutput {
  const toolCalls = [...ctx.toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  return fromOpenAIResponse({
    choices: [
      {
        message: {
          content: ctx.content || null,
          tool_calls: toolCalls.map((t) => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: t.args },
          })),
        },
      },
    ],
  });
}

/** 逐行喂给 SSE 解析器：多块 TCP 到达时 buffer 残尾，下一段续接 */
function feedSSELine(ctx: OpenAIStreamCtx, line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return;
  let chunk: any;
  try {
    chunk = JSON.parse(data);
  } catch {
    return; // 忽略心跳/非 JSON 行
  }
  const delta = chunk.choices?.[0]?.delta;
  if (delta) applyOpenAIDelta(ctx, delta);
}

/**
 * 真正流式读取：resp.body reader 边收边解析，onText 随数据到达即时触发
 * （不再等整包响应体落地）。这是打次字号效果的地基。
 */
async function streamOpenAISSE(
  resp: Awaited<ReturnType<typeof undiciFetch>>,
  onText?: (delta: string) => void,
): Promise<ModelOutput> {
  const ctx: OpenAIStreamCtx = { content: "", toolMap: new Map(), onText };
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 残尾留待下段
      for (const line of lines) feedSSELine(ctx, line);
    }
  }
  if (buffer.trim()) feedSSELine(ctx, buffer); // 流结束的最后一截

  // 非流式降级服务可能发出普通 JSON 行而非 SSE：data: 前缀缺失 → 空输出。
  // 降级由调用方（content-type 判断）分流，这里不重复处理。
  return finishOpenAIStream(ctx);
}

export async function callModel(input: ModelInput): Promise<ModelOutput> {
  if (useOpenAI()) {
    const systemText = flattenSystemBlocks(input.system);
    const resp = await proxiedFetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "system", content: systemText }, ...toOpenAIMessages(input.messages)],
        tools: toOpenAITools(input.tools),
        stream: true,
      }),
    });
    if (!resp.ok) {
      throw new Error(`OpenAI API ${resp.status}: ${await resp.text()}`);
    }

    // 兼容性：部分 OpenAI 兼容服务即使请求 stream:true 也返回普通 JSON → 非流式降级
    const isSSE = (resp.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!isSSE) {
      return fromOpenAIResponse(JSON.parse(await resp.text()));
    }
    // 真·流式：reader 边收边回调，onText 随数据到达即时触发（打字机的地基）
    return streamOpenAISSE(resp, input.onText);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "[b-code] Missing ANTHROPIC_API_KEY in .env (or set OPENAI_API_KEY + OPENAI_BASE_URL for a compatible backend)",
    );
  }
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    // SDK 走 fetch；注入代理穿透的包装，保持双后端行为一致
    fetch: proxiedFetch as unknown as ClientOptions["fetch"],
  });
  const stream = client.messages.stream({
    model: input.model,
    max_tokens: 4096,
    system: input.system,
    tools: input.tools,
    messages: input.messages,
  });
  if (input.onText) {
    stream.on("text", (text) => input.onText!(text));
  }
  const reply = await stream.finalMessage();
  return { content: reply.content as Anthropic.ContentBlock[] };
}