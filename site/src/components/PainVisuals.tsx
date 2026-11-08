import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/** §7 两段式 system prompt —— 缓存边界可视化 */
export function PromptVisual() {
  const [hover, setHover] = useState<'static' | 'dynamic' | null>(null);
  const reduce = useReducedMotion();

  const blocks = [
    {
      id: 'static' as const,
      title: '静态核心:行为准则',
      subtitle: '一字不变,可被缓存',
      items: ['没读过的文件不许改', '优先用专用工具而不是 shell', '保持回答简短', '危险操作先确认'],
      color: 'var(--accent)',
      bg: 'var(--accent-bg)',
      border: 'var(--accent-line)',
      badge: '命中缓存 ≈ 1/10 价格',
    },
    {
      id: 'dynamic' as const,
      title: '动态上下文:当前环境的快照',
      subtitle: '每次重建',
      items: ['工作目录 / 平台', 'Git 分支、未提交改动', '项目说明(CLAUDE.md)', '相关记忆、可用技能'],
      color: 'var(--green)',
      bg: 'var(--green-bg)',
      border: 'var(--green-line)',
      badge: '近因效应:末尾注意力更高',
    },
  ];

  return (
    <div>
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {blocks.map((b, i) => (
          <motion.div
            key={b.id}
            onMouseEnter={() => setHover(b.id)}
            onMouseLeave={() => setHover(null)}
            animate={{
              borderColor: hover === b.id ? b.color : b.border,
              scale: hover === b.id && !reduce ? 1.01 : 1,
            }}
            transition={{ duration: reduce ? 0 : 0.18 }}
            style={{
              border: `1px solid ${b.border}`,
              borderLeft: `3px solid ${b.color}`,
              borderRadius: 'var(--radius)',
              background: b.bg,
              padding: '0.75rem 0.9rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
              <span style={{ color: b.color, fontWeight: 650, fontSize: '0.92rem' }}>{b.title}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-faint)' }}>{b.subtitle}</span>
              <span
                className="tag"
                style={{
                  marginLeft: 'auto',
                  color: b.color,
                  borderColor: b.border,
                  background: 'transparent',
                  fontSize: '0.66rem',
                }}
              >
                {b.badge}
              </span>
            </div>
            <ul
              style={{
                margin: '0.45rem 0 0',
                paddingLeft: '1.1rem',
                fontSize: '0.83rem',
                color: 'var(--text-dim)',
              }}
            >
              {b.items.map((it) => (
                <li key={it} style={{ margin: '0.15em 0' }}>
                  {it}
                </li>
              ))}
            </ul>
            {i === 0 && (
              <div
                style={{
                  marginTop: '0.6rem',
                  fontSize: '0.7rem',
                  fontFamily: 'var(--mono)',
                  color: 'var(--text-faint)',
                  borderTop: '1px dashed var(--border-strong)',
                  paddingTop: '0.4rem',
                }}
              >
                ── 缓存边界 ── 下面一变,上面就不受影响
              </div>
            )}
          </motion.div>
        ))}
      </div>
      <p style={{ fontSize: '0.83rem', color: 'var(--text-dim)', margin: '0.8rem 0 0' }}>
        把每次都变的动态内容混在前面,缓存就永远打不中。一个长会话里,这个差别是<strong>几倍的成本差距</strong>。
      </p>
    </div>
  );
}

/** §10 子 Agent —— 上下文隔离 */
export function SubagentVisual() {
  const [run, setRun] = useState(false);
  const reduce = useReducedMotion();

  return (
    <div className="card" style={{ padding: '1.1rem' }}>
      <div className="btn-row" style={{ marginBottom: '0.9rem' }}>
        <button className="btn btn-sm btn-primary" onClick={() => setRun((v) => !v)} aria-pressed={run}>
          {run ? '↩ 重置' : '▶ 派一个子 Agent'}
        </button>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>
          {run ? '子 Agent 读了 20 个文件,主上下文仍然是空的' : '对比:自己读 vs 派子 Agent 读'}
        </span>
      </div>

      <div className="grid-2">
        {/* 主 Agent */}
        <div
          style={{
            border: '1px solid var(--accent-line)',
            borderRadius: 'var(--radius)',
            background: 'var(--accent-bg)',
            padding: '0.8rem',
          }}
        >
          <div style={{ fontSize: '0.75rem', fontFamily: 'var(--mono)', color: 'var(--accent)', marginBottom: '0.5rem' }}>
            主 Agent 上下文
          </div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-dim)', minHeight: '4.5rem' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-faint)' }}>
              user: 调研一下这个项目用了什么测试框架
            </div>
            {run && (
              <motion.div
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduce ? 0 : 0.35, delay: reduce ? 0 : 0.9 }}
                style={{ marginTop: '0.5rem', color: 'var(--green)', fontSize: '0.82rem' }}
              >
                ✓ 用 bun test,配置在 bunfig.toml
              </motion.div>
            )}
            {!run && (
              <div style={{ marginTop: '0.5rem', color: 'var(--text-faint)', fontSize: '0.78rem' }}>
                等待…
              </div>
            )}
          </div>
        </div>

        {/* 子 Agent */}
        <div
          style={{
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
            background: 'var(--bg-inset)',
            padding: '0.8rem',
            opacity: run ? 1 : 0.55,
            transition: 'opacity 0.3s',
          }}
        >
          <div
            style={{
              fontSize: '0.75rem',
              fontFamily: 'var(--mono)',
              color: 'var(--purple)',
              marginBottom: '0.5rem',
            }}
          >
            子 Agent 上下文(独立 · 读完即弃)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, minHeight: '4.5rem', alignContent: 'flex-start' }}>
            {Array.from({ length: 20 }, (_, i) => (
              <motion.div
                key={i}
                initial={reduce ? false : { opacity: 0, scale: 0.5 }}
                animate={{ opacity: run ? 1 : 0, scale: run ? 1 : 0.5 }}
                transition={{ duration: reduce ? 0 : 0.15, delay: reduce ? 0 : i * 0.04 }}
                title={`file_${i + 1}.ts`}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  background: 'var(--purple-bg)',
                  border: '1px solid var(--purple-line)',
                }}
              />
            ))}
          </div>
          {run && (
            <div style={{ fontSize: '0.7rem', color: 'var(--text-faint)', marginTop: '0.5rem' }}>
              这 20 个文件从没进过主上下文
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: '0.9rem', display: 'grid', gap: '0.4rem' }}>
        {[
          { k: '独立上下文', v: '子 Agent 的消息数组是独立的,读完即弃。主 Agent 只收到摘要。' },
          {
            k: '只读权限',
            v: '限制是在工具层面做的,不是在提示词里「请求」它别写 —— 工具面没有那个工具就是物理上做不到。',
          },
          { k: '不能嵌套自己', v: '子 Agent 的工具列表里没有「派生子 Agent」,否则无限递归直接把程序跑死。' },
        ].map((x) => (
          <div key={x.k} style={{ display: 'flex', gap: '0.6rem', fontSize: '0.83rem' }}>
            <span
              style={{
                fontFamily: 'var(--mono)',
                color: 'var(--purple)',
                flexShrink: 0,
                fontSize: '0.76rem',
                paddingTop: 2,
              }}
            >
              {x.k}
            </span>
            <span style={{ color: 'var(--text-dim)' }}>{x.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** §11 事件流 —— 同一内核,三种消费者 */
export function EventsVisual() {
  const [consumer, setConsumer] = useState<'tui' | 'json' | 'pipe'>('tui');

  const events = [
    { t: 'thinking', d: '开始思考' },
    { t: 'tool_start', d: '工具 A 开始执行' },
    { t: 'tool_result', d: '工具 A 完成,输出 …' },
    { t: 'message_end', d: '模型回复完毕' },
  ];

  const renders: Record<typeof consumer, (e: (typeof events)[number]) => React.ReactNode> = {
    tui: (e) => (
      <span style={{ color: e.t === 'tool_result' ? 'var(--green)' : 'var(--accent)' }}>
        {e.t === 'thinking' ? '⠋ ' : '▸ '}
        {e.d}
      </span>
    ),
    json: (e) => (
      <span style={{ color: 'var(--amber)', fontFamily: 'var(--mono)' }}>
        {`{"type":"${e.t}"}`}
      </span>
    ),
    pipe: (e) => <span style={{ color: 'var(--text-dim)' }}>{e.d}</span>,
  };

  return (
    <div className="card" style={{ padding: '1.1rem' }}>
      <div className="btn-row" style={{ marginBottom: '0.8rem' }}>
        {[
          { id: 'tui' as const, label: '交互式终端' },
          { id: 'json' as const, label: '--output-format json' },
          { id: 'pipe' as const, label: '管道 / 非 TTY' },
        ].map((c) => (
          <button
            key={c.id}
            className={`btn btn-sm ${consumer === c.id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setConsumer(c.id)}
            aria-pressed={consumer === c.id}
            style={{ fontFamily: c.id === 'json' ? 'var(--mono)' : undefined }}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: '0.79rem',
          background: 'var(--bg-inset)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '0.75rem 0.9rem',
          lineHeight: 1.9,
          minHeight: '7rem',
        }}
      >
        <div style={{ color: 'var(--text-faint)', fontSize: '0.7rem', marginBottom: '0.3rem' }}>
          核心循环发出的事件 →
        </div>
        {events.map((e) => (
          <div key={e.t}>{renders[consumer](e)}</div>
        ))}
      </div>

      <p style={{ fontSize: '0.83rem', color: 'var(--text-dim)', margin: '0.75rem 0 0' }}>
        核心循环完全不知道 UI 长什么样。隐藏好处:如果核心循环自己打印 UI,它就没法在测试里跑了 ——
        事件流让核心逻辑可以脱离终端被完整测试。
      </p>
    </div>
  );
}

/** §12 目标评估器 —— 独立判断 + impossible 刹车 */
export function GoalVisual() {
  const [attempt, setAttempt] = useState(0);
  const scenarios = [
    { verdict: 'not_met', reason: 'auth.test.ts 还有 1 个失败', next: '带着这个原因继续干' },
    { verdict: 'not_met', reason: '还有 2 个测试失败', next: '继续修' },
    { verdict: 'met', reason: '全部测试通过', next: '循环停止,交付' },
  ];
  const cur = scenarios[Math.min(attempt, scenarios.length - 1)]!;
  const finished = attempt >= scenarios.length - 1;

  return (
    <div className="card" style={{ padding: '1.1rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setAttempt((a) => Math.min(a + 1, scenarios.length - 1))}
          disabled={finished}
        >
          评估一轮 →
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setAttempt(0)} disabled={attempt === 0}>
          ⟲ 重置
        </button>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)', alignSelf: 'center' }}>
          <code>--goal "测试全通过"</code>
        </span>
      </div>

      <div style={{ display: 'grid', gap: '0.5rem' }}>
        <div
          style={{
            border: '1px solid var(--accent-line)',
            borderLeft: '3px solid var(--accent)',
            borderRadius: 'var(--radius)',
            background: 'var(--accent-bg)',
            padding: '0.65rem 0.85rem',
            fontSize: '0.84rem',
          }}
        >
          <span style={{ color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: '0.72rem' }}>
            主 Agent
          </span>
          <div style={{ color: 'var(--text-dim)' }}>干完了一轮活,交出结果</div>
        </div>

        <div style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: '0.8rem' }}>↓</div>

        <motion.div
          key={attempt}
          initial={{ opacity: 0.5 }}
          animate={{ opacity: 1 }}
          style={{
            border: '1px solid var(--amber-line)',
            borderLeft: '3px solid var(--amber)',
            borderRadius: 'var(--radius)',
            background: 'var(--amber-bg)',
            padding: '0.65rem 0.85rem',
            fontSize: '0.84rem',
          }}
        >
          <span style={{ color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: '0.72rem' }}>
            独立评估器(另起一次模型调用)
          </span>
          <div style={{ color: 'var(--text-dim)', marginTop: 2 }}>
            条件是「测试全通过」→{' '}
            <strong style={{ color: cur.verdict === 'met' ? 'var(--green)' : 'var(--red)' }}>
              {cur.verdict}
            </strong>
            ,{cur.reason}
          </div>
        </motion.div>

        <div style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: '0.8rem' }}>↓</div>

        <div
          style={{
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
            background: 'var(--bg-inset)',
            padding: '0.65rem 0.85rem',
            fontSize: '0.84rem',
            color: finished ? 'var(--green)' : 'var(--text-dim)',
          }}
        >
          {cur.next}
        </div>
      </div>

      <div className="callout callout-warn" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
        <span className="callout-title">死循环刹车</span>
        <p style={{ margin: 0 }}>
          如果评估器发现条件<strong>永远不可能达成</strong>(比如条件是「让这个文件不存在但同时保留内容」),它会返回{' '}
          <code>impossible</code>,主循环停止。没有这个刹车,无人值守模式会一直烧钱。
        </p>
      </div>
    </div>
  );
}

/** §13 中断 —— 三件事同时做 */
export function AbortVisual() {
  const [aborted, setAborted] = useState(false);

  const targets = [
    { label: '正在飞的 HTTP 请求', action: 'cancel', detail: 'fetch AbortSignal 触发' },
    { label: 'run_shell 的子进程', action: 'kill', detail: '进程组整体终止' },
    { label: '重试退避的等待', action: 'wake', detail: '否则按了 Esc 还在傻等 2 分钟' },
  ];

  return (
    <div className="card" style={{ padding: '1.1rem' }}>
      <div className="btn-row" style={{ marginBottom: '0.9rem', alignItems: 'center' }}>
        <button
          className="btn btn-sm"
          onClick={() => setAborted((v) => !v)}
          style={{
            borderColor: aborted ? 'var(--green)' : 'var(--red)',
            color: aborted ? 'var(--green)' : 'var(--red)',
          }}
          aria-pressed={aborted}
        >
          {aborted ? '✓ 已中断(点此恢复)' : '⎋ 按 Esc'}
        </button>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>
          {aborted ? '三处阻塞点同时返回' : '一个 5 分钟的命令正在跑'}
        </span>
      </div>

      <div style={{ display: 'grid', gap: '0.45rem' }}>
        {targets.map((t, i) => (
          <div
            key={t.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.7rem',
              padding: '0.55rem 0.8rem',
              borderRadius: 'var(--radius)',
              border: `1px solid ${aborted ? 'var(--green-line)' : 'var(--border)'}`,
              background: aborted ? 'var(--green-bg)' : 'var(--bg-inset)',
              transition: 'all 0.3s',
              transitionDelay: `${i * 90}ms`,
              fontSize: '0.84rem',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--mono)',
                color: aborted ? 'var(--green)' : 'var(--text-faint)',
                fontSize: '0.78rem',
                width: '1.3rem',
              }}
            >
              {aborted ? '✓' : '◌'}
            </span>
            <span style={{ color: aborted ? 'var(--text)' : 'var(--text-dim)' }}>{t.label}</span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: '0.72rem',
                color: 'var(--text-faint)',
                fontFamily: 'var(--mono)',
              }}
            >
              {aborted ? t.detail : '—'}
            </span>
          </div>
        ))}
      </div>

      <p style={{ fontSize: '0.83rem', color: 'var(--text-dim)', margin: '0.8rem 0 0' }}>
        <strong>AbortSignal 贯穿全链路。</strong>最容易忽略的是第三条:重试的等待也必须响应中断 ——
        否则「按了没反应」。
      </p>
    </div>
  );
}

/** §9 检查点 —— 逆序还原 */
export function CheckpointVisual() {
  const [rewound, setRewound] = useState(false);

  const edits = [
    { n: 1, file: 'auth.ts', change: 'verify() 边界判断' },
    { n: 2, file: 'auth.ts', change: '导出新函数' },
    { n: 3, file: 'session.ts', change: 'token 刷新逻辑' },
    { n: 4, file: 'auth.ts', change: '错误信息文案' },
  ];

  return (
    <div className="card" style={{ padding: '1.1rem' }}>
      <div className="btn-row" style={{ marginBottom: '0.9rem' }}>
        <button className="btn btn-sm btn-primary" onClick={() => setRewound((v) => !v)} aria-pressed={rewound}>
          {rewound ? '↩ 回到改动后' : '/rewind 还原'}
        </button>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>
          按逆序还原 —— 先改的后还原
        </span>
      </div>

      <div style={{ display: 'grid', gap: '0.35rem' }}>
        {edits.map((e) => {
          const order = rewound ? edits.length - e.n + 1 : e.n;
          const active = rewound && order <= 2;
          return (
            <div
              key={e.n}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.65rem',
                padding: '0.5rem 0.75rem',
                borderRadius: 'var(--radius)',
                border: `1px solid ${active ? 'var(--green-line)' : 'var(--border)'}`,
                background: active ? 'var(--green-bg)' : 'var(--bg-inset)',
                transition: 'all 0.3s',
                fontSize: '0.84rem',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: '0.7rem',
                  color: active ? 'var(--green)' : 'var(--text-faint)',
                  border: '1px solid currentColor',
                  borderRadius: 3,
                  padding: '0 0.3em',
                  flexShrink: 0,
                }}
              >
                #{order}
              </span>
              <code style={{ fontSize: '0.78rem' }}>{e.file}</code>
              <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>{e.change}</span>
              {rewound && (
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: '0.7rem',
                    color: 'var(--green)',
                    fontFamily: 'var(--mono)',
                  }}
                >
                  已还原
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="callout" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
        <p style={{ margin: 0, fontSize: '0.85rem' }}>
          <code>auth.ts</code> 被改了 3 次,但<b>只记录最早的那一次</b> —— 因为你要回退的是「这轮会话开始前的状态」,
          不是中间某个状态。检查点只在内存里:只服务当前会话,退出即失效,避免磁盘堆满没人清理的备份。
        </p>
      </div>
    </div>
  );
}
