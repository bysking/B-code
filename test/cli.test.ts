import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs, choiceAsWizard, groupsAsWizard } from '../src/cli.js';

const base = {
  resume: false,
  plan: false,
  yolo: false,
  auto: false,
  goal: '',
  loop: 0,
  session: '',
  instruction: '',
};

test('parseCliArgs：无参数 → 纯 REPL，默认模式', () => {
  assert.deepEqual(parseCliArgs([]), base);
});

test('parseCliArgs：--resume 用法', () => {
  assert.deepEqual(parseCliArgs(['--resume']), { ...base, resume: true });
});

test('parseCliArgs：one-shot 指令保留原文（含空格）', () => {
  assert.deepEqual(parseCliArgs(['Read', 'src/index.ts', 'and', 'summarize']), {
    ...base,
    instruction: 'Read src/index.ts and summarize',
  });
});

test('parseCliArgs：--resume 与 one-shot 并存', () => {
  assert.deepEqual(parseCliArgs(['--resume', 'hello world']), {
    ...base,
    resume: true,
    instruction: 'hello world',
  });
});

test('parseCliArgs：--plan / --yolo / --auto 被正确剥离', () => {
  assert.deepEqual(parseCliArgs(['--plan', '--yolo', '--auto', 'write a file']), {
    ...base,
    plan: true,
    yolo: true,
    auto: true,
    instruction: 'write a file',
  });
});

test('parseCliArgs：--goal 取下一 token 为条件，其余为指令', () => {
  assert.deepEqual(parseCliArgs(['--goal', 'test.txt exists', 'create test.txt']), {
    ...base,
    goal: 'test.txt exists',
    instruction: 'create test.txt',
  });
});

test('parseCliArgs：--loop 解析秒数，非法值归 0', () => {
  assert.deepEqual(parseCliArgs(['--loop', '30', 'watch it']), {
    ...base,
    loop: 30,
    instruction: 'watch it',
  });
  assert.equal(parseCliArgs(['--loop', 'abc']).loop, 0);
});

// ── 模型选择统一为 Wizard 的适配 ─────────────────────────────
test('choiceAsWizard：单选转单步向导', () => {
  const steps = choiceAsWizard('部署环境?', [
    { label: 'Dev', value: 'dev' },
    { label: 'Prod', value: 'prod' },
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.title, '选择');
  assert.equal(steps[0]?.question, '部署环境?');
  assert.deepEqual(steps[0]?.options, [
    { label: 'Dev', value: 'dev' },
    { label: 'Prod', value: 'prod' },
  ]);
});

test('groupsAsWizard：tab 组转多步向导（每组一步）', () => {
  const steps = groupsAsWizard('选栈?', [
    {
      title: '前端',
      options: [
        { label: 'React', value: 'react' },
        { label: 'Vue', value: 'vue' },
      ],
    },
    { title: '后端', options: [{ label: 'Node', value: 'node' }] },
  ]);
  assert.equal(steps.length, 2, '一组一步');
  assert.equal(steps[0]?.title, '前端');
  assert.equal(steps[1]?.title, '后端');
  assert.equal(steps[0]?.options[1]?.label, 'Vue');
});
