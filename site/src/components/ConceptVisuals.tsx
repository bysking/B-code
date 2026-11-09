import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/**
 * 概念可视化集合 —— 把「表格 / 列表」改成能直接看出结构关系的东西。
 *
 * 共同原则:图形只在原文已有事实之上工作,不新增主张;
 * 每一处视觉编码都必须对应一个真实的语义(分组、比例、先后、收敛/分叉)。
 */

/* ══════════════════════════════════════════════════════════════
   §4 工具清单 —— 13 个工具按权限档位分道,并露出「没有删除工具」的空位
   ══════════════════════════════════════════════════════════════ */

const TOOL_LANES = [
  {
    mode: 'read' as const,
    label: '只读',
    hint: 'plan 模式下也放行',
    tools: ['read_file', 'file_content', 'list_files', 'grep_search', 'agent', 'review_plan'],
  },
  {
    mode: 'write' as const,
    label: '写',
    hint: '需要确认',
    tools: ['write_file', 'edit_file', 'todo_write', 'save_memory'],
  },
  { mode: 'shell' as const, label: '执行', hint: '过危险命令闸门', tools: ['run_shell'] },
  {
    mode: 'external' as const,
    label: '外部 / 专用',
    hint: 'ask_user 与 todo_write 自授权',
    tools: ['ask_user', 'write_plan'],
  },
];

const LANE_STYLE = {
  read: { fg: 'var(--green)', bg: 'var(--green-bg)', line: 'var(--green-line)' },
  write: { fg: 'var(--amber)', bg: 'var(--amber-bg)', line: 'var(--amber-line)' },
  shell: { fg: 'var(--red)', bg: 'var(--red-bg)', line: 'var(--red-line)' },
  external: { fg: 'var(--purple)', bg: 'var(--purple-bg)', line: 'var(--purple-line)' },
};

export function ToolRegistryVisual() {
  const [hover, setHover] = useState<string | null>(null);
  const reduce = useReducedMotion();

  return (
    <div>
      {/* 比例条:13 个工具里 6 个只读、1 个能执行 */}
      <div style={{ display: 'flex', gap: 3, marginBottom: '1rem', alignItems: 'stretch' }}>
        {TOOL_LANES.map((lane) => {
          const st = LANE_STYLE[lane.mode];
          return (
            <div
              key={lane.mode}
              style={{
                flex: lane.tools.length,
                background: hover === lane.mode ? st.bg : 'var(--bg-subtle)',
                border: `1px solid ${hover === lane.mode ? st.line : 'var(--border)'}`,
                borderRadius: 6,
                padding: '0.35rem 0.5rem',
                textAlign: 'center',
                transition: reduce ? 'none' : 'all 0.18s',
                cursor: 'default',
              }}
              onMouseEnter={() => setHover(lane.mode)}
              onMouseLeave={() => setHover(null)}
            >
              <div style={{ fontFamily: 'var(--mono)', fontSize: '0.82rem', fontWeight: 700, color: st.fg }}>
                {lane.tools.length}
              </div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>{lane.label}</div>
            </div>
          );
        })}
      </div>

      {/* 分道 */}
      <div style={{ display: 'grid', gap: '0.55rem' }}>
        {TOOL_LANES.map((lane) => {
          const st = LANE_STYLE[lane.mode];
          const on = hover === lane.mode;
          return (
            <div
              key={lane.mode}
              onMouseEnter={() => setHover(lane.mode)}
              onMouseLeave={() => setHover(null)}
              style={{
                display: 'grid',
                gridTemplateColumns: '7.5rem 1fr',
                alignItems: 'center',
                gap: '0.7rem',
                padding: '0.45rem 0.6rem',
                borderRadius: 8,
                border: `1px solid ${on ? st.line : 'var(--border)'}`,
                background: on ? st.bg : 'transparent',
                transition: reduce ? 'none' : 'all 0.18s',
              }}
            >
              <div>
                <span
                  className="tag"
                  style={{
                    color: st.fg,
                    borderColor: st.line,
                    background: st.bg,
                    fontSize: '0.66rem',
                  }}
                >
                  {lane.label}
                </span>
                <div style={{ fontSize: '0.66rem', color: 'var(--text-faint)', marginTop: 3 }}>
                  {lane.hint}
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                {lane.tools.map((t) => (
                  <code
                    key={t}
                    style={{
                      fontSize: '0.72rem',
                      padding: '0.1em 0.45em',
                      background: 'var(--bg-raised)',
                      borderColor: on ? st.line : 'var(--border)',
                    }}
                  >
                    {t}
                  </code>
                ))}
                {/* 删除工具的空位 —— 这是设计缺口,不是遗漏 */}
                {lane.mode === 'write' && (
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: '0.72rem',
                      padding: '0.1em 0.45em',
                      border: '1px dashed var(--red-line)',
                      borderRadius: 4,
                      color: 'var(--red)',
                      background: 'var(--red-bg)',
                      opacity: 0.9,
                    }}
                    title="故意不提供:删除只能走 run_shell,并受危险命令规则拦截"
                  >
                    delete_file ✗
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p
        style={{
          fontSize: '0.8rem',
          color: 'var(--text-dim)',
          margin: '0.9rem 0 0',
          paddingLeft: '0.7rem',
          borderLeft: '2px solid var(--red)',
        }}
      >
        没有 <code>delete_file</code> 是刻意的:删除只能走 <code>run_shell</code>, 而 <code>rm -rf</code>{' '}
        会被危险命令规则直接拒绝。
        <strong>不可逆操作全部收拢到唯一一条需要过权限的通道上。</strong>
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   §5 危险命令闸门 —— 四种模式都排在它后面,没有绕行路线
   ══════════════════════════════════════════════════════════════ */

const MODES = [
  { id: 'default', label: 'default', note: '每次都问' },
  { id: 'plan', label: 'plan', note: '全部拦截' },
  { id: 'auto', label: 'auto', note: 'AI 分类器' },
  { id: 'bypass', label: '--yolo', note: '不问,直接干' },
];

export function DangerGateVisual() {
  const reduce = useReducedMotion();
  const [armed, setArmed] = useState(true);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.8rem' }}>
        <span style={{ fontSize: '0.84rem', color: 'var(--text-dim)' }}>
          点一下,看闸门对四种模式分别做什么
        </span>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setArmed((v) => !v)}
          aria-pressed={armed}
          style={{ marginLeft: 'auto' }}
        >
          {armed ? '⚡ 触发危险命令' : '⟲ 复位'}
        </button>
      </div>

      <div style={{ display: 'grid', gap: '0.4rem' }}>
        {MODES.map((m, i) => (
          <div
            key={m.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '8rem 1fr auto',
              alignItems: 'center',
              gap: '0.7rem',
              padding: '0.4rem 0.6rem',
              borderRadius: 7,
              border: `1px solid ${armed ? 'var(--red-line)' : 'var(--border)'}`,
              background: armed ? 'var(--red-bg)' : 'var(--bg-subtle)',
              transition: reduce ? 'none' : 'all 0.25s',
              transitionDelay: `${i * 40}ms`,
            }}
          >
            <code
              style={{
                fontSize: '0.76rem',
                background: 'transparent',
                border: 'none',
                color: m.id === 'bypass' ? 'var(--red)' : 'var(--text)',
              }}
            >
              {m.label}
            </code>
            <span style={{ fontSize: '0.74rem', color: 'var(--text-faint)' }}>{m.note}</span>
            <motion.span
              animate={{
                opacity: armed ? 1 : 0.35,
                scale: armed ? 1 : 0.96,
              }}
              transition={{ duration: reduce ? 0 : 0.2, delay: reduce ? 0 : i * 0.06 }}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '0.72rem',
                fontWeight: 700,
                color: 'var(--red)',
                border: '1px solid var(--red-line)',
                background: 'var(--bg-raised)',
                borderRadius: 999,
                padding: '0.1em 0.55em',
                whiteSpace: 'nowrap',
              }}
            >
              {armed ? 'DENY' : 'standby'}
            </motion.span>
          </div>
        ))}
      </div>

      {/* 闸门本体 */}
      <div
        style={{
          marginTop: '0.8rem',
          padding: '0.7rem 0.9rem',
          borderRadius: 8,
          border: `1px solid ${armed ? 'var(--red)' : 'var(--border-strong)'}`,
          background: armed ? 'var(--red-bg)' : 'var(--bg-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.7rem',
          transition: reduce ? 'none' : 'all 0.3s',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '0.7rem',
            fontWeight: 700,
            color: 'var(--red)',
            border: '1px solid var(--red-line)',
            background: 'var(--bg-raised)',
            borderRadius: 5,
            padding: '0.15em 0.5em',
            flexShrink: 0,
          }}
        >
          固定 9 条
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
          {['rm -rf', 'git reset --hard', 'sudo', 'mkfs', '> /dev/', 'dd', 'kill', 'reboot', 'shutdown'].map(
            (c) => (
              <code
                key={c}
                style={{
                  fontSize: '0.68rem',
                  padding: '0.05em 0.4em',
                  background: 'var(--bg-raised)',
                  borderColor: 'var(--red-line)',
                  color: 'var(--red)',
                }}
              >
                {c}
              </code>
            ),
          )}
        </div>
      </div>

      <p style={{ fontSize: '0.78rem', color: 'var(--text-faint)', margin: '0.6rem 0 0' }}>
        四种模式共用同一道闸门 —— <strong>bypass 也绕不过去</strong>。
        因为它不是「要不要问用户」的效率问题,而是「执行后能否挽回」的问题。
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   §14 对比 —— 不列表格,而是看「哪些收敛、哪些分叉」
   ══════════════════════════════════════════════════════════════ */

const SAME = ['核心循环', '工具系统', '子 Agent', '持久化记忆', '技能系统', 'Hooks', '自主循环'];
const DIFF = [
  { dim: '权限模型', cc: '多档模式', bc: '四档,区分危险/敏感' },
  { dim: '上下文压缩', cc: '自动压缩', bc: '分级压缩 + 文件指针' },
  { dim: '模型后端', cc: '仅 Anthropic', bc: 'Anthropic + OpenAI 双端兼容' },
  { dim: 'UI 技术栈', cc: '闭源', bc: 'OpenTUI(开源)' },
  { dim: '生态层', cc: '更优，生态完善', bc: '核心高度对齐' },
];

export function CompareVisual() {
  const reduce = useReducedMotion();

  return (
    <div>
      {/* 收敛区 */}
      <div
        style={{
          border: '1px solid var(--green-line)',
          background: 'var(--green-bg)',
          borderRadius: 'var(--radius-lg)',
          padding: '0.9rem 1rem',
          marginBottom: '0.8rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', marginBottom: '0.6rem' }}>
          <span
            style={{ fontFamily: 'var(--mono)', fontSize: '0.76rem', fontWeight: 700, color: 'var(--green)' }}
          >
            收敛 {SAME.length} 项
          </span>
          <span style={{ fontSize: '0.76rem', color: 'var(--text-dim)' }}>
            同一个问题的正确答案会收敛到相似的形状
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
          {SAME.map((s) => (
            <motion.span
              key={s}
              initial={reduce ? false : { opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: reduce ? 0 : 0.22 }}
              style={{
                fontSize: '0.78rem',
                color: 'var(--green)',
                border: '1px solid var(--green-line)',
                background: 'var(--bg-raised)',
                borderRadius: 999,
                padding: '0.15em 0.65em',
              }}
            >
              {s}
            </motion.span>
          ))}
        </div>
      </div>

      {/* 分叉区 */}
      <div
        style={{
          border: '1px solid var(--accent-line)',
          borderRadius: 'var(--radius-lg)',
          padding: '0.9rem 1rem',
          background: 'var(--bg-raised)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', marginBottom: '0.7rem' }}>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '0.76rem',
              fontWeight: 700,
              color: 'var(--accent-text)',
            }}
          >
            分叉 {DIFF.length} 项
          </span>
          <span style={{ fontSize: '0.76rem', color: 'var(--text-dim)' }}>工程取舍各不相同</span>
        </div>

        <div style={{ display: 'grid', gap: '0.4rem' }}>
          {DIFF.map((d) => (
            <div
              key={d.dim}
              style={{
                display: 'grid',
                gridTemplateColumns: '7rem 1fr 1.4rem 1fr',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.78rem',
                padding: '0.3rem 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: '0.72rem' }}>
                {d.dim}
              </span>
              <span style={{ color: 'var(--text-faint)', textAlign: 'right' }}>{d.cc}</span>
              <span style={{ textAlign: 'center', color: 'var(--accent)', fontSize: '0.7rem' }}>⇄</span>
              <span style={{ color: 'var(--accent-text)' }}>{d.bc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   §4 MCP SDK —— 用大白话讲「它替你干了哪五件脏活」
   ══════════════════════════════════════════════════════════════ */

const SDK_CHORES = [
  {
    title: '替你收发消息,并且对得上号',
    plain: '同时问好几件事,回来能分清哪句答的是哪句;等太久会自动放弃。',
    without: '你得自己拿本子记:第 3 号请求在等第 3 号回信',
  },
  {
    title: '先互相报家门',
    plain: '一接上就交换「我会什么」和「你会什么」,之后只问对方会的。',
    without: '问了人家不会的东西,永远等不到回信',
  },
  {
    title: '几样现成的动作',
    plain: '列出工具、调用工具、列资源……都是调一个方法的事,回来的数据还帮你验过格式。',
    without: '每个动作的数据都得你自己拼、自己拆',
  },
  {
    title: '换插头不用改代码',
    plain: '走命令行、走 HTTP、走 WebSocket —— 上层代码一行都不用动。',
    without: '每换一种连法,就得重写一套',
  },
  {
    title: '允许服务器反过来问你',
    plain: '不只是你调它,它也能问你:「能帮我想一下吗」「这个目录能读吗」。',
    without: '只能单向调用,很多工具就不好使',
  },
];

export function McpSdkVisual() {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.7rem',
          padding: '0.6rem 0.85rem',
          borderRadius: 8,
          background: 'var(--accent-bg)',
          border: '1px solid var(--accent-line)',
          marginBottom: '0.9rem',
          fontSize: '0.85rem',
          color: 'var(--text-dim)',
        }}
      >
        <span style={{ color: 'var(--accent-text)', fontWeight: 650, flexShrink: 0 }}>一句话</span>
        <span>
          SDK 不是工具本身,是<b style={{ color: 'var(--text)' }}>那根 USB 线上的芯片</b>
          —— 只保证「话能说清楚」,至于对面连的是数据库还是浏览器,它一概不管。
        </span>
      </div>

      <div style={{ display: 'grid', gap: '0.35rem' }}>
        {SDK_CHORES.map((c, i) => {
          const on = open === i;
          return (
            <motion.div
              key={c.title}
              initial={reduce ? false : { opacity: 0, x: -8 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: reduce ? 0 : 0.25, delay: reduce ? 0 : i * 0.04 }}
              onMouseEnter={() => setOpen(i)}
              onMouseLeave={() => setOpen(null)}
              style={{
                border: `1px solid ${on ? 'var(--accent-line)' : 'var(--border)'}`,
                background: on ? 'var(--accent-bg)' : 'var(--bg-raised)',
                borderRadius: 8,
                padding: '0.5rem 0.75rem',
                transition: reduce ? 'none' : 'all 0.16s',
                cursor: 'default',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem' }}>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    color: on ? 'var(--accent-text)' : 'var(--text-faint)',
                    flexShrink: 0,
                    width: '1rem',
                  }}
                >
                  {i + 1}
                </span>
                <span
                  style={{
                    fontSize: '0.88rem',
                    fontWeight: 600,
                    color: on ? 'var(--accent-text)' : 'var(--text)',
                  }}
                >
                  {c.title}
                </span>
              </div>
              <div
                style={{
                  marginLeft: '1.6rem',
                  fontSize: '0.82rem',
                  color: 'var(--text-dim)',
                  lineHeight: 1.65,
                  marginTop: 2,
                }}
              >
                {c.plain}
                {/* 「不做会怎样」默认收起,悬停才露 —— 保持安静 */}
                <div
                  style={{
                    fontSize: '0.76rem',
                    color: 'var(--text-faint)',
                    marginTop: on ? 4 : 0,
                    maxHeight: on ? 40 : 0,
                    opacity: on ? 1 : 0,
                    overflow: 'hidden',
                    transition: reduce ? 'none' : 'all 0.2s',
                  }}
                >
                  不做的话:{c.without}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* 握手:三个气泡,没有协议术语 */}
      <div style={{ marginTop: '1rem' }}>
        <div
          style={{
            fontSize: '0.72rem',
            fontFamily: 'var(--mono)',
            color: 'var(--text-faint)',
            marginBottom: '0.5rem',
          }}
        >
          连上时自动发生的三句话
        </div>
        <div style={{ display: 'grid', gap: '0.3rem' }}>
          {[
            { who: 'claude', text: '你好,我会这些:读文件、跑命令、问你问题' },
            { who: 'server', text: '你好,我会这些:查数据库、搜文档' },
            { who: 'claude', text: '好,那开始 —— 你要的我都会', done: true },
          ].map((m, i) => (
            <motion.div
              key={i}
              initial={reduce ? false : { opacity: 0, x: m.who === 'claude' ? -10 : 10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: reduce ? 0 : 0.3, delay: reduce ? 0 : 0.1 + i * 0.12 }}
              style={{
                justifySelf: m.who === 'claude' ? 'start' : 'end',
                maxWidth: '82%',
                padding: '0.35rem 0.7rem',
                borderRadius: 8,
                fontSize: '0.8rem',
                background: m.done
                  ? 'var(--green-bg)'
                  : m.who === 'claude'
                    ? 'var(--bg-subtle)'
                    : 'var(--purple-bg)',
                border: `1px solid ${m.done ? 'var(--green-line)' : m.who === 'claude' ? 'var(--border)' : 'var(--purple-line)'}`,
                color: m.done ? 'var(--green)' : 'var(--text-dim)',
              }}
            >
              {m.text}
            </motion.div>
          ))}
        </div>
      </div>

      <p
        style={{
          fontSize: '0.8rem',
          color: 'var(--text-dim)',
          margin: '0.9rem 0 0',
          paddingLeft: '0.7rem',
          borderLeft: '2px solid var(--accent)',
        }}
      >
        为什么要先报家门?这样双方都能<b>少说废话</b> —— 我不会的你别问我,你不会的我也别问。 反过来说,
        <b>不会的就别声称会</b>:吹了做不到,对方会一直等,永远超时。
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   §15 路线图 —— 台阶,并且标出「大部分人摔下去的那一级」
   ══════════════════════════════════════════════════════════════ */

const STEPS = [
  { n: 1, t: 'while + read_file', r: '证明核心原理' },
  // 悬崖标在第 2 步:拿到写/执行能力却还没加权限,是第一个不可挽回的岔路
  { n: 2, t: 'write_file + run_shell', r: '必须立刻加权限', cliff: true },
  { n: 3, t: '流式 + 事件流', r: '否则体验是「卡死」' },
  { n: 4, t: '截断 + 压缩', r: '否则长对话必崩' },
  { n: 5, t: 'system prompt 约束', r: '否则行为不稳定' },
  { n: 6, t: '检查点', r: '否则改坏了没法收拾' },
];

export function RoadmapVisual() {
  const reduce = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.35rem', minHeight: '13rem' }}>
        {STEPS.map((s, i) => {
          const h = 3 + i * 1.15;
          const isCliff = Boolean(s.cliff);
          const on = hover === s.n;
          return (
            <motion.div
              key={s.n}
              initial={reduce ? false : { opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: reduce ? 0 : 0.3, delay: reduce ? 0 : i * 0.06 }}
              onMouseEnter={() => setHover(s.n)}
              onMouseLeave={() => setHover(null)}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
            >
              <div
                style={{
                  height: `${h}rem`,
                  border: `1px solid ${isCliff ? 'var(--red-line)' : on ? 'var(--accent-line)' : 'var(--border)'}`,
                  borderBottom: 'none',
                  borderRadius: '7px 7px 0 0',
                  background: isCliff ? 'var(--red-bg)' : on ? 'var(--accent-bg)' : 'var(--bg-subtle)',
                  padding: '0.45rem 0.4rem',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  transition: reduce ? 'none' : 'all 0.18s',
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    color: isCliff ? 'var(--red)' : 'var(--accent-text)',
                    marginBottom: 2,
                  }}
                >
                  {s.n}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text)', lineHeight: 1.35 }}>{s.t}</div>
                <div
                  style={{ fontSize: '0.64rem', color: 'var(--text-faint)', marginTop: 2, lineHeight: 1.3 }}
                >
                  {s.r}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* 地基 */}
      <div
        style={{
          height: 3,
          background: 'var(--border-strong)',
          borderRadius: 2,
        }}
      />

      {/* 悬崖提示 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          marginTop: '0.7rem',
          padding: '0.5rem 0.75rem',
          background: 'var(--red-bg)',
          border: '1px solid var(--red-line)',
          borderRadius: 7,
        }}
      >
        <span style={{ fontSize: '0.9rem', color: 'var(--red)', flexShrink: 0 }}>⚠</span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
          大部分项目倒在<strong style={{ color: 'var(--red)' }}>第 2 步</strong> ——
          拿到写文件和跑命令的能力后,先去做花哨功能,把权限确认跳过去了。
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          marginTop: '0.6rem',
          fontSize: '0.78rem',
          color: 'var(--text-faint)',
        }}
      >
        <span style={{ borderBottom: '1px dashed var(--border-strong)', flex: 1 }} />
        <span>以上六步:不做就不能用</span>
        <span style={{ borderBottom: '1px dashed var(--border-strong)', flex: 1 }} />
      </div>

      <div
        style={{
          marginTop: '0.5rem',
          fontSize: '0.8rem',
          color: 'var(--text-dim)',
          border: '1px dashed var(--border-strong)',
          borderRadius: 7,
          padding: '0.4rem 0.7rem',
          background: 'var(--bg-subtle)',
        }}
      >
        再往上才是同生态一条龙:
        <span style={{ color: 'var(--text-faint)' }}>子 Agent · 记忆 · 技能 · MCP · 自主循环</span>
      </div>
    </div>
  );
}
