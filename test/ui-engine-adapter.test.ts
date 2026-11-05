import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 渲染引擎适配层门禁。
 *
 * 业务组件必须通过 `src/ui/ui/index.ts` 访问渲染能力，不能直连 ink——
 * 否则将来换引擎时这些地方全都要改回来，适配层就白做了。
 *
 * 用静态扫描而非行为测试：要防的正是"有人图省事又写了 import from 'ink'"。
 */

const UI_DIR = fileURLToPath(new URL('../src/ui/', import.meta.url));
/** 适配层自己的实现目录——只有这里允许直连具体引擎 */
const ADAPTER_DIR = join(UI_DIR, 'ui');

/** 递归收集 ts/tsx 文件 */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

test('门禁：业务代码不得直连 ink（已移除该引擎）', () => {
  const files = collect(UI_DIR).filter((f) => !f.startsWith(ADAPTER_DIR));
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf-8');
    if (/from\s+['"]ink['"]/.test(src)) {
      offenders.push(f.replace(UI_DIR, 'src/ui/'));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下文件仍引用已移除的 ink：\n  ${offenders.join('\n  ')}`,
  );
});

test('门禁：业务代码不得直连未来的其他引擎包', () => {
  const files = collect(UI_DIR).filter((f) => !f.startsWith(ADAPTER_DIR));
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf-8');
    if (/from\s+['"]@opentui\//.test(src)) {
      offenders.push(f.replace(UI_DIR, 'src/ui/'));
    }
  }
  assert.deepEqual(offenders, [], `以下文件直连了 OpenTUI，应走适配层：\n  ${offenders.join('\n  ')}`);
});

test('适配层契约：引擎实现导出完整接口', async () => {
  const { opentuiEngine } = await import('../src/ui/ui/opentui/index.js');
  const required = [
    'Box',
    'Text',
    'useInput',
    'usePaste',
    'useTerminalSize',
    'useElementSize',
    'mount',
  ] as const;
  for (const key of required) {
    assert.ok(key in opentuiEngine, `引擎实现缺少 ${key}`);
  }
  assert.equal(typeof opentuiEngine.mount, 'function', 'mount 必须是函数');
});

test('适配层是唯一出口：index 导出的能力与契约一致', async () => {
  const mod = await import('../src/ui/ui/index.js');
  for (const key of ['Box', 'Text', 'useInput', 'usePaste', 'useTerminalSize', 'useElementSize', 'mount']) {
    assert.ok(key in mod, `ui/index.ts 应导出 ${key}`);
  }
});
