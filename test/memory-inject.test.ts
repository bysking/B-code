import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_PATH_ENV } from '../src/utils/paths.js';
import { saveMemory } from '../src/memory.js';
import { Agent } from '../src/agent.js';
import type { ModelInput, ModelOutput } from '../src/backend.js';
import { flattenSystemBlocks } from '../src/prompt.js';

/**
 * 记忆/技能注入验证：agent.chat 时 system 动态块应包含记忆召回段与技能描述。
 * 不调真实后端——用捕获型假后端拿 system 快照。
 */
const saved = process.env[BASE_PATH_ENV];
let home: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'b-code-inject-'));
  process.env[BASE_PATH_ENV] = home;
});

after(async () => {
  if (saved === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = saved;
  await rm(home, { recursive: true, force: true });
});

test('chat 时 system 注入记忆召回 + 技能描述', async () => {
  saveMemory('staging url', 'staging env', 'reference', 'https://staging.example.com', process.cwd());
  let system!: ModelInput['system'];
  const fn = async (input: ModelInput): Promise<ModelOutput> => {
    system = input.system;
    return { content: [{ type: 'text', text: 'done' }] };
  };
  const agent = new Agent({ callModel: fn, print: () => {} });
  await agent.chat('what is the staging url?');

  const text = flattenSystemBlocks(system);
  assert.ok(text.includes('# Memory'), '记忆段在 system 中');
  assert.ok(text.includes('staging.example.com'), '召回内容注入');
  assert.ok(text.includes('# Available Skills'), '技能段在 system 中');
  assert.ok(text.includes('/commit'), '项目 commit 技能被注入');
});
