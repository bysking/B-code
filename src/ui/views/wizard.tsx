import { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { COLORS, attrs } from '../primitives/theme.js';
import type { AskWizardState, WizardStepOption } from '../controller.js';

/**
 * 多步向导（模型驱动的选择交互）。
 *
 * ```
 * ← ☒1 ●2 ○3 ✔Submit→
 *   ? 用哪个方案?
 *   ❯ 1. React
 *     2. ✎ 我想自己提供…
 * ```
 *
 * 每步：↑↓ 选项、Enter 前进；"自定义"选中后进入行内输入；
 * ←/→ 前后翻步；最后 Review 汇总提交。
 * multi 模式每步可勾选多个（Enter/空格切换），特殊项变为"完成本步"。
 *
 * resolve 协议：结果文本 / `__cancel__`
 */

export const CUSTOM_LABEL = '我想自己提供一个不在选项里面的答案';

/** 每步导航范围 = 选项数 + 1 个特殊项 */
export function wizardNavTotal(optionCount: number): number {
  return optionCount + 1;
}

export function wizardProgress(step: number, stepCount: number): string {
  const marks = ['←'];
  for (let i = 0; i < stepCount; i++) {
    const mark = i < step ? '☒' : i === step ? '●' : '○';
    marks.push(`${mark}${i + 1}`);
  }
  marks.push('✔Submit→');
  return marks.join(' ');
}

/** 汇总各步答案（未答标"未选"）；多选步逗号拼接 */
export function buildWizardResult(
  steps: AskWizardState['steps'],
  answers: Record<number, string | string[]>,
): string {
  return steps
    .map((s, i) => {
      const v = answers[i];
      const text = Array.isArray(v) ? v.filter(Boolean).join(', ') : (v ?? '');
      return `${s.title}: ${text.trim() ? text.trim() : '（未选）'}`;
    })
    .join('\n');
}

export function answerText(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  return v ?? '';
}

/** 回到某步时的高亮起点 */
function defaultIdxFor(
  target: number,
  opts: WizardStepOption[],
  multi: boolean,
  answers: Record<number, string | string[]>,
): number {
  const v = answers[target];
  if (v == null) return 0;
  if (Array.isArray(v)) {
    const last = v[v.length - 1];
    if (last == null) return 0;
    const i = opts.findIndex((o) => o.label === last);
    return i >= 0 ? i : 0;
  }
  const i = opts.findIndex((o) => o.label === v);
  return i >= 0 ? i : opts.length;
}

export function Wizard({ ask, onResolve }: { ask: AskWizardState; onResolve: (value: string) => void }) {
  const steps = ask.steps;
  const multi = !!ask.multi;
  const [step, setStep] = useState(0);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');

  const review = step >= steps.length;
  const opts = steps[step]?.options ?? [];
  const itemLen = opts.length;

  const selectedFor = (i: number): string[] => {
    const v = answers[i];
    return Array.isArray(v) ? v : v ? [v] : [];
  };
  const toggle = (label: string) => {
    const cur = selectedFor(step);
    const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    setAnswers({ ...answers, [step]: next });
  };
  const pickIdx = (i: number, len: number) => (len <= 0 ? 0 : (i + len) % len);

  useEffect(() => {
    setStep(0);
    setIdx(0);
    setAnswers({});
    setTyping(false);
    setDraft('');
  }, [ask.question]);

  const advanceTo = (next: Record<number, string | string[]>) => {
    const target = step + 1;
    if (target >= steps.length) {
      setStep(steps.length);
      setIdx(0);
    } else {
      setStep(target);
      setIdx(defaultIdxFor(target, steps[target]?.options ?? [], multi, next));
    }
  };

  useKeyboard(
    (e) => {
      if (e.name === 'escape') {
        // 输入态按 Esc = 返回选项列表（不是取消整个向导）
        if (typing) {
          setTyping(false);
          setDraft('');
          return;
        }
        onResolve('__cancel__');
        return;
      }
      // 输入态下其余快捷键让位给 textarea
      if (typing) return;
      if (e.name === 'up' || e.name === 'down' || e.name === 'j' || e.name === 'k') {
        const delta = e.name === 'up' || e.name === 'k' ? -1 : 1;
        const len = review ? 2 : wizardNavTotal(itemLen);
        setIdx((i) => pickIdx(i + delta, len));
        return;
      }
      if (e.name === 'left' || e.name === 'h') {
        const target = Math.max(0, step - 1);
        setStep(target);
        setIdx(defaultIdxFor(target, steps[target]?.options ?? [], multi, answers));
        return;
      }
      if (e.name === 'right' || e.name === 'tab' || e.name === 'l') {
        if (step + 1 > steps.length) return;
        const target = step + 1;
        setStep(target);
        setIdx(defaultIdxFor(target, steps[target]?.options ?? [], multi, answers));
        return;
      }
      if (e.name === 'return') {
        if (review) {
          onResolve(idx === 0 ? buildWizardResult(steps, answers) : '__cancel__');
          return;
        }
        if (idx < itemLen) {
          const opt = opts[idx];
          if (!opt) return;
          if (multi) {
            toggle(opt.label);
          } else {
            const next = { ...answers, [step]: opt.label };
            setAnswers(next);
            advanceTo(next);
          }
        } else if (idx === itemLen) {
          if (multi) {
            advanceTo(answers);
          } else {
            setTyping(true);
            const prev = answers[step];
            const isCustomPrev =
              typeof prev === 'string' && !opts.some((o) => o.label === prev);
            setDraft(isCustomPrev ? prev : '');
          }
        }
        return;
      }
      // 多选：空格切换勾选
      if (multi && !review && e.name === 'space') {
        if (idx < itemLen) {
          const opt = opts[idx];
          if (opt) toggle(opt.label);
        }
      }
    },
    { release: false },
  );

  // 行内输入态：字符输入交给一个独立的小 textarea
  const commitTyped = (raw?: string) => {
    const text = (raw ?? '').trim();
    const next = { ...answers, [step]: text || '（自定义）' };
    setAnswers(next);
    setTyping(false);
    advanceTo(next);
  };

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={COLORS.accent}
      paddingX={1}
      marginTop={1}
      flexShrink={0}
    >
      <text fg={COLORS.muted} attributes={attrs('dim')}>
        {wizardProgress(step, steps.length)}
      </text>

      {review ? (
        <>
          <text fg={COLORS.accent} attributes={attrs('bold')}>
            ? Review your answers
          </text>
          {steps.map((s, i) => (
            <text key={i} fg={COLORS.text} wrapMode="none">
              {'  '}
              {answerText(answers[i]) ? '●' : '○'} {s.title}: {answerText(answers[i]) || '（未选）'}
            </text>
          ))}
          <text fg={idx === 0 ? COLORS.accent : COLORS.text}>
            {idx === 0 ? '❯ ' : '  '}1. Submit answers
          </text>
          <text fg={idx === 1 ? COLORS.accent : COLORS.text}>
            {idx === 1 ? '❯ ' : '  '}2. Cancel
          </text>
        </>
      ) : (
        <>
          <text fg={COLORS.warning}>? {steps[step]?.question}</text>
          {opts.map((o, i) => {
            const active = i === idx;
            const checked = multi && selectedFor(step).includes(o.label);
            return (
              <text key={o.value} fg={active ? COLORS.accent : COLORS.text} wrapMode="none">
                {'  '}
                {active ? '❯ ' : '  '}
                {multi ? (checked ? '✓ ' : '○ ') : ''}
                {i + 1}. {o.label}
                {o.description ? <span fg={COLORS.muted}> — {o.description}</span> : null}
              </text>
            );
          })}
          {multi ? (
            <text fg={idx === itemLen ? COLORS.accent : COLORS.muted}>
              {'  '}
              {idx === itemLen ? '❯ ' : '  '}
              {itemLen + 1}. {step >= steps.length - 1 ? '✔ 完成并查看汇总' : '→ 完成本步，下一步'}
            </text>
          ) : (
            <box flexDirection="row">
              <text fg={idx === itemLen ? COLORS.accent : COLORS.muted}>
                {'  '}
                {idx === itemLen ? '❯ ' : '  '}
                {itemLen + 1}. ✎ {CUSTOM_LABEL}
              </text>
              {typing ? (
                <input
                  style={{ width: 30 }}
                  value={draft}
                  focused
                  placeholder="输入你的答案..."
                  placeholderColor={COLORS.muted}
                  textColor={COLORS.text}
                  onInput={(v: string) => setDraft(v)}
                  onSubmit={() => commitTyped(draft)}
                />
              ) : null}
            </box>
          )}
        </>
      )}

      <text fg={COLORS.muted} attributes={attrs('dim')}>
        {typing
          ? 'Enter 提交自定义答案 · Esc 返回选项'
          : 'Enter 选择 · ↑↓ 选项 · ←/→ 步骤 · Esc 取消'}
      </text>
    </box>
  );
}
