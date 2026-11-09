import { motion, useReducedMotion } from 'motion/react';
import { Nav, SectionHead, Disclosure } from './components/Nav';
import { LoopSimulator } from './components/LoopSimulator';
import { PermissionSimulator } from './components/PermissionSimulator';
import { DangerousCommandList } from './components/PermissionRules';
import { FormatConverter } from './components/FormatConverter';
import { CompactionDemo } from './components/CompactionDemo';
import { Quiz } from './components/Quiz';
import { RaceComparison } from './components/RaceComparison';
import { StageBlock } from './components/Stage';
import { PromptStructure } from './components/PromptStructure';
import {
  SubagentVisual,
  GoalVisual,
  EventsVisual,
  AbortVisual,
  CheckpointVisual,
} from './components/PainVisuals';
import { STAGES } from './content/journey';
import { JourneyRail } from './components/JourneyRail';
import { ToolRegistryVisual, CompareVisual, RoadmapVisual, McpSdkVisual } from './components/ConceptVisuals';
import {
  AssemblyDiagram,
  BackendBoundaryDiagram,
  RegistryDiagram,
  ContextFunnel,
} from './components/Diagrams';
import {
  SOURCE_META,
  LOOP_PSEUDOCODE,
  COMPARISON_CHAT_VS_AGENT,
  BACKEND_PITFALLS,
  EDIT_FILE_RATIONALE,
  ALLOWLIST_RULES,
  ALLOWLIST_PHILOSOPHY,
  FAIL_CLOSED_NOTE,
  MEMORY_RECALL,
  CLOSING_MAP,
  CLOSING_PRINCIPLE,
} from './content/knowledge';

/** 章节容器:进入视口时轻微淡入(遵守 reduced-motion) */
function Section({ id, children }: { id: string; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      id={id}
      className="section"
      initial={reduce ? false : { opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="wrap">{children}</div>
    </motion.section>
  );
}

/** 按下标取 stage 太脆弱(插一节就错位),统一按 id 查 */
const stage = (id: string) => STAGES.find((s) => s.id === id)!;

export default function App() {
  return (
    <>
      <a href="#main" className="skip-link">
        跳到正文
      </a>
      <Nav />
      <JourneyRail />

      <main id="main">
        {/* ── Hero ─────────────────────────────────────────── */}
        <div id="top" style={{ padding: '4.5rem 0 3rem 2rem' }}>
          <div className="wrap">
            <h1>从零实现一个 Agent 终端 cli 的核心要点</h1>
            <p
              style={{
                fontSize: '1.08rem',
                color: 'var(--text-dim)',
                maxWidth: '44rem',
                marginBottom: '0rem',
              }}
            >
              {SOURCE_META.subtitle} —— 面向{SOURCE_META.audience}。不需要读源码(1w+),跟着往下看就行。
            </p>
          </div>
        </div>

        {/* ══ 旅程:跟着一次任务跑一遍 ══════════════════════════ */}
        <div id="journey" style={{ paddingTop: '0rem' }}>
          <div className="wrap">
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '0.8rem',
                marginBottom: '2.2rem',
                paddingBottom: '0.8rem',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span className="section-num">旅程</span>
              <h2 style={{ margin: 0, fontSize: '1.15rem', display: 'inline-block' }}>
                跟着一次真实的修复跑一遍
                <span className="src-note" style={{ marginLeft: 'auto' }}>
                  (每个模块只在它被需要的那一刻登场)
                </span>
              </h2>
            </div>

            {/* ── 1 你开口 ── */}
            <StageBlock stage={stage('ask')} defaultOpen>
              <RaceComparison />
              <div className="callout" style={{ marginTop: '1rem', marginBottom: 0 }}>
                <p style={{ margin: 0 }}>{COMPARISON_CHAT_VS_AGENT.takeaway}</p>
              </div>
            </StageBlock>

            {/* ── 2 循环转起来 ── */}
            <StageBlock stage={stage('loop')}>
              <pre className="code-block" style={{ borderColor: 'var(--accent-line)' }}>
                {LOOP_PSEUDOCODE}
              </pre>
              <LoopSimulator />
              <div className="grid-2" style={{ marginTop: '1rem' }}>
                <div className="card-inset">
                  <div style={{ fontSize: '0.86rem', fontWeight: 650, marginBottom: 4 }}>
                    决定循环转不转的,是模型,不是代码
                  </div>
                  <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-dim)' }}>
                    传统程序的分支是程序员写死的。Agent 的下一步,是模型读完上一步结果后
                    <strong>现场决定</strong>的 —— 代码只提供「能做什么」的清单。
                  </p>
                </div>
                <div className="card-inset">
                  <div style={{ fontSize: '0.86rem', fontWeight: 650, marginBottom: 4 }}>所以它不可预测</div>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: '1.1rem',
                      fontSize: '0.84rem',
                      color: 'var(--text-dim)',
                    }}
                  >
                    <li>你不知道它会调几次工具(可能 2 次,可能 20 次)</li>
                    <li>没法断言「一定走了某条路径」</li>
                    <li>但也正因此,它能处理你没预设过的情况</li>
                  </ul>
                </div>
              </div>
              <div style={{ marginTop: '1rem' }}>
                <AssemblyDiagram />
              </div>
            </StageBlock>

            {/* ── 3 先立规矩 ── */}
            <StageBlock stage={stage('prompt')}>
              <PromptStructure />
            </StageBlock>

            {/* ── 4 换个模型 ── */}
            <StageBlock stage={stage('backend')}>
              <BackendBoundaryDiagram />

              <h3 style={{ marginTop: '1.6rem' }}>两类消息参数对比</h3>

              <FormatConverter />

              <h3 style={{ marginTop: '2rem' }}>两个最容易踩的坑</h3>
              <div className="grid-2">
                {BACKEND_PITFALLS.map((p) => (
                  <div
                    key={p.id}
                    className="card-inset"
                    style={{
                      borderLeft: '3px solid var(--amber)',
                      borderRadius: '0 var(--radius) var(--radius) 0',
                    }}
                  >
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: '0.82rem',
                        color: 'var(--amber)',
                        fontWeight: 650,
                        marginBottom: '0.3rem',
                      }}
                    >
                      {p.title.replace(/`/g, '')}
                    </div>
                    <p style={{ fontSize: '0.84rem', color: 'var(--text-dim)', margin: 0 }}>{p.detail}</p>
                  </div>
                ))}
              </div>
            </StageBlock>

            {/* ── 5 它要动手了 ── */}
            <StageBlock stage={stage('tools')}>
              <RegistryDiagram />

              <ToolRegistryVisual />

              <div className="grid-2" style={{ marginTop: '1.2rem' }}>
                <div className="card">
                  <h4>{EDIT_FILE_RATIONALE.title.replace(/`/g, '')}</h4>
                  <ul style={{ fontSize: '0.86rem', color: 'var(--text-dim)' }}>
                    {EDIT_FILE_RATIONALE.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                  <p style={{ fontSize: '0.86rem', color: 'var(--text-dim)', margin: 0 }}>
                    {EDIT_FILE_RATIONALE.benefit}
                  </p>
                </div>
                <div className="card">
                  <h4>关键洞察:MCP 工具和内置工具没有区别</h4>
                  <p style={{ fontSize: '0.86rem', color: 'var(--text-dim)' }}>
                    MCP 可以理解成「AI 工具界的 USB 接口」。B Code 的设计是:MCP 工具接进来后,
                    和内置工具走完全一样的路径 —— 都是「名字 + schema + 执行函数」,都挂在同一个注册表里。
                  </p>
                  <p style={{ fontSize: '0.86rem', color: 'var(--text-dim)', margin: 0 }}>
                    所以对循环来说,<code>read_file</code> 和 <code>mcp__github__create_issue</code>{' '}
                    没有任何区别。 这是「注册表」这个抽象带来的直接好处。
                  </p>
                </div>
              </div>
            </StageBlock>

            {/* ── 6 差点删库 ── */}
            <StageBlock stage={stage('permissions')}>
              {/* 先给两把尺子:整套判定都围着这两条线转 */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))',
                  gap: '0.7rem',
                  marginBottom: '1.4rem',
                }}
              >
                <Note title="不可逆 → 没有商量余地" tone="red">
                  删库、格式化、提权这类操作<b>任何模式都拒</b>,连 <code>bypass</code> 也绕不过。
                </Note>
                <Note title="可商量 → 可以授权后免问" tone="amber">
                  <code>git push</code> 会改远端,但提交还在本地 —— 所以它<b>问你一次</b>,
                  你同意后就能记进白名单。
                </Note>
              </div>

              {/* 下面这个盒子,就是「它想删 node_modules」那一刻 */}
              <PermissionSimulator />

              <Disclosure summary="那 9 条危险命令长什么样?(附源码正则)">
                <DangerousCommandList />
              </Disclosure>

              <Disclosure summary="白名单凭什么记住某条命令?(4 条准入规则)">
                <div style={{ display: 'grid', gap: '0.4rem', margin: '0.2rem 0 0.7rem' }}>
                  {ALLOWLIST_RULES.map((r) => (
                    <div
                      key={r.rule}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '13rem minmax(0,1fr)',
                        gap: '0.7rem',
                        fontSize: '0.85rem',
                      }}
                    >
                      <span style={{ color: 'var(--text)' }}>{r.rule}</span>
                      <span style={{ color: 'var(--text-faint)' }}>{r.why}</span>
                    </div>
                  ))}
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: '0.85rem',
                    borderLeft: '2px solid var(--accent)',
                    paddingLeft: '0.7rem',
                  }}
                >
                  {ALLOWLIST_PHILOSOPHY}
                </p>
              </Disclosure>

              <div className="card-inset" style={{ marginTop: '1rem', borderLeft: '3px solid var(--amber)' }}>
                <div style={{ fontSize: '0.86rem', fontWeight: 650, marginBottom: 4 }}>
                  不确定就拦 —— 为什么默认是「否认」而不是「放行」?
                </div>
                <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-dim)' }}>{FAIL_CLOSED_NOTE}</p>
              </div>
            </StageBlock>

            {/* ── 7 上下文塞不下 ── */}
            <StageBlock stage={stage('context')}>
              <h3 style={{ marginTop: '2rem' }}>陷阱:工具结果把上下文撑爆</h3>
              <p style={{ color: 'var(--text-dim)', fontSize: '0.92rem', marginBottom: '1rem' }}>
                假设模型让你 <code>cat</code> 一个 10 万行的日志文件 ——
                原样塞回历史,单次就吃掉了大半上下文窗口。 所以不是「满了再处理」,而是从轻到重的多道防线:
              </p>
              <ContextFunnel />

              <CompactionDemo />
            </StageBlock>

            {/* ── 8 派个人去查 ── */}
            <StageBlock stage={stage('subagent')}>
              <SubagentVisual />
              <div style={{ marginTop: '1rem' }}>
                <h3 style={{ marginTop: '2rem' }}>MCP:SDK 替你做了哪些脏活</h3>
                <p style={{ color: 'var(--text-dim)', fontSize: '0.9rem', marginBottom: '0.9rem' }}>
                  接一个外部工具,真正麻烦的从来不是「调一次」,而是收发、对号、超时、换连接方式这些杂事。 官方
                  SDK 把这些都包了 —— 你只管写「这个工具干什么」。
                </p>
                <McpSdkVisual />
              </div>
            </StageBlock>

            {/* ── 9 谁说了算 ── */}
            <StageBlock stage={stage('goal')}>
              <GoalVisual />
              <div className="grid-2" style={{ marginTop: '1rem' }}>
                <div className="card-inset" style={{ borderLeft: '3px solid var(--amber)' }}>
                  <div style={{ fontSize: '0.86rem', fontWeight: 650, marginBottom: 4 }}>
                    为什么不用同一个模型顺便判断?
                  </div>
                  <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-dim)' }}>
                    「干活的」和「检查的」应该是两个独立判断。让执行者自己打分,它倾向于说「我干完了」。
                  </p>
                </div>
                <div className="card-inset" style={{ borderLeft: '3px solid var(--red)' }}>
                  <div style={{ fontSize: '0.86rem', fontWeight: 650, marginBottom: 4 }}>刹车</div>
                  <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-dim)' }}>
                    条件永远达不成时返回 <code>impossible</code>,主循环停止。没有这个刹车,
                    无人值守模式会一直烧钱。
                  </p>
                </div>
              </div>
              <div style={{ marginTop: '1rem' }}>
                <EventsVisual />
              </div>
              <div style={{ marginTop: '1rem' }}>
                <AbortVisual />
              </div>
              <div style={{ marginTop: '1rem' }}>
                <CheckpointVisual />
              </div>
            </StageBlock>

            {/* ── 10 跑通了 ── */}
            <StageBlock stage={stage('done')} defaultOpen>
              <div style={{ display: 'grid', gap: '0.4rem', marginBottom: '1.4rem' }}>
                {CLOSING_MAP.map((c, i) => (
                  <motion.div
                    key={c.problem}
                    initial={{ opacity: 0, x: -10 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.3, delay: i * 0.05 }}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '10rem 3rem 1fr',
                      alignItems: 'center',
                      gap: '0.6rem',
                      padding: '0.5rem 0.8rem',
                      borderRadius: 7,
                      border: '1px solid var(--border)',
                      background: i % 2 === 0 ? 'var(--bg-subtle)' : 'transparent',
                    }}
                  >
                    <span style={{ fontSize: '0.86rem', color: 'var(--text-dim)' }}>{c.problem}</span>
                    <span style={{ textAlign: 'center', color: 'var(--accent)', fontSize: '0.8rem' }}>
                      ──▶
                    </span>
                    <span style={{ fontSize: '0.86rem', color: 'var(--accent-text)', fontWeight: 600 }}>
                      {c.module}
                    </span>
                  </motion.div>
                ))}
              </div>

              <div
                style={{
                  padding: '1.1rem 1.3rem',
                  borderRadius: 'var(--radius-lg)',
                  border: '1px solid var(--accent-line)',
                  background: 'var(--accent-bg)',
                }}
              >
                <p style={{ margin: 0, fontSize: '1rem', lineHeight: 1.7 }}>
                  <strong>{CLOSING_PRINCIPLE}</strong>
                </p>
              </div>
            </StageBlock>
          </div>
        </div>

        {/* ── §14 对比 ──────────────────────────────────────── */}
        <Section id="compare">
          <SectionHead
            num="14"
            title="和 Claude Code 的对比"
            lede="B Code 在架构思想上和 Claude Code 高度一致,在工程选择上有明显取舍。"
          />

          <CompareVisual />

          <h3 style={{ marginTop: '1.8rem' }}>几个值得展开的差异</h3>
          <div className="grid-2">
            <div className="card">
              <h4>1. 模型后端:这是最实际的差别</h4>
              <p style={{ fontSize: '0.86rem', color: 'var(--text-dim)', margin: 0 }}>
                Claude Code 只能用 Anthropic 的模型。B Code 支持 OpenAI 兼容格式 —— 意味着你可以接 DeepSeek、
                通义、本地部署的模型等等。复杂度在于两家的消息、工具调用、流式响应格式都不同,
                解法是「内部统一用 Anthropic 形状,边界处转换」。
              </p>
            </div>
            <div className="card">
              <h4>2. 记忆的召回策略</h4>
              <p style={{ fontSize: '0.86rem', color: 'var(--text-dim)' }}>
                B Code 的选择是<strong>{MEMORY_RECALL.strategy}</strong>:
              </p>
              <ol
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--text-dim)',
                  margin: '0 0 0.6rem',
                  paddingLeft: '1.2rem',
                }}
              >
                {MEMORY_RECALL.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', margin: '0 0 0.4rem' }}>
                <strong>为什么不用向量检索?</strong> 三个理由:
              </p>
              <ul style={{ fontSize: '0.85rem', color: 'var(--text-dim)', margin: 0, paddingLeft: '1.2rem' }}>
                {MEMORY_RECALL.whyNoVector.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-faint)', margin: '0.5rem 0 0' }}>
                {MEMORY_RECALL.cost}
              </p>
            </div>
          </div>
        </Section>

        {/* ── §15 顺序 ──────────────────────────────────────── */}
        <Section id="roadmap">
          <SectionHead
            num="15"
            title="如果让你来写,建议的顺序"
            lede="从零开始的正确顺序(也是 B Code 实际的演进路径)。"
          />

          <RoadmapVisual />
        </Section>

        {/* ── 知识自测 ──────────────────────────────────────── */}
        <Section id="quiz">
          <SectionHead
            num="✦"
            title="知识自测"
            lede="十道题覆盖核心机制。答错不是失败 —— 那正好指出哪一节需要回头再看。"
          />
          <Quiz />
        </Section>
      </main>

      <footer
        style={{
          borderTop: '1px solid var(--border)',
          padding: '2rem 0 3rem',
          fontSize: '0.8rem',
          color: 'var(--text-faint)',
        }}
      >
        <div className="wrap">
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              快速试用：
              <a
                onClick={() => {
                  window.open('https://www.npmjs.com/package/@bysking/b-code', '_blank');
                }}
              >
                # B-code npmjs仓库
              </a>
              <div>
                更多学习材料推荐：
                <a
                  onClick={() => {
                    window.open('https://diwang.info/how-claude-code-works/#/', '_blank');
                  }}
                >
                  # How Claude Code Works
                </a>
                <a
                  onClick={() => {
                    window.open(
                      'https://github.com/shareAI-lab/learn-claude-code/blob/main/README-zh.md',
                      '_blank',
                    );
                  }}
                >
                  # learn claude code
                </a>
              </div>
            </div>
            <a href="#top" style={{ marginLeft: 'auto', textDecoration: 'none' }}>
              回到顶部 ↑
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}

/** 权限小节:带色条的一张小注 —— 比 callout 更紧凑,可并排 */
function Note({
  title,
  tone,
  children,
}: {
  title: string;
  tone: 'red' | 'amber' | 'green' | 'accent';
  children: React.ReactNode;
}) {
  const c = {
    red: { fg: 'var(--red)', bg: 'var(--red-bg)', line: 'var(--red-line)' },
    amber: { fg: 'var(--amber)', bg: 'var(--amber-bg)', line: 'var(--amber-line)' },
    green: { fg: 'var(--green)', bg: 'var(--green-bg)', line: 'var(--green-line)' },
    accent: { fg: 'var(--accent-text)', bg: 'var(--accent-bg)', line: 'var(--accent-line)' },
  }[tone];

  return (
    <div
      style={{
        border: `1px solid ${c.line}`,
        background: c.bg,
        borderRadius: 8,
        padding: '0.6rem 0.8rem',
      }}
    >
      <div style={{ fontSize: '0.8rem', fontWeight: 650, color: c.fg, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: '0.82rem', color: 'var(--text-dim)', lineHeight: 1.65 }}>{children}</div>
    </div>
  );
}
