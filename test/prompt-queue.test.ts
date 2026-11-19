import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { MAX_QUEUED_PROMPTS, PromptQueue, classifyInput, commandName } from '../src/prompt-queue.js';

/**
 * 忙碌期输入分流 + 提示词队列。
 *
 * 这一层是「思考中 /skills 打不开」「二次输入被吞」两条 todo 的判据来源：
 * `local` 立即执行、`chat` 排队等本轮结束。分类错了就是功能没修好。
 */

test('commandName：只认 / 开头的首个 token', () => {
  assert.equal(commandName('/mcp'), 'mcp');
  assert.equal(commandName('/todo add 买牛奶'), 'todo');
  assert.equal(commandName('  /skills  '), 'skills');
  assert.equal(commandName('普通对话'), null);
  assert.equal(commandName('/'), null);
});

test('classifyInput：面板/查询类命令在忙碌期可立即执行', () => {
  for (const line of [
    '/skills',
    '/mcp',
    '/help',
    '/cost',
    '/todos',
    '/todo',
    '/todo add 买牛奶',
    '/todo_clear',
    '/export /tmp/x.md',
    '/btw 这里为什么要加锁',
  ]) {
    assert.equal(classifyInput(line), 'local', `${line} 应为 local`);
  }
});

test('classifyInput：裸 /model 是查询（local），带参数是切换（chat）', () => {
  assert.equal(classifyInput('/model'), 'local');
  assert.equal(classifyInput('/model claude-sonnet-5-5'), 'chat', '切换会改在飞调用的模型');
});

test('classifyInput：/btw 归 local（旁支不写主历史、不打断主线）', () => {
  assert.equal(classifyInput('/btw'), 'local');
  assert.equal(classifyInput('/btw 这里为什么要加锁'), 'local');
});

test('classifyInput：会改动 Agent 状态或要调模型的都是 chat', () => {
  for (const line of [
    '/clear',
    '/compact',
    '/rewind',
    '/plan',
    '/yolo',
    '/remember 一条事实',
    '帮我改个 bug',
  ]) {
    assert.equal(classifyInput(line), 'chat', `${line} 应为 chat`);
  }
});

test('classifyInput：未知斜杠命令默认 chat（白名单策略，安全侧）', () => {
  assert.equal(classifyInput('/some-new-command'), 'chat');
});

test('PromptQueue：FIFO 顺序，空串忽略', () => {
  const q = new PromptQueue();
  assert.equal(q.push('第一条'), true);
  assert.equal(q.push('   '), false, '空白不排队');
  assert.equal(q.push('第二条'), true);
  assert.equal(q.size, 2);
  assert.equal(q.shift(), '第一条');
  assert.equal(q.shift(), '第二条');
  assert.equal(q.shift(), null);
});

test('PromptQueue：shiftLast 从队尾撤回（↑ 拉回输入框）', () => {
  const q = new PromptQueue();
  q.push('最早的');
  q.push('中间的');
  q.push('刚敲的');
  assert.equal(q.shiftLast(), '刚敲的', '撤回的是最近输入的那条');
  assert.equal(q.shiftLast(), '中间的');
  assert.equal(q.shiftLast(), '最早的');
  assert.equal(q.shiftLast(), null, '撤空后返回 null，UI 据此退回历史逻辑');
  assert.equal(q.size, 0);
});

test('PromptQueue：pushFront 插队（Ctrl+Enter 强插语义）', () => {
  const q = new PromptQueue();
  q.push('排队的');
  q.pushFront('强插的');
  assert.deepEqual(q.snapshot(), ['强插的', '排队的']);
});

test('PromptQueue：超上限丢最旧的，且不影响队首强插', () => {
  const q = new PromptQueue();
  for (let i = 0; i < MAX_QUEUED_PROMPTS; i++) q.push(`p${i}`);
  assert.equal(q.size, MAX_QUEUED_PROMPTS);
  q.push('overflow');
  assert.equal(q.size, MAX_QUEUED_PROMPTS, '不涨过上限');
  assert.equal(q.snapshot()[0], 'p1', '丢掉最旧的一条');
  assert.equal(q.snapshot().at(-1), 'overflow');

  // pushFront 超上限时截掉**队尾**（最近的那条挤掉最老的排队项）
  q.pushFront('front');
  assert.equal(q.size, MAX_QUEUED_PROMPTS);
  assert.equal(q.snapshot()[0], 'front');
});

test('PromptQueue：snapshot 是副本，外部改动不回流', () => {
  const q = new PromptQueue();
  q.push('a');
  const snap = q.snapshot();
  snap.push('b');
  assert.equal(q.size, 1);
});

test('PromptQueue：clear 清空', () => {
  const q = new PromptQueue();
  q.push('a');
  q.clear();
  assert.equal(q.size, 0);
  assert.deepEqual(q.snapshot(), []);
});
