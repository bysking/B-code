import { motion, useReducedMotion } from 'motion/react';
import { PERM_DECISION_CHAIN } from '../content/knowledge';

/**
 * 结构示意图集合 —— 用图形替代大段说明文字。
 *
 * 原则:图只表达原文已有的结构关系,不引入新事实。
 * 所有颜色走 global.css 的 token,无硬编码色值。
 */

/** 公共:方框节点 */
function Node({
  children,
  tone = 'neutral',
  small,
  style,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'green' | 'amber' | 'red' | 'purple';
  small?: boolean;
  style?: React.CSSProperties;
}) {
  const map = {
    neutral: { bg: 'var(--bg-subtle)', line: 'var(--border-strong)', fg: 'var(--text)' },
    accent: { bg: 'var(--accent-bg)', line: 'var(--accent-line)', fg: 'var(--accent-text)' },
    green: { bg: 'var(--green-bg)', line: 'var(--green-line)', fg: 'var(--green)' },
    amber: { bg: 'var(--amber-bg)', line: 'var(--amber-line)', fg: 'var(--amber)' },
    red: { bg: 'var(--red-bg)', line: 'var(--red-line)', fg: 'var(--red)' },
    purple: { bg: 'var(--purple-bg)', line: 'var(--purple-line)', fg: 'var(--purple)' },
  }[tone];

  return (
    <div
      style={{
        background: map.bg,
        border: `1px solid ${map.line}`,
        borderRadius: 8,
        padding: small ? '0.4rem 0.6rem' : '0.6rem 0.8rem',
        color: map.fg,
        fontSize: small ? '0.76rem' : '0.82rem',
        fontFamily: 'var(--mono)',
        textAlign: 'center',
        lineHeight: 1.5,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** 竖线连接器 */
function VLine({ h = 18, color = 'var(--border-strong)' }: { h?: number; color?: string }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 1,
        height: h,
        background: color,
        margin: '0 auto',
      }}
    />
  );
}

/* ── §2 三样东西:循环 + 三个插槽 ────────────────────────────── */

export function AssemblyDiagram() {
  return (
    <div style={{ padding: '0.4rem 0' }}>
      <Node tone="accent" style={{ maxWidth: '22rem', margin: '0 auto' }}>
        while (true) —— 主循环
      </Node>
      <VLine h={16} />
      <div
        style={{
          maxWidth: '34rem',
          margin: '0 auto',
          height: 16,
          borderTop: '1px solid var(--border-strong)',
          borderLeft: '1px solid var(--border-strong)',
          borderRight: '1px solid var(--border-strong)',
          borderRadius: '4px 4px 0 0',
        }}
        aria-hidden="true"
      />
      <div className="grid-3" style={{ marginTop: -1 }}>
        {[
          { code: '模型(...)', q: '怎么跟大模型说话?', mod: '后端层', tone: 'purple' as const },
          { code: '可用工具清单', q: '怎么告诉它能干什么?', mod: '工具系统', tone: 'green' as const },
          { code: '执行工具(...)', q: '怎么保证安全?', mod: '权限系统', tone: 'red' as const },
        ].map((x) => (
          <div key={x.code}>
            {/* <VLine h={14} /> */}
            <Node tone={x.tone} small>
              <div>{x.code}</div>
              <div style={{ color: 'var(--text-dim)', fontSize: '0.7rem', marginTop: 2 }}>{x.q}</div>
              <div style={{ marginTop: 4, fontSize: '0.7rem', fontWeight: 600 }}>→ {x.mod}</div>
            </Node>
          </div>
        ))}
      </div>
      <p
        style={{
          fontSize: '0.78rem',
          color: 'var(--text-faint)',
          textAlign: 'center',
          margin: '0.9rem 0 0',
        }}
      >
        伪代码引用了三个还不存在的东西 —— 每个都对应一个模块
      </p>
    </div>
  );
}

/* ── §3 后端:统一形状 + 边界翻译 ────────────────────────────── */

export function BackendBoundaryDiagram() {
  const reduce = useReducedMotion();
  return (
    <div style={{ marginBottom: '1.2rem' }}>
      <Node tone="accent" style={{ maxWidth: '26rem', margin: '0 auto' }}>
        Agent 循环 —— 只认 Anthropic 消息格式
      </Node>
      <VLine h={14} />

      <motion.div
        initial={reduce ? false : { opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        style={{
          border: '1px dashed var(--accent-line)',
          background: 'var(--accent-bg)',
          borderRadius: 8,
          padding: '0.3rem 0.6rem',
          maxWidth: '26rem',
          margin: '0 auto',
          textAlign: 'center',
          fontSize: '0.72rem',
          fontFamily: 'var(--mono)',
          color: 'var(--accent-text)',
        }}
      >
        大模型消息适配层（边界 · 格式翻译只发生在这里）
      </motion.div>

      {/* <VLine h={14} /> */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))',
          gap: '0.8rem',
          maxWidth: '34rem',
          margin: '0 auto',
        }}
      >
        <div>
          <div
            style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: '0.8rem', marginBottom: 4 }}
          >
            ↙
          </div>
          <Node tone="green" small>
            <div>Anthropic 后端</div>
            <div style={{ fontSize: '0.7rem', opacity: 0.85, marginTop: 2 }}>原样发送</div>
          </Node>
        </div>
        <div>
          <div
            style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: '0.8rem', marginBottom: 4 }}
          >
            ↘
          </div>
          <Node tone="purple" small>
            <div>OpenAI 兼容后端</div>
            <div style={{ fontSize: '0.7rem', opacity: 0.85, marginTop: 2 }}>toOpenAIMessages()</div>
          </Node>
        </div>
      </div>
      <p
        style={{
          fontSize: '0.78rem',
          color: 'var(--text-faint)',
          textAlign: 'center',
          margin: '0.9rem 0 0',
        }}
      >
        循环不知道后端是谁 —— 加第三个后端不用碰循环一行代码
      </p>
    </div>
  );
}

/* ── §4 工具:一个注册表,两来源 ─────────────────────────────── */

export function RegistryDiagram() {
  return (
    <div style={{ marginBottom: '1.2rem' }}>
      <Node tone="accent" style={{ maxWidth: '28rem', margin: '0 auto' }}>
        <div>注册表 Registry</div>
        <div style={{ fontSize: '0.7rem', opacity: 0.85, marginTop: 2 }}>
          每条 = {'{ name, schema, 执行函数 }'}
        </div>
      </Node>
      <VLine h={16} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 13rem), 1fr))',
          gap: '0.8rem',
          maxWidth: '32rem',
          margin: '0 auto',
        }}
      >
        <Node tone="green" small>
          <div>内置工具 · 13 个</div>
          <div style={{ fontSize: '0.68rem', opacity: 0.85, marginTop: 2 }}>read_file …</div>
        </Node>
        <Node tone="purple" small>
          <div>MCP 工具 · 任意个</div>
          <div style={{ fontSize: '0.68rem', opacity: 0.85, marginTop: 2 }}>mcp__github__create_issue</div>
        </Node>
      </div>
      <div
        style={{
          margin: '0.7rem auto 0',
          maxWidth: '32rem',
          textAlign: 'center',
          fontSize: '0.76rem',
          color: 'var(--text-dim)',
          border: '1px dashed var(--border-strong)',
          borderRadius: 6,
          padding: '0.35rem 0.6rem',
          background: 'var(--bg-subtle)',
        }}
      >
        对循环来说两者<b>没有区别</b> —— 都挂在同一张表里
      </div>
    </div>
  );
}

/* ── §4 上下文防御漏斗 ──────────────────────────────────────── */

export function ContextFunnel() {
  // 三层是同一条流水线上依次生效的防线,不是递进缩小的量。
  // 用等高面板 + 顺序箭头表达「依次过滤」,避免宽度暗示虚假的数量关系。
  const tiers = [
    {
      tag: '触发',
      title: '工具返回超大结果',
      text: 'cat 一个 10 万行日志 —— 原样进历史,单次吃掉大半窗口',
      tone: 'neutral' as const,
    },
    {
      tag: '第 0 层',
      title: '截断',
      text: '单条 > 5 万字符 → 保留头尾,中间标省略',
      tone: 'red' as const,
    },
    {
      tag: '第 1 层',
      title: '指针化',
      text: '同一文件重复读 → 只返 路径 + 行数 + hash',
      tone: 'amber' as const,
    },
    {
      tag: '第 2 层',
      title: '压缩',
      text: '超 45 条 或 40% 预算 → 旧消息摘要成一段',
      tone: 'green' as const,
    },
  ];

  const theme = {
    neutral: { bg: 'var(--bg-subtle)', line: 'var(--border-strong)', fg: 'var(--text-dim)' },
    red: { bg: 'var(--red-bg)', line: 'var(--red-line)', fg: 'var(--red)' },
    amber: { bg: 'var(--amber-bg)', line: 'var(--amber-line)', fg: 'var(--amber)' },
    green: { bg: 'var(--green-bg)', line: 'var(--green-line)', fg: 'var(--green)' },
  };

  return (
    <div style={{ margin: '0 0 1.2rem' }}>
      {tiers.map((t, i) => {
        const c = theme[t.tone];
        return (
          <div key={t.tag}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '4.2rem minmax(0, 1fr)',
                alignItems: 'stretch',
                border: `1px solid ${c.line}`,
                background: c.bg,
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  color: c.fg,
                  padding: '0.5rem 0.4rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRight: `1px solid ${c.line}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {t.tag}
              </div>
              <div style={{ padding: '0.45rem 0.7rem' }}>
                <div style={{ fontSize: '0.83rem', fontWeight: 600, color: 'var(--text)' }}>{t.title}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>{t.text}</div>
              </div>
            </div>
            {i < tiers.length - 1 && (
              <div
                aria-hidden="true"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: 16,
                  color: 'var(--text-faint)',
                  fontSize: '0.66rem',
                  fontFamily: 'var(--mono)',
                  gap: 4,
                }}
              >
                ▼ 依次生效
              </div>
            )}
          </div>
        );
      })}
      <p
        style={{
          fontSize: '0.78rem',
          color: 'var(--text-faint)',
          margin: '0.7rem 0 0',
          paddingLeft: '0.7rem',
          borderLeft: '2px solid var(--accent)',
        }}
      >
        最后进入历史的只有必要信息 —— 权威数据留在磁盘和缓存里,不在历史里。
      </p>
    </div>
  );
}

/* ── §5 权限判定流程图(可联动模拟器) ────────────────────────── */

export interface FlowOutcome {
  rule: string;
  verdict: 'allow' | 'deny' | 'confirm';
  asksUser: boolean;
}

const STEPS = [
  { key: '0', mark: '⓪', q: '自授权工具?', branch: 'ALLOW', tone: 'green' as const },
  { key: '1', mark: '①', q: '危险命令?', branch: 'DENY', tone: 'red' as const },
  { key: '2', mark: '②', q: 'plan 模式且非只读?', branch: 'DENY', tone: 'red' as const },
  { key: '3', mark: '③', q: '只读操作?', branch: 'ALLOW', tone: 'green' as const },
  { key: '4', mark: '④', q: '敏感命令?', branch: '确认', tone: 'amber' as const },
  { key: '5', mark: '⑤', q: '其他 → fail-closed', branch: '确认', tone: 'amber' as const },
];

export function PermissionFlowchart({ outcome }: { outcome?: FlowOutcome }) {
  const reduce = useReducedMotion();
  const activeIdx = outcome ? STEPS.findIndex((s) => s.key === outcome.rule) : -1;

  // 当前步的「为什么这么排」—— 复用 PERM_DECISION_CHAIN,一份数据两处用
  const activeStep = activeIdx > 0 ? PERM_DECISION_CHAIN[activeIdx - 1] : undefined;

  return (
    <div>
      <Node small style={{ maxWidth: '18rem', margin: '0 auto' }}>
        工具调用 + 参数 + 当前模式
      </Node>
      <VLine h={12} />

      {STEPS.map((s, i) => {
        const isActive = i === activeIdx;
        const isPast = activeIdx >= 0 && i < activeIdx;
        const isFuture = activeIdx >= 0 && i > activeIdx;

        // 分支结果文案随最终行为微调(bypass 下 confirm 变成放行)
        let branchText = s.branch;
        if (isActive && outcome) {
          if (outcome.asksUser) branchText = '询问用户';
          else if (outcome.verdict === 'allow') branchText = 'ALLOW';
          else if (outcome.verdict === 'deny') branchText = 'DENY';
        }

        return (
          <div key={s.key}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                alignItems: 'center',
                gap: '0.6rem',
                opacity: isFuture ? 0.4 : 1,
                transition: reduce ? 'none' : 'opacity 0.25s',
              }}
            >
              {/* 判定节点 */}
              <motion.div
                animate={{
                  borderColor: isActive ? 'var(--accent)' : 'var(--border-strong)',
                  background: isActive ? 'var(--accent-bg)' : 'var(--bg-raised)',
                  boxShadow: isActive ? '0 0 0 3px rgba(37,99,235,0.12)' : '0 1px 2px rgba(16,24,40,0.04)',
                }}
                transition={{ duration: reduce ? 0 : 0.2 }}
                style={{
                  border: `1px solid ${isPast ? 'var(--green-line)' : 'var(--border-strong)'}`,
                  background: isPast ? 'var(--green-bg)' : 'var(--bg-raised)',
                  borderRadius: 8,
                  padding: '0.4rem 0.65rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.55rem',
                  fontSize: '0.82rem',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: '0.72rem',
                    color: isActive ? 'var(--accent-text)' : isPast ? 'var(--green)' : 'var(--text-faint)',
                    flexShrink: 0,
                    fontWeight: isActive ? 700 : 400,
                  }}
                >
                  {isPast ? '✓' : s.mark}
                </span>
                <span style={{ color: isActive ? 'var(--text-strong)' : 'var(--text-dim)' }}>{s.q}</span>
                {isActive && (
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: '0.66rem',
                      fontFamily: 'var(--mono)',
                      color: 'var(--accent-text)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    在此终止
                  </span>
                )}
              </motion.div>

              {/* 分支箭头 + 结果 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', minWidth: '8.5rem' }}>
                <span
                  aria-hidden="true"
                  style={{
                    color: isActive ? 'var(--accent)' : 'var(--text-faint)',
                    fontSize: '0.75rem',
                    opacity: isActive ? 1 : 0.45,
                  }}
                >
                  ──→
                </span>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: '0.7rem',
                    fontWeight: isActive ? 700 : 500,
                    padding: '0.15em 0.5em',
                    borderRadius: 999,
                    border: '1px solid',
                    whiteSpace: 'nowrap',
                    opacity: isActive ? 1 : 0.45,
                    color: isActive
                      ? s.tone === 'green'
                        ? 'var(--green)'
                        : s.tone === 'red'
                          ? 'var(--red)'
                          : 'var(--amber)'
                      : 'var(--text-faint)',
                    borderColor: isActive
                      ? s.tone === 'green'
                        ? 'var(--green-line)'
                        : s.tone === 'red'
                          ? 'var(--red-line)'
                          : 'var(--amber-line)'
                      : 'var(--border-strong)',
                    background: isActive
                      ? s.tone === 'green'
                        ? 'var(--green-bg)'
                        : s.tone === 'red'
                          ? 'var(--red-bg)'
                          : 'var(--amber-bg)'
                      : 'transparent',
                  }}
                >
                  {branchText}
                </span>
              </div>
            </div>

            {i < STEPS.length - 1 && (
              <div
                aria-hidden="true"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) 8.5rem',
                  alignItems: 'center',
                  height: 20,
                  opacity: isFuture ? 0.35 : 1,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', paddingLeft: '0.9rem' }}>
                  <span
                    style={{
                      width: 2,
                      height: 20,
                      borderRadius: 1,
                      background: isPast ? 'var(--green)' : 'var(--border-strong)',
                      opacity: isPast ? 0.6 : 1,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: '0.64rem',
                      color: isPast ? 'var(--green)' : 'var(--text-faint)',
                    }}
                  >
                    {isPast ? '已通过' : '否 ↓'}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {activeStep && (
        <p style={{ fontSize: '0.78rem', color: 'var(--text-dim)', margin: '0.6rem 0 0' }}>
          <b style={{ color: 'var(--accent-text)' }}>
            {activeStep.order} {activeStep.question}
          </b>
          {' —— '}
          {activeStep.note}
        </p>
      )}

      <p style={{ fontSize: '0.76rem', color: 'var(--text-faint)', margin: '0.8rem 0 0' }}>
        顺序本身就是设计 —— 危险命令排在最前,所以任何模式都绕不过它。
      </p>
    </div>
  );
}
