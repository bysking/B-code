import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

/**
 * 上下文压缩演示 —— §8 的分级防线 + §4 第二层的「压缩致死循环」。
 *
 * 两个可切换的演示:
 *   A. 压缩前后消息数组的形状变化(含保留最近 5 条)
 *   B. 有 / 无文件指针时,反复压缩的后果对比
 */

const KEEP_RECENT = 5;
const TOTAL = 18;

export function CompactionDemo() {
  const [compacted, setCompacted] = useState(false);
  const [withPointer, setWithPointer] = useState(true);
  const reduce = useReducedMotion();

  const oldCount = TOTAL - KEEP_RECENT;

  return (
    <div className="card" style={{ padding: '1.1rem' }}>
      <div className="btn-row" style={{ marginBottom: '0.9rem' }}>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setCompacted((v) => !v)}
          aria-pressed={compacted}
        >
          {compacted ? '↩ 还原压缩前' : '⚡ 触发压缩'}
        </button>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>
          阈值:{'>'}45 条 或 token {'>'} 窗口的 40%
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 3,
          alignItems: 'flex-end',
          minHeight: '6.5rem',
          padding: '0.6rem',
          background: 'var(--bg-inset)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          overflowX: 'auto',
        }}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {compacted ? (
            <motion.div
              key="summary"
              layout
              initial={reduce ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
              transition={{ duration: reduce ? 0 : 0.3 }}
              style={{
                flex: '0 0 auto',
                width: '8.5rem',
                alignSelf: 'stretch',
                borderRadius: 4,
                background: 'var(--accent-bg)',
                border: '1px solid var(--accent-line)',
                padding: '0.4rem',
                fontSize: '0.66rem',
                fontFamily: 'var(--mono)',
                color: 'var(--accent-text)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: 'var(--accent-text)', fontWeight: 700 }}>摘要</span>
              <span style={{ color: 'var(--text-dim)', lineHeight: 1.5, marginTop: 2 }}>
                处理了 xxx,读了这些文件…({oldCount} 条压成 1 条)
              </span>
            </motion.div>
          ) : (
            Array.from({ length: oldCount }, (_, i) => (
              <motion.div
                key={`old-${i}`}
                layout
                initial={reduce ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: `${2.2 + ((i * 7) % 3.4)}rem` }}
                exit={reduce ? undefined : { opacity: 0, height: 0 }}
                transition={{ duration: reduce ? 0 : 0.25, delay: reduce ? 0 : i * 0.012 }}
                style={{
                  flex: '0 1 1.1rem',
                  minWidth: '0.5rem',
                  borderRadius: 3,
                  background: 'var(--bar-muted)',
                  border: '1px solid var(--bar-muted-line)',
                }}
                aria-hidden="true"
              />
            ))
          )}
        </AnimatePresence>

        {/* 最近 5 条:永远原样保留 */}
        {Array.from({ length: KEEP_RECENT }, (_, i) => (
          <motion.div
            key={`keep-${i}`}
            layout
            transition={{ duration: reduce ? 0 : 0.3 }}
            style={{
              flex: '0 0 auto',
              width: '1.6rem',
              height: `${3.6 + ((i * 5) % 2) * 0.5}rem`,
              borderRadius: 3,
              background: 'var(--green-bg)',
              border: '1px solid var(--green-line)',
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              fontSize: '0.55rem',
              fontFamily: 'var(--mono)',
              color: 'var(--green)',
              paddingBottom: 2,
            }}
            title={`最近第 ${KEEP_RECENT - i} 条 —— 原样保留`}
          >
            {KEEP_RECENT - i}
          </motion.div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          gap: '1rem',
          marginTop: '0.6rem',
          fontSize: '0.75rem',
          color: 'var(--text-faint)',
          flexWrap: 'wrap',
        }}
      >
        <span>
          <span style={{ color: 'var(--bar-muted)' }}>■</span> 旧消息(将被摘要)
        </span>
        <span>
          <span style={{ color: 'var(--accent)' }}>■</span> 摘要
        </span>
        <span>
          <span style={{ color: 'var(--green)' }}>■</span> 最近 {KEEP_RECENT} 条(原样保留)
        </span>
      </div>

      <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', margin: '0.8rem 0 0' }}>
        {compacted
          ? `压缩后:${oldCount} 条旧消息 → 1 段摘要,后面接着最近 ${KEEP_RECENT} 条。压缩的目的只是腾空间,不是遗忘 —— 正在处理的部分必须保持原样,因为摘要会丢掉具体的行号、函数名。`
          : '压缩前:历史消息只增不减,撞墙是必然的。所以不是「满了再处理」,而是从轻到重的多道防线。'}
      </p>

      {/* 第二层:文件指针 vs 失忆 */}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: '1rem', paddingTop: '0.9rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.7rem',
            marginBottom: '0.6rem',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>压缩会不会让模型失忆?</span>
          <div className="btn-row" style={{ marginLeft: 'auto' }}>
            <button
              className={`btn btn-sm ${withPointer ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setWithPointer(true)}
              aria-pressed={withPointer}
            >
              有文件指针
            </button>
            <button
              className={`btn btn-sm ${!withPointer ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setWithPointer(false)}
              aria-pressed={!withPointer}
            >
              无文件指针
            </button>
          </div>
        </div>

        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '0.76rem',
            lineHeight: 1.9,
            background: 'var(--bg-inset)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '0.7rem 0.85rem',
            color: 'var(--text-dim)',
          }}
        >
          {withPointer ? (
            <>
              <div style={{ color: 'var(--green)' }}>✓ 历史里只放指针:</div>
              <div style={{ paddingLeft: '1rem' }}>[tool_result] auth.ts (412 行, sha 9f2c…)</div>
              <div style={{ color: 'var(--green)', marginTop: '0.5rem' }}>✓ 实际内容在会话级缓存</div>
              <div style={{ color: 'var(--green)', marginTop: '0.5rem' }}>✓ 压缩时生成「已读文件索引」</div>
              <div style={{ paddingLeft: '1rem' }}>
                → 模型需要时用 file_content 按需取回
              </div>
              <div style={{ color: 'var(--accent)', marginTop: '0.5rem' }}>
                权威数据在磁盘和缓存里,不在历史里 —— 压缩不造成信息丢失。
              </div>
            </>
          ) : (
            <>
              <div>读 auth.ts → 占空间</div>
              <div>对话变长 → 触发压缩</div>
              <div style={{ color: 'var(--red)' }}>压缩把 auth.ts 内容摘要掉 → 内容丢了</div>
              <div>模型要改这个文件 → 只好再读一遍</div>
              <div style={{ color: 'var(--red)' }}>读一遍又占空间 → 又触发压缩</div>
              <div style={{ color: 'var(--red)', marginTop: '0.5rem', fontWeight: 700 }}>
                ⟳ 死循环
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
