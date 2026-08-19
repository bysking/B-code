import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AskWizardState, WizardStepOption } from "./controller.js";

/**
 * 多步向导（参考 Claude Code 的 tab 向导）：
 *   ← ☒ 步骤1  ● 步骤2  ○ 步骤3  ✔ Submit →
 *      └ 已完成(☒) / 当前(●) / 待做(○)，最后是 Submit 汇总
 *  每步：↑↓ 选预设，Enter 前进；"✎ 自定义" 选中后光标落在该项右侧内联输入框，
 *  输入回车即作为该步答案再前进。可 ←/→ 回改；最后进入 Review 汇总 → Submit answers / Cancel。
 *  resolve 协议：结果文本 / __cancel__
 *
 *  multi 模式（分步多选）：每步 Enter/空格 切换勾选（✓/○），特殊项变为
 *  "→ 完成本步"（最后一步为"✔ 完成并查看汇总"）；Review 汇总每步逗号拼接。
 */

export const CUSTOM_LABEL = "我想自己提供一个不在选项里面的答案";

/** 每步导航范围 = 选项数 + 1 个特殊项（单选=自定义 / 多选=完成本步） */
export function wizardNavTotal(optionCount: number): number {
  return optionCount + 1;
}

export function wizardProgress(step: number, stepCount: number): string {
  const marks = ["←"];
  for (let i = 0; i < stepCount; i++) {
    const mark = i < step ? "☒" : i === step ? "●" : "○";
    marks.push(`${mark}${i + 1}`);
  }
  marks.push(`✔Submit→`);
  return marks.join(" ");
}

/** 汇总各步答案（未答标 未选）；多选步的值为数组，逗号拼接 */
export function buildWizardResult(
  steps: AskWizardState["steps"],
  answers: Record<number, string | string[]>,
): string {
  return steps
    .map((s, i) => {
      const v = answers[i];
      const text = Array.isArray(v) ? v.filter(Boolean).join(", ") : (v ?? "");
      return `${s.title}: ${text.trim() ? text.trim() : "（未选）"}`;
    })
    .join("\n");
}

/** 单选答案字符串 / 多选答案数组 → 展示文本 */
export function answerText(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
  return v ?? "";
}

export function Wizard({
  ask,
  onResolve,
}: {
  ask: AskWizardState;
  onResolve: (value: string) => void;
}) {
  const steps = ask.steps;
  /** 分步多选：每步可勾选多个选项（Enter/空格切换），特殊项为"完成本步" */
  const multi = !!ask.multi;
  const [step, setStep] = useState(0);
  const [idx, setIdx] = useState(0);
  /** 单选存字符串；多选存字符串数组 */
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});
  /** true = 选中"自定义"后的行内输入态（其余按键暂停响应；多选模式无此态） */
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  /** 是否为 Review（提交前汇总）视图 */
  const review = step >= steps.length;
  const reviewIdx = idx;

  /** 该步当前已勾选的标签列表（多选读数组，单选视为单项数组） */
  const selectedFor = (i: number): string[] => {
    const v = answers[i];
    return Array.isArray(v) ? v : v ? [v] : [];
  };
  /** 多选：勾选/取消某标签 */
  const toggle = (label: string) => {
    const cur = selectedFor(step);
    const nextList = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    setAnswers({ ...answers, [step]: nextList });
  };

  useEffect(() => {
    setStep(0);
    setIdx(0);
    setAnswers({});
    setTyping(false);
    setDraft("");
  }, [ask.question]);

  const pickIdx = (i: number, len: number) => (len <= 0 ? 0 : (i + len) % len);

  useInput(
    (_input, key) => {
      if (key.escape) {
        onResolve("__cancel__");
        return;
      }
      if (key.upArrow || key.downArrow || _input === "j" || _input === "k") {
        const delta = key.upArrow || _input === "k" ? -1 : 1;
        // 导航范围含 1 个特殊项（自定义）——否则光标永远到不了它
        const len = review ? 2 : wizardNavTotal(steps[step]?.options.length ?? 0);
        setIdx((i) => pickIdx(i + delta, len));
        return;
      }
      if (key.leftArrow || _input === "h") {
        setStep((s) => Math.max(0, s - 1));
        setIdx(0);
        return;
      }
      if (key.rightArrow || key.tab || _input === "l") {
        // 前进：未到 Review 先到下一步／Review；Review 里 → 回最后一步
        setStep((s) => {
          if (s + 1 > steps.length) return s;
          setIdx(0);
          return s + 1;
        });
        return;
      }
      if (key.return) {
        if (review) {
          // Review：0=Submit answers，1=Cancel
          onResolve(idx === 0 ? buildWizardResult(steps, answers) : "__cancel__");
          return;
        }
        const opts = steps[step]?.options ?? [];
        const itemLen = opts.length;
        if (idx < itemLen) {
          const opt = opts[idx] as WizardStepOption | undefined;
          if (!opt) return;
          if (multi) {
            // 多选：Enter 切换勾选，不前进
            toggle(opt.label);
          } else {
            const next = { ...answers, [step]: opt.label };
            setAnswers(next);
            // 自动前进到下一步/Review
            setStep((s) => (step + 1 >= steps.length ? steps.length : s + 1));
            setIdx(0);
          }
        } else if (idx === itemLen) {
          if (multi) {
            // 特殊项"完成本步"：进入下一步/Review
            setStep((s) => (step + 1 >= steps.length ? steps.length : s + 1));
            setIdx(0);
          } else {
            // 选中"自定义"：光标落入该项右侧内联输入框
            setTyping(true);
            setDraft("");
          }
        }
        return;
      }
      // 多选：空格切换勾选（与 Enter 等价）
      if (multi && !review && _input === " ") {
        const opts = steps[step]?.options ?? [];
        if (idx < opts.length) {
          const opt = opts[idx] as WizardStepOption | undefined;
          if (opt) toggle(opt.label);
        }
        return;
      }
    },
    { isActive: !typing },
  );

  // 输入态：Enter 提交作为该步答案、Esc 退回选项列表（TextInput 不消费 Esc，单独保活）
  useInput(
    (_input, key) => {
      if (key.escape) {
        setTyping(false);
        setDraft("");
      }
    },
    { isActive: typing },
  );

  const commitTyped = () => {
    const text = draft.trim();
    // 自定义：记录为本步答案并前进
    const next = { ...answers, [step]: text || "(自定义)" };
    setAnswers(next);
    setTyping(false);
    if (step + 1 >= steps.length) setStep(steps.length);
    else setStep((s) => s + 1);
    setIdx(0);
  };

  const itemLen = steps[step]?.options.length ?? 0;
  const customActive = idx === itemLen;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* 进度条 */}
      <Text dimColor>{wizardProgress(step, steps.length)}</Text>

      {review ? (
        <>
          <Text color="yellow">? Review your answers</Text>
          {steps.map((s, i) => {
            const t = answerText(answers[i]);
            return (
              <Text key={s.title}>
                {"  ● "}
                {s.question}: <Text bold>{t.trim() ? t : "（未选）"}</Text>
              </Text>
            );
          })}
          {[
            { label: "Submit answers", hint: "" },
            { label: "Cancel", hint: "" },
          ].map((o, i) => (
            <Text key={o.label} color={i === idx ? "cyan" : undefined} bold={i === idx}>
              {"  "}
              {i === idx ? "❯ " : "  "}
              {i + 1}. {o.label}
            </Text>
          ))}
        </>
      ) : (
        <>
          <Text color="yellow">? {steps[step]?.question}</Text>
          <Box flexDirection="column">
            {(steps[step]?.options ?? []).map((o, i) => {
              const active = i === idx;
              const checked = multi && selectedFor(step).includes(o.label);
              return (
                <Text key={o.value} color={active ? "cyan" : undefined} bold={active}>
                  {"  "}
                  {active ? "❯ " : "  "}
                  {multi ? (checked ? "✓ " : "○ ") : ""}
                  {i + 1}. {o.label}
                  {o.description ? <Text dimColor> — {o.description}</Text> : null}
                </Text>
              );
            })}
            {multi ? (
              /* 多选特殊项：完成本步进入下一步（最后一步进 Review） */
              <Text color={customActive ? "magenta" : "gray"} bold={customActive}>
                {"  "}
                {customActive ? "❯ " : "  "}
                {itemLen + 1}. {step >= steps.length - 1 ? "✔ 完成并查看汇总" : "→ 完成本步，下一步"}
              </Text>
            ) : (
              /* 特殊项：选中后该项右侧出现内联输入框，输入即作为该步答案 */
              <Box>
                <Text color={customActive ? "magenta" : "gray"} bold={customActive}>
                  {"  "}
                  {customActive ? "❯ " : "  "}
                  {itemLen + 1}. ✎ {CUSTOM_LABEL}
                  {typing ? <Text> </Text> : null}
                </Text>
                {typing ? (
                  <TextInput
                    value={draft}
                    onChange={setDraft}
                    onSubmit={commitTyped}
                    placeholder="输入你的答案..."
                  />
                ) : null}
              </Box>
            )}
          </Box>
        </>
      )}
      <Text dimColor>
        {typing
          ? "Enter 提交自定义答案 · Esc 返回选项"
          : multi
            ? "Enter/空格 勾选/取消 · ↑↓ 选项 · ←/→ 步骤 · Esc 取消"
            : "Enter 选择 · ↑↓ 选项 · ←/→ 步骤 · Esc 取消"}
      </Text>
    </Box>
  );
}