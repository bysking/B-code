import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
} from "undici";

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
const proxyAgent = new EnvHttpProxyAgent();

// 类型注意：@anthropic-ai/sdk 间接带 undici-types@8 的 Response，与 undici@6 的
// Response 不可互assign，因此用结构类型把自己的返回类型隔离在 undici 一侧。
type ProxiedFetch = (
  input: string | URL,
  init?: Record<string, unknown>,
) => Promise<Awaited<ReturnType<typeof undiciFetch>>>;

const proxiedFetch: ProxiedFetch = (input, init) =>
  undiciFetch(input as never, { ...init, dispatcher: proxyAgent } as never);

/**
 * 模型后端（P1 最小版：P2 会升级为流式 + 策略接口）
 *
 * 核心约定：**b-code 内部统一用 Anthropic 形状的消息/工具**，
 * OpenAI 兼容后端在边界处转换（toOpenAIMessages / fromOpenAIResponse），
 * 这样 Agent 主循环对后端无感知——这正是施工图"内核稳定"的第一步。
 *
 * 后端选择：同时存在 OPENAI_API_KEY + OPENAI_BASE_URL → OpenAI 兼容；
 * 否则 Anthropic SDK。
 */

export interface ModelInput {
  model: string;
  system: string;
  tools: Anthropic.Tool[];
  messages: MessageParam[];
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

export async function callModel(input: ModelInput): Promise<ModelOutput> {
  if (useOpenAI()) {
    const resp = await proxiedFetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: toOpenAIMessages(input.messages),
        tools: toOpenAITools(input.tools),
        stream: false,
      }),
    });
    if (!resp.ok) {
      throw new Error(`OpenAI API ${resp.status}: ${await resp.text()}`);
    }
    return fromOpenAIResponse(await resp.json());
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
  const reply = await client.messages.create({
    model: input.model,
    max_tokens: 4096,
    system: input.system,
    tools: input.tools,
    messages: input.messages,
  });
  return { content: reply.content as Anthropic.ContentBlock[] };
}