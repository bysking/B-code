import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupLogging, log, logState, setLogLevel, setLogSink } from '../src/utils/log.js';

let dir: string;
const savedFile = process.env.B_CODE_LOG_FILE;
const savedLevel = process.env.B_CODE_LOG_LEVEL;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b-code-log-'));
});

after(async () => {
  if (savedFile === undefined) delete process.env.B_CODE_LOG_FILE;
  else process.env.B_CODE_LOG_FILE = savedFile;
  if (savedLevel === undefined) delete process.env.B_CODE_LOG_LEVEL;
  else process.env.B_CODE_LOG_LEVEL = savedLevel;
  await rm(dir, { recursive: true, force: true });
});

test('级别过滤：info 级别下 debug 被丢弃', () => {
  setLogLevel('info'); // 不依赖外部 env
  const err = process.stderr.write;
  let captured = '';
  (process.stderr as any).write = (s: string) => {
    captured += s;
    return true;
  };
  try {
    log.debug('should-not-appear');
    log.info('visible-info');
  } finally {
    process.stderr.write = err;
  }
  assert.ok(!captured.includes('should-not-appear'));
  assert.ok(captured.includes('visible-info'));
});

test('B_CODE_LOG_FILE 开启后落盘，行级别受控', async () => {
  process.env.B_CODE_LOG_FILE = '1';
  process.env.B_CODE_LOG_LEVEL = 'warn';
  setupLogging({ dir });
  assert.ok(logState().fileSink.startsWith(join(dir, 'b-code-')), '落盘到指定目录');

  log.info('info-not-to-file');
  log.warn('warn-to-file');
  log.debug('debug-not-to-file', { a: 1 });

  // appendFileSync 是同步写，此处读一定能看到已写入的行
  const content = await readFile(logState().fileSink, 'utf-8');
  assert.ok(content.includes('warn-to-file'));
  assert.ok(!content.includes('info-not-to-file'), 'warn 级别下 info 不入文件');
  assert.ok(!content.includes('debug-not-to-file'));
});

test('关闭 B_CODE_LOG_FILE 后不再产生新文件', () => {
  delete process.env.B_CODE_LOG_FILE;
  setupLogging({ dir });
  assert.equal(logState().fileSink, '');
});

// ── 日志汇接管：TTY 下转进 UI，而不是写 stderr ──────────────────

test('setLogSink：接管后日志不再写 stderr，行交给汇处理', () => {
  setLogLevel('info');
  const err = process.stderr.write;
  let stderrOut = '';
  (process.stderr as any).write = (s: string) => {
    stderrOut += s;
    return true;
  };
  const seen: string[] = [];
  const restore = setLogSink((line, level) => seen.push(`${level}:${line}`));
  try {
    log.warn('hook timed out', 'detail');
    log.info('mcp connected');
  } finally {
    restore();
    process.stderr.write = err;
  }

  // 关键：stderr 零写入——每写一次 stderr 终端就把视口拉到底部
  assert.equal(stderrOut, '', '接管期间不得写 stderr（否则会拽动视口）');
  assert.equal(seen.length, 2);
  assert.ok(seen[0]!.startsWith('warn:'), '汇能拿到级别，便于分级着色');
  assert.ok(seen[0]!.includes('hook timed out detail'), 'extra 参数照常拼接');
});

test('setLogSink：restore 后恢复 stderr 输出（退出期日志要能落到终端）', () => {
  setLogLevel('info');
  const restore = setLogSink(() => {});
  restore();

  const err = process.stderr.write;
  let stderrOut = '';
  (process.stderr as any).write = (s: string) => {
    stderrOut += s;
    return true;
  };
  try {
    log.info('after-restore');
  } finally {
    process.stderr.write = err;
  }
  assert.ok(stderrOut.includes('after-restore'));
});

test('setLogSink：接管不影响文件落地（B_CODE_LOG_FILE 仍照写）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bcode-log-sink-'));
  const savedFlag = process.env.B_CODE_LOG_FILE;
  process.env.B_CODE_LOG_FILE = '1';
  try {
    setupLogging({ dir, level: 'info' });
    setLogLevel('info');
    const restore = setLogSink(() => {}); // 终端改走汇

    log.warn('to-file-only');
    restore();

    const files = await readdir(dir);
    assert.equal(files.length, 1, '仍按天生成日志文件');
    const content = await readFile(join(dir, files[0]!), 'utf8');
    assert.ok(content.includes('to-file-only'), '接管终端展示不影响文件落地');
  } finally {
    process.env.B_CODE_LOG_FILE = savedFlag;
    await rm(dir, { recursive: true, force: true });
  }
});
