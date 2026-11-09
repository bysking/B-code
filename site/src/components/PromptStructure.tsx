import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/**
 * 两段式 system prompt —— 把「静态核心 / 动态上下文」的边界与代价讲清。
 *
 * 想表达的三件事,按重要性递减:
 *   1. 边界在哪:静态核心跨会话逐字不变,动态部分每次重建
 *   2. 为什么这么切:大模型对「完全相同的前缀」有缓存折扣
 *   3. 为什么动态放最后:近因效应,末尾注意力更高
 *
 * 用一个开关直接展示「顺序错了会怎样」,比一段说明更能说服人。
 */

const STATIC_ITEMS = [
  { text: '没读过的文件不许改', why: '防止凭记忆瞎改 —— 这是最常见的事故' },
  { text: '优先用专用工具而不是 shell', why: '专用工具有权限边界,shell 没有' },
  { text: '保持回答简短', why: '省 token,也省读者时间' },
  { text: '危险操作先确认', why: '与权限系统呼应:提示层先提醒,硬边界在代码里' },
];

const DYNAMIC_ITEMS = [
  { text: '工作目录 / 平台', why: '决定路径写法和可用命令' },
  { text: 'Git 分支、未提交改动', why: '避免把别人的改动当自己的' },
  { text: '项目说明(CLAUDE.md)', why: '项目特有约定,每次都要最新' },
  { text: '相关记忆、可用技能', why: '按当前话题召回,天然每次都变' },
];

export function PromptStructure() {
  const [wrongOrder, setWrongOrder] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const reduce = useReducedMotion();

  const blocks = wrongOrder
    ? [
        { key: 'dyn', kind: 'dynamic' as const },
        { key: 'stat', kind: 'static' as const },
      ]
    : [
        { key: 'stat', kind: 'static' as const },
        { key: 'dyn', kind: 'dynamic' as const },
      ];

  return (
    <div>
      {/* 开关:正确顺序 vs 错误顺序 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.7rem',
          marginBottom: '0.9rem',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: '0.84rem', color: 'var(--text-dim)' }}>
          拼装顺序:
        </span>
        <div className="btn-row">
          <button
            className={`btn btn-sm ${!wrongOrder ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setWrongOrder(false)}
            aria-pressed={!wrongOrder}
          >
            静态在前(实际做法)
          </button>
          <button
            className={`btn btn-sm ${wrongOrder ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setWrongOrder(true)}
            aria-pressed={wrongOrder}
          >
            动态在前(反例)
          </button>
        </div>
      </div>

      {/* 两段拼装 */}
      <div style={{ display: 'grid', gap: '0.4rem' }}>
        {blocks.map((b, i) => {
          const isStatic = b.kind === 'static';
          const items = isStatic ? STATIC_ITEMS : DYNAMIC_ITEMS;
          const c = isStatic
            ? { fg: 'var(--accent-text)', bg: 'var(--accent-bg)', line: 'var(--accent-line)' }
            : { fg: 'var(--green)', bg: 'var(--green-bg)', line: 'var(--green-line)' };

          return (
            <motion.div
              key={b.key}
              layout={!reduce}
              transition={{ duration: reduce ? 0 : 0.3, ease: [0.4, 0, 0.2, 1] }}
              style={{
                border: `1px solid ${c.line}`,
                borderLeft: `3px solid ${c.fg}`,
                background: c.bg,
                borderRadius: 'var(--radius)',
                padding: '0.7rem 0.9rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '0.6rem',
                  flexWrap: 'wrap',
                  marginBottom: '0.5rem',
                }}
              >
                <span style={{ color: c.fg, fontWeight: 650, fontSize: '0.88rem' }}>
                  {isStatic ? '静态核心:行为准则' : '动态上下文:当前环境快照'}
                </span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>
                  {isStatic ? '跨会话一字不变' : '每次重建'}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontFamily: 'var(--mono)',
                    fontSize: '0.66rem',
                    padding: '0.05em 0.5em',
                    borderRadius: 999,
                    border: `1px solid ${c.line}`,
                    color: c.fg,
                    background: 'var(--bg-raised)',
                  }}
                >
                  {isStatic ? '第 ' + (i + 1) + ' 段 · 可缓存' : '第 ' + (i + 1) + ' 段 · 不可缓存'}
                </span>
              </div>

              <div style={{ display: 'grid', gap: '0.2rem' }}>
                {items.map((it) => {
                  const on = hovered === `${b.kind}-${it.text}`;
                  return (
                    <div
                      key={it.text}
                      onMouseEnter={() => setHovered(`${b.kind}-${it.text}`)}
                      onMouseLeave={() => setHovered(null)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 15rem) minmax(0, 1fr)',
                        gap: '0.7rem',
                        alignItems: 'baseline',
                        padding: '0.12rem 0.3rem',
                        borderRadius: 4,
                        background: on ? 'rgba(255,255,255,0.7)' : 'transparent',
                        transition: reduce ? 'none' : 'background 0.15s',
                      }}
                    >
                      <span style={{ fontSize: '0.82rem', color: 'var(--text)' }}>{it.text}</span>
                      <span style={{ fontSize: '0.76rem', color: 'var(--text-faint)' }}>{it.why}</span>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* 缓存边界 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          margin: '0.55rem 0 0',
          fontFamily: 'var(--mono)',
          fontSize: '0.68rem',
          color: wrongOrder ? 'var(--red)' : 'var(--text-faint)',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            flex: 1,
            borderTop: `1px ${wrongOrder ? 'dashed' : 'solid'} ${
              wrongOrder ? 'var(--red-line)' : 'var(--border-strong)'
            }`,
          }}
        />
        <span style={{ whiteSpace: 'nowrap' }}>
          {wrongOrder ? '↑ 缓存边界被冲掉了' : '↑ 缓存边界:上面的内容可以整段复用'}
        </span>
        <span
          aria-hidden="true"
          style={{ flex: 1, borderTop: '1px solid var(--border-strong)' }}
        />
      </div>

      {/* 结论:成本差 */}
      <motion.div
        animate={{
          background: wrongOrder ? 'var(--red-bg)' : 'var(--green-bg)',
          borderColor: wrongOrder ? 'var(--red-line)' : 'var(--green-line)',
        }}
        transition={{ duration: reduce ? 0 : 0.25 }}
        style={{
          marginTop: '0.9rem',
          border: '1px solid',
          borderRadius: 8,
          padding: '0.65rem 0.85rem',
        }}
      >
        {wrongOrder ? (
          <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-dim)', lineHeight: 1.7 }}>
            <b style={{ color: 'var(--red)' }}>缓存永远打不中。</b>
            因为每次请求的第一个 token 就不一样,后面再相同也没用 ——
            整段 prompt 都按全价计费。一个长会话里,这个差别是
            <b style={{ color: 'var(--text)' }}>几倍的成本</b>。
          </p>
        ) : (
          <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-dim)', lineHeight: 1.7 }}>
            <b style={{ color: 'var(--green)' }}>静态核心命中缓存,只按约 1/10 价格计费。</b>
            而且动态内容放在最后还白赚一个好处 ——
            <b style={{ color: 'var(--text)' }}>近因效应</b>:模型对末尾内容的注意力更高,
            最新的环境信息、记忆、技能对当轮决策影响更大。
          </p>
        )}
      </motion.div>

      <p
        style={{
          fontSize: '0.78rem',
          color: 'var(--text-faint)',
          margin: '0.7rem 0 0',
          paddingLeft: '0.7rem',
          borderLeft: '2px solid var(--border-strong)',
        }}
      >
        顺便回答一个常见疑问:<b>这些准则会不会被工具调用挤掉?</b> 不会 ——
        system prompt 在每次请求里都完整重发,不占「对话历史」的位置;
        它也是唯一跨轮次逐字不变的部分,所以最值得为它做缓存优化。
      </p>
    </div>
  );
}
