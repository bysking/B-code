import type { ModelInput, ModelOutput } from "./backend.js";

/**
 * 自治三件套（施工图 §13）：
 *   evaluateGoal    —— 决定"要不要继续"（独立评估器，只判断不干活、不给工具）
 *   classifyAction  —— 决定"能不能放行"（独立分类器，只看脱敏记录）
 *
 * 公共：call = (input) => ModelOutput，由调用方注入（复用主后端，测试注入假实现）。
 */

export interface GoalVerdict {
  met: boolean;
  /** 未达成原因（会被回灌给主模型） */
  reason: string;
  /** NOT_MET impossible：条件不可能满足（防死循环刹车） */
  impossible: boolean;
}

const GOAL_SYSTEM =
  "You are a goal evaluator. Given a condition and a transcript, " +
  "reply exactly 'MET' if the condition is satisfied, " +
  "'NOT_MET: <short reason>' if not, " +
  "or 'NOT_MET impossible: <reason>' if it can never be satisfied.";

export async function evaluateGoal(
  condition: string,
  transcript: string,
  model: string,
  call: (input: ModelInput) => Promise<ModelOutput>,
): Promise<GoalVerdict> {
  const out = await call({
    model,
    system: [{ type: "text", text: GOAL_SYSTEM }],
    tools: [],
    messages: [{ role: "user", content: `Condition: ${condition}\n\nTranscript so far:\n${transcript}` }],
  });
  const text = extractText(out).trim();
  if (text === "MET" || text.startsWith("MET")) return { met: true, reason: "", impossible: false };
  const impossible = text.startsWith("NOT_MET impossible");
  const reason = text
    .replace(/^NOT_MET impossible:?\s*/i, "")
    .replace(/^NOT_MET:?\s*/i, "");
  return { met: false, reason, impossible };
}

const CLASSIFIER_SYSTEM =
  "You are an action classifier. Given a tool call and the conversation transcript, " +
  "reply 'ALLOW' if the action is safe, or 'BLOCK: <reason>' if it looks dangerous.";

export interface ActionVerdict {
  allow: boolean;
  reason: string;
}

export async function classifyAction(
  name: string,
  input: Record<string, unknown>,
  transcript: string,
  model: string,
  call: (input: ModelInput) => Promise<ModelOutput>,
): Promise<ActionVerdict> {
  const out = await call({
    model,
    system: [{ type: "text", text: CLASSIFIER_SYSTEM }],
    tools: [],
    messages: [{ role: "user", content: `Tool: ${name}(${JSON.stringify(input)})\n\nTranscript:\n${transcript}` }],
  });
  const text = extractText(out).trim();
  if (text === "ALLOW" || text.startsWith("ALLOW")) return { allow: true, reason: "" };
  return { allow: false, reason: text.replace(/^BLOCK:?\s*/i, "") };
}

/** 渲染消息数组为纯文本（tool 块不展开细节——脱敏，评估器/分类器只看"谁说了什么"） */
export function renderTranscript(messages: { role: string; content: unknown }[]): string {
  return messages
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[tool call / result]"}`)
    .join("\n");
}

function extractText(out: ModelOutput): string {
  return out.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}