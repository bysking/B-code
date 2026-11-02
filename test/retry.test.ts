import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDelay,
  isRetryableError,
  MAX_RETRIES,
  RETRY_DELAYS_MS,
  withRetry,
  type Sleeper,
} from '../src/retry.js';

/** 立即返回的等待替身：记录每次请求的退避时长，避免真等 3 分钟 */
function fakeSleep(): { sleep: Sleeper; delays: number[] } {
  const delays: number[] = [];
  const sleep: Sleeper = async (ms) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

// ── 退避节奏 ─────────────────────────────────────────────────────

test('退避节奏是 10s → 20s → 30s → 2min，共 4 次重试', () => {
  assert.deepEqual([...RETRY_DELAYS_MS], [10_000, 20_000, 30_000, 120_000]);
  assert.equal(MAX_RETRIES, 4, '最多重试 4 次（首次尝试不计）');
});

test('formatDelay：人类可读时长', () => {
  assert.equal(formatDelay(10_000), '10s');
  assert.equal(formatDelay(30_000), '30s');
  assert.equal(formatDelay(120_000), '2min');
  assert.equal(formatDelay(500), '500ms');
});

// ── 错误分类 ─────────────────────────────────────────────────────

test('isRetryableError：5xx / 408 / 409 / 429 可重试', () => {
  for (const s of [500, 502, 503, 504, 408, 409, 429]) {
    assert.equal(isRetryableError(httpError(s)), true, `${s} 应可重试`);
  }
});

test('isRetryableError：4xx 客户端错误不重试（重试也不会变好）', () => {
  for (const s of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableError(httpError(s)), false, `${s} 不应重试`);
  }
});

test('isRetryableError：网络类错误码可重试', () => {
  const e = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
  assert.equal(isRetryableError(e), true);
  const t = Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
  assert.equal(isRetryableError(t), true);
});

test('isRetryableError：消息含 timeout / overloaded / rate limit 也视为可重试', () => {
  assert.equal(isRetryableError(new Error('Request timeout')), true);
  assert.equal(isRetryableError(new Error('Overloaded')), true);
  assert.equal(isRetryableError(new Error('rate limit exceeded')), true);
});

test('isRetryableError：用户中断（AbortError）绝不重试', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(isRetryableError(abort), false, 'Esc 是明确意图，不能重试');
});

test('isRetryableError：普通业务错误不重试', () => {
  assert.equal(isRetryableError(new Error('file not found')), false);
  assert.equal(isRetryableError(null), false);
  assert.equal(isRetryableError('str'), false);
});

// ── withRetry 行为 ───────────────────────────────────────────────

test('withRetry：首次成功不重试', async () => {
  const { sleep, delays } = fakeSleep();
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      return 'ok';
    },
    { sleep },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('withRetry：两次失败后成功，按 10s → 20s 退避', async () => {
  const { sleep, delays } = fakeSleep();
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls <= 2) throw httpError(503);
      return 'ok';
    },
    { sleep },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 3, '首次 + 2 次重试');
  assert.deepEqual(delays, [10_000, 20_000], '与退避节奏一致');
});

test('withRetry：持续失败则重试 4 次后上抛，总尝试 5 次', async () => {
  const { sleep, delays } = fakeSleep();
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw httpError(500);
        },
        { sleep },
      ),
    /HTTP 500/,
  );
  assert.equal(calls, 5, '首次 + 4 次重试');
  assert.deepEqual(delays, [10_000, 20_000, 30_000, 120_000], '完整节奏');
});

test('withRetry：不可重试错误立即上抛，不消耗次数', async () => {
  const { sleep, delays } = fakeSleep();
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw httpError(400);
        },
        { sleep },
      ),
    /HTTP 400/,
  );
  assert.equal(calls, 1, '4xx 立即失败');
  assert.deepEqual(delays, []);
});

test('withRetry：signal 已 abort → 立即抛，不尝试', async () => {
  const { sleep } = fakeSleep();
  const ctrl = new AbortController();
  ctrl.abort(new Error('Aborted'));
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          return 'ok';
        },
        { sleep, signal: ctrl.signal },
      ),
    /Aborted/,
  );
  assert.equal(calls, 0, '中断后不再发起请求');
});

test('withRetry：重试等待期间中止会中断（不必等完 2 分钟）', async () => {
  const ctrl = new AbortController();
  // 真实 sleep 但立刻 abort：验证 signal 能打断退避等待
  const promise = withRetry(
    async () => {
      throw httpError(503);
    },
    {
      signal: ctrl.signal,
      delays: [60_000],
      sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('Aborted'));
          });
        }),
    },
  );
  setTimeout(() => ctrl.abort(new Error('Aborted')), 10);
  await assert.rejects(() => promise, /Aborted/);
});

test('withRetry：onRetry 在每次重试前收到次数与等待时长', async () => {
  const { sleep } = fakeSleep();
  const seen: { attempt: number; delayMs: number }[] = [];
  await assert.rejects(() =>
    withRetry(
      async () => {
        throw httpError(502);
      },
      { sleep, onRetry: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }) },
    ),
  );
  assert.deepEqual(seen, [
    { attempt: 1, delayMs: 10_000 },
    { attempt: 2, delayMs: 20_000 },
    { attempt: 3, delayMs: 30_000 },
    { attempt: 4, delayMs: 120_000 },
  ]);
});

test('withRetry：onRetry 抛错可中止重试（用于"已输出内容不再重试"）', async () => {
  const { sleep, delays } = fakeSleep();
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw httpError(503);
        },
        {
          sleep,
          onRetry: ({ error }) => {
            throw error; // 模拟"已吐出流式内容"：不再重试
          },
        },
      ),
    /HTTP 503/,
  );
  assert.equal(calls, 1, '第一次失败后即放弃');
  assert.deepEqual(delays, []);
});
