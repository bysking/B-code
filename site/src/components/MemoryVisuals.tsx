import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { MEMORY_DEMO, MEMORY_STORAGE } from '../content/knowledge';

/**
 * 持久化记忆可视化 —— 一个组件讲完整条链路:
 *   它存在哪(路径 + 项目隔离)、怎么写进去(工具 + 确认)、怎么读出来(召回 + 注入)。
 *
 * 三次会话切换不是为了炫技,而是因为「跨会话」这件事没法在一屏里说清 ——
 * 不切一次,读者看不到记忆是怎么跨过进程边界的。
 *
 * 演示里的路径用固定哈希 `a1b2c3d4e5f60718`,不用真实 cwd 算 —— 读者的
 * 工作目录跟这里无关,写死了反而少一个「这个数怎么来的」的疑问。
 */

const DEMO_KEY = 'a1b2c3d4e5f60718';

/** 把 MEMORY_STORAGE.layout 里的占位符换成演示路径 */
const DEMO_FILE = `${MEMORY_STORAGE.root}/projects/${DEMO_KEY}/memory/包管理器用_pnpm.md`;

// ══════════════════════════════════════════════════════════════
// ① 生命周期:两栏对照 —— 会话 1 写进去,会话 2 读出来
// ══════════════════════════════════════════════════════════════

type Session = 'session1' | 'session2' | 'session3';

export function MemoryLifecycle() {
  const [session, setSession] = useState<Session>('session1');
  const s = MEMORY_DEMO;

  return (
    <div
      style={{
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--bg-raised)',
        overflow: 'hidden',
      }}
    >
      {/* 会话切换:三次会话 = 一次完整的跨进程往返 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          flexWrap: 'wrap',
          padding: '0.7rem 0.95rem',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-subtle)',
        }}
      >
        {[
          { id: 'session1' as const, label: '① 会话 1 · 写', hint: '它学到一个事实' },
          { id: 'session2' as const, label: '② 会话 2 · 读', hint: '新进程,它还记得' },
          { id: 'session3' as const, label: '③ 换目录 · 隔离', hint: '记忆不串' },
        ].map((t) => (
          <button
            key={t.id}
            className={`btn btn-sm ${session === t.id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSession(t.id)}
            aria-pressed={session === t.id}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: '0.76rem', color: 'var(--text-faint)' }}>
          {s[session].label}
        </span>
      </div>

      {/* 磁盘:三次会话都看得见的那一格 —— 它才是「跨会话」的物理载体 */}
      <div
        style={{
          padding: '0.7rem 0.95rem',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-inset)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            flexWrap: 'wrap',
            fontFamily: 'var(--mono)',
            fontSize: '0.72rem',
          }}
        >
          <span style={{ color: 'var(--purple)' }}>磁盘</span>
          <span style={{ color: 'var(--text-faint)' }}>{DEMO_FILE}</span>
          <span
            className="tag"
            style={{
              fontSize: '0.62rem',
              color: session === 'session1' ? 'var(--green)' : 'var(--text-faint)',
              borderColor: session === 'session1' ? 'var(--green-line)' : 'var(--border)',
              background: 'transparent',
            }}
          >
            {session === 'session1' ? '← 刚落盘' : session === 'session3' ? '(不在这里)' : '已存在'}
          </span>
        </div>
      </div>

      <div style={{ padding: '0.9rem 0.95rem' }}>
        {session === 'session1' && <Session1 />}
        {session === 'session2' && <Session2 />}
        {session === 'session3' && (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '0.72rem',
                color: 'var(--amber)',
                marginBottom: '0.45rem',
              }}
            >
              记忆目录换了 —— 项目键是 cwd 的哈希,不是仓库名
            </div>
            <div
              style={{
                background: 'var(--bg-inset)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '0.6rem 0.8rem',
                fontFamily: 'var(--mono)',
                fontSize: '0.74rem',
                lineHeight: 1.9,
              }}
            >
              <div style={{ color: 'var(--text-faint)' }}>~/work/myapp → sha256 → {DEMO_KEY}</div>
              <div style={{ color: 'var(--text-faint)' }}>
                ~/tmp/myapp-clone → sha256 → <span style={{ color: 'var(--amber)' }}>9f8e7d6c5b4a3210</span>
              </div>
            </div>
            <p style={{ margin: '0.7rem 0 0', fontSize: '0.84rem' }}>
              {s.session3.note} —— {s.session3.outcome}
            </p>
            <p style={{ margin: '0.45rem 0 0', fontSize: '0.8rem', color: 'var(--text-faint)' }}>
              {MEMORY_STORAGE.note}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** 会话 1:模型调 save_memory → 走确认 → 落盘 */
function Session1() {
  const [confirmed, setConfirmed] = useState(false);
  const reduce = useReducedMotion();
  const s = MEMORY_DEMO.session1;

  return (
    <div style={{ display: 'grid', gap: '0.55rem' }}>
      {s.turns.map((t, i) => (
        <motion.div
          key={i}
          initial={reduce ? false : { opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: reduce ? 0 : 0.2, delay: reduce ? 0 : i * 0.06 }}
          style={{
            borderLeft: `2px solid ${t.role === 'user' ? 'var(--border-strong)' : 'var(--accent-line)'}`,
            paddingLeft: '0.7rem',
            fontSize: '0.84rem',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '0.66rem',
              display: 'block',
              color: t.role === 'user' ? 'var(--text)' : 'var(--accent-text)',
            }}
          >
            {t.role}
          </span>
          <span style={{ color: 'var(--text-dim)' }}>{t.text}</span>
        </motion.div>
      ))}

      {/* 工具调用 + 确认 */}
      <div
        style={{
          border: `1px solid ${confirmed ? 'var(--green-line)' : 'var(--amber-line)'}`,
          background: confirmed ? 'var(--green-bg)' : 'var(--amber-bg)',
          borderRadius: 'var(--radius)',
          padding: '0.6rem 0.8rem',
          transition: 'all 0.25s',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            flexWrap: 'wrap',
            marginBottom: '0.35rem',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '0.72rem',
              color: confirmed ? 'var(--green)' : 'var(--amber)',
              fontWeight: 650,
            }}
          >
            tool_use · {s.call.tool}
          </span>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{s.confirm}</span>
          <button
            className={`btn btn-sm ${confirmed ? 'btn-ghost' : 'btn-primary'}`}
            onClick={() => setConfirmed((v) => !v)}
            style={{ marginLeft: 'auto' }}
            aria-pressed={confirmed}
          >
            {confirmed ? '↩ 撤销' : '✓ 确认写入'}
          </button>
        </div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '0.72rem',
            color: 'var(--text-dim)',
            wordBreak: 'break-all',
          }}
        >
          {s.call.input}
        </div>
      </div>

      {confirmed && (
        <motion.div
          initial={reduce ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          style={{ fontSize: '0.8rem', color: 'var(--green)', fontFamily: 'var(--mono)' }}
        >
          → 落盘 {DEMO_FILE}
        </motion.div>
      )}
    </div>
  );
}

/** 会话 2:新一轮 chat 的入口召回 → 拼进 system prompt 末尾 */
function Session2() {
  const reduce = useReducedMotion();
  const s = MEMORY_DEMO.session2;

  return (
    <div style={{ display: 'grid', gap: '0.55rem' }}>
      <div style={{ fontSize: '0.84rem', color: 'var(--text-dim)' }}>
        <span
          style={{ fontFamily: 'var(--mono)', fontSize: '0.66rem', display: 'block', color: 'var(--text)' }}
        >
          user
        </span>
        {s.query}
      </div>

      {/* 召回:发生在循环外,以用户这轮输入为 query */}
      <motion.div
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        style={{
          border: '1px solid var(--purple-line)',
          background: 'var(--purple-bg)',
          borderRadius: 'var(--radius)',
          padding: '0.6rem 0.8rem',
          fontSize: '0.82rem',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '0.68rem',
            color: 'var(--purple)',
            marginBottom: '0.3rem',
          }}
        >
          chat() 入口 · recallMemories(query)
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: '0.79rem' }}>{s.hit}</div>
      </motion.div>

      {/* 注入位置:画在 system prompt 里的相对位置,而不是孤立一行 */}
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduce ? 0 : 0.25, delay: reduce ? 0 : 0.15 }}
        style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
          fontFamily: 'var(--mono)',
          fontSize: '0.74rem',
        }}
      >
        <div style={{ background: 'var(--bg-inset)', padding: '0.35rem 0.7rem', color: 'var(--text-faint)' }}>
          system prompt
        </div>
        <div style={{ padding: '0.5rem 0.7rem', color: 'var(--text-faint)', lineHeight: 1.8 }}>
          静态核心(一字不变,可被缓存)
        </div>
        <div
          style={{
            padding: '0.5rem 0.7rem',
            color: 'var(--text-faint)',
            borderTop: '1px dashed var(--border)',
            lineHeight: 1.8,
          }}
        >
          动态上下文:工作目录 / git 状态 / 技能…
        </div>
        <div
          style={{
            padding: '0.5rem 0.7rem',
            borderTop: '1px solid var(--purple-line)',
            background: 'var(--purple-bg)',
            color: 'var(--purple)',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.8,
          }}
        >
          {s.injected}
          <div style={{ color: 'var(--text-faint)', fontSize: '0.68rem', marginTop: '0.2rem' }}>
            ↑ 追加在动态块最末尾:近因效应让模型优先看到它
          </div>
        </div>
      </motion.div>

      <motion.div
        initial={reduce ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduce ? 0 : 0.25, delay: reduce ? 0 : 0.3 }}
        style={{
          borderLeft: '2px solid var(--green-line)',
          paddingLeft: '0.7rem',
          fontSize: '0.84rem',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '0.66rem',
            display: 'block',
            color: 'var(--green)',
          }}
        >
          assistant
        </span>
        <span style={{ color: 'var(--text-dim)' }}>{s.outcome}</span>
      </motion.div>
    </div>
  );
}
