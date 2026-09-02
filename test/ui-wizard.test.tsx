import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/app.js';
import { AppController } from '../src/ui/controller.js';
import { buildWizardResult, wizardNavTotal, wizardProgress } from '../src/ui/wizard.js';
import { Agent } from '../src/agent.js';
import type { ModelInput, ModelOutput } from '../src/backend.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 剥离 ANSI 色码：FORCE_COLOR 环境下渲染输出带颜色，断言只看纯文本 */
const stripAnsi = (out: string): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const frameText = (frame: { lastFrame: () => string | undefined }): string =>
  stripAnsi(frame.lastFrame() ?? '');

/**
 * 等待 frame 渲染出包含 needle 的内容（轮询代替固定睡眠：
 * ink 渲染提交在微任务/帧边界后，固定 wait 在高负载下可能读到上一帧）
 */
async function waitForFrame(
  frame: { lastFrame: () => string | undefined },
  needle: string,
  label: string,
  timeoutMs = 2000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = frameText(frame);
    if (out.includes(needle)) return out;
    if (Date.now() > deadline) throw new Error(`waitForFrame 超时（${label}）：\n${out}`);
    await wait(10);
  }
}

/** 写一段按键序列后等 ink 处理完（stdin 是同步 emit，等一帧让 React 提交渲染） */
const press = async (frame: { stdin: { write: (s: string) => void } }, keys: string) => {
  frame.stdin.write(keys);
  await wait(20);
};

function createApp(ctrl: AppController) {
  return React.createElement(App, {
    ctrl,
    onSubmit: () => {},
    onInterrupt: () => {},
    onExit: () => {},
    onSetMode: () => {},
    initialOutput: undefined,
  });
}

// ── 纯函数 ──────────────────────────────────────────────────
test('wizardProgress：完成☒/当前●/待做○ + Submit', () => {
  assert.equal(wizardProgress(0, 3), '← ●1 ○2 ○3 ✔Submit→', '起始步骤为当前');
  assert.equal(wizardProgress(1, 1), '← ☒1 ✔Submit→', '单步完成');
});

test('wizardNavTotal：导航范围含 1 个特殊项（自定义与 Chat 合一）', () => {
  assert.equal(wizardNavTotal(2), 3, '2 选项 + 自定义');
  assert.equal(wizardNavTotal(0), 1, '无选项时也可达特殊项');
});

test('buildWizardResult：按步汇总 + 未选标注', () => {
  const steps = [
    { title: '框架', question: 'q1', options: [{ label: 'Vue', value: 'vue' }] },
    { title: '构建', question: 'q2', options: [] },
  ];
  const out = buildWizardResult(steps, { 0: 'Vue' });
  assert.equal(out, '框架: Vue\n构建: （未选）');
});

test('buildWizardResult：多选步数组逗号拼接', () => {
  const steps = [
    {
      title: '框架',
      question: 'q1',
      options: [
        { label: 'Vue', value: 'vue' },
        { label: 'React', value: 'react' },
      ],
    },
    { title: '构建', question: 'q2', options: [] },
  ];
  const out = buildWizardResult(steps, { 0: ['Vue', 'React'] });
  assert.equal(out, '框架: Vue, React\n构建: （未选）');
});

// ── 渲染 ────────────────────────────────────────────────────
test('渲染：Wizard 进度条 + 当前步选项 + 自定义特殊项；Review 汇总 Submit/Cancel', async () => {
  const ctrl = new AppController();
  const frame = render(createApp(ctrl));
  const p = ctrl.askWizard('搭建新项目?', [
    {
      title: '框架',
      question: '选择前端框架?',
      options: [
        { label: 'Vue', value: 'vue' },
        { label: 'React', value: 'react' },
      ],
    },
    {
      title: '构建',
      question: '选择构建工具?',
      options: [
        { label: 'Vite', value: 'vite' },
        { label: 'Webpack', value: 'wp' },
      ],
    },
  ]);
  await wait(30);
  const out = frame.lastFrame() ?? '';
  assert.ok(out.includes('✔Submit→'), '进度条含 Submit');
  assert.ok(out.includes('选择前端框架?'), '第一步问题');
  assert.ok(out.includes('我想自己提供一个不在选项里面的答案'), '自定义入口');
  // 默认聚焦第一步第一个选项时：不渲染行内输入框
  assert.ok(!out.includes('输入你的答案'), '导航态不出现输入框');

  // 直接提交（模拟用户在 Review 选 Submit answers）
  ctrl.resolveAskWizard('框架: Vue\n构建: Webpack');
  assert.equal(await p, '框架: Vue\n构建: Webpack');
  assert.equal(ctrl.askWizardState, null);
  frame.cleanup();
});

test('交互：选中自定义 → 行内输入 → 回车作为该步答案 → Review 提交', async () => {
  const ctrl = new AppController();
  const frame = render(createApp(ctrl));
  const p = ctrl.askWizard('选择?', [
    {
      title: '方案',
      question: '用哪个?',
      options: [
        { label: 'React', value: 'react' },
        { label: 'Vue', value: 'vue' },
      ],
    },
  ]);
  await waitForFrame(frame, '用哪个?', '向导渲染');

  // ↓↓ 移到自定义项（导航范围 = 2 选项 + 自定义）并 Enter 进入输入态
  await press(frame, '\x1b[B');
  await press(frame, '\x1b[B');
  await press(frame, '\r');
  await waitForFrame(frame, '输入你的答案', '特殊项右侧出现内联输入框');

  // 普通键入（TextInput 回显）+ 回车提交自定义答案
  await press(frame, '我自己的方案');
  await waitForFrame(frame, '我自己的方案', '输入回显');

  // 提交该步答案 → 单步向导直接到 Review → 回车确认 Submit answers
  await press(frame, '\r');
  await waitForFrame(frame, 'Review your answers', '进入 Review 汇总');
  await press(frame, '\r');

  assert.equal(await p, '方案: 我自己的方案');
  assert.equal(ctrl.askWizardState, null);
  frame.cleanup();
});

// ── 分步多选 ────────────────────────────────────────────────
test('分步多选：Enter/空格勾选多个 → 完成本步 → Review 提交（逗号拼接）', async () => {
  const ctrl = new AppController();
  const frame = render(createApp(ctrl));
  const p = ctrl.askWizard(
    '搭建新项目?',
    [
      {
        title: '框架',
        question: '选哪些前端框架?',
        options: [
          { label: 'Vue', value: 'vue' },
          { label: 'React', value: 'react' },
        ],
      },
    ],
    true, // multi
  );
  await wait(30);
  const out = frame.lastFrame() ?? '';
  assert.ok(out.includes('○ 1. Vue'), '未选显示 ○');
  assert.ok(out.includes('✔ 完成并查看汇总'), '单步时特殊项为完成汇总');
  assert.ok(!out.includes('我想自己提供一个不在选项里面的答案'), '多选模式不出现自定义入口');

  // Enter 勾选 Vue（不前进）
  frame.stdin.write('\r');
  await wait(20);
  assert.ok((frame.lastFrame() ?? '').includes('✓ 1. Vue'), 'Enter 后 Vue 变 ✓');
  // ↓ 到 React，空格勾选
  frame.stdin.write('[B');
  await wait(10);
  frame.stdin.write(' ');
  await wait(20);
  assert.ok((frame.lastFrame() ?? '').includes('✓ 2. React'), '空格后 React 变 ✓');
  // ↓ 到特殊项（完成本步）→ Enter 进 Review → Enter 提交
  frame.stdin.write('[B');
  await wait(10);
  frame.stdin.write('\r');
  await wait(20);
  frame.stdin.write('\r');
  assert.equal(await p, '框架: Vue, React');
  frame.cleanup();
});

test('分步多选：再次 Enter 取消勾选，空选走 Review 标未选', async () => {
  const ctrl = new AppController();
  const frame = render(createApp(ctrl));
  const p = ctrl.askWizard(
    '选?',
    [
      {
        title: '框架',
        question: '选哪些?',
        options: [
          { label: 'Vue', value: 'vue' },
          { label: 'React', value: 'react' },
        ],
      },
    ],
    true,
  );
  await wait(30);
  // 勾选 Vue → 再 Enter 取消
  frame.stdin.write('\r');
  await wait(20);
  frame.stdin.write('\r');
  await wait(20);
  assert.ok((frame.lastFrame() ?? '').includes('○ 1. Vue'), '再次 Enter 取消勾选');
  // 空选直接完成本步 → Review 未选 → 提交
  frame.stdin.write('[B');
  await wait(10);
  frame.stdin.write('[B');
  await wait(10);
  frame.stdin.write('\r');
  await wait(20);
  frame.stdin.write('\r');
  assert.equal(await p, '框架: （未选）');
  frame.cleanup();
});

// ── 协议回灌 ────────────────────────────────────────────────
test("ask_user kind=wizard：回答以 '用户在向导中的回答' 回灌", async () => {
  const agent = new Agent({
    callModel: makeScripted([
      {
        tools: [
          {
            name: 'ask_user',
            input: {
              question: '初始化项目',
              kind: 'wizard',
              steps: [
                { title: '框架', question: '前端框架?', options: [{ label: 'Vue', value: 'vue' }] },
                { title: '构建', question: '构建工具?', options: [{ label: 'Vite', value: 'vite' }] },
              ],
            },
          },
        ],
      },
    ]),
    print: () => {},
    askWizardInput: async () => '框架: Vue\n构建: Vite',
  });
  await agent.chat('向导初始化');
  const fedBack = agent.history()[2] as unknown as { content: { content: string }[] };
  assert.ok(String(fedBack.content[0]?.content).includes('用户在向导中的回答'));
  assert.ok(String(fedBack.content[0]?.content).includes('框架: Vue'));
});

test('ask_user kind=wizard_multi：multi=true 透传，多选结果回灌', async () => {
  const agent = new Agent({
    callModel: makeScripted([
      {
        tools: [
          {
            name: 'ask_user',
            input: {
              question: '初始化项目',
              kind: 'wizard_multi',
              steps: [
                {
                  title: '框架',
                  question: '选哪些框架?',
                  options: [
                    { label: 'Vue', value: 'vue' },
                    { label: 'React', value: 'react' },
                  ],
                },
                { title: '工具', question: '选哪些工具?', options: [{ label: 'Vite', value: 'vite' }] },
              ],
            },
          },
        ],
      },
    ]),
    print: () => {},
    askWizardInput: async (_q, _steps, multi) => {
      assert.equal(multi, true, 'wizard_multi 透传 multi=true');
      return '框架: Vue, React\n工具: Vite';
    },
  });
  await agent.chat('多选向导初始化');
  const fedBack = agent.history()[2] as unknown as { content: { content: string }[] };
  assert.ok(String(fedBack.content[0]?.content).includes('用户在向导中的回答'));
  assert.ok(String(fedBack.content[0]?.content).includes('框架: Vue, React'));
});

function makeScripted(
  script: Array<{ tools: Array<{ name: string; input: Record<string, any> }> } | { text: string }>,
) {
  let step = 0;
  return async (_input: ModelInput): Promise<ModelOutput> => {
    const s = script[step] ?? { text: 'done' };
    step++;
    if ('text' in s) return { content: [{ type: 'text', text: s.text }] };
    return {
      content: s.tools.map((t, i) => ({
        type: 'tool_use' as const,
        id: `tu-${step}-${i}`,
        name: t.name,
        input: t.input,
      })),
    };
  };
}
