import { motion, useReducedMotion } from 'motion/react';
import { Nav, SectionHead, Disclosure } from './components/Nav';
import { LoopSimulator } from './components/LoopSimulator';
import { PermissionSimulator } from './components/PermissionSimulator';
import { FormatConverter } from './components/FormatConverter';
import { CompactionDemo } from './components/CompactionDemo';
import { Quiz } from './components/Quiz';
import { RaceComparison } from './components/RaceComparison';
import { PainPoints } from './components/PainPoints';
import { ToolRegistryVisual, CompareVisual, RoadmapVisual, McpSdkVisual } from './components/ConceptVisuals';
import {
  AssemblyDiagram,
  BackendBoundaryDiagram,
  RegistryDiagram,
  ContextFunnel,
} from './components/Diagrams';
import {
  SOURCE_META,
  SOURCE_CORRECTIONS,
  LOOP_PSEUDOCODE,
  COMPARISON_CHAT_VS_AGENT,
  BACKEND_PITFALLS,
  EDIT_FILE_RATIONALE,
  ALLOWLIST_RULES,
  ALLOWLIST_PHILOSOPHY,
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

export default function App() {
  return (
    <>
      <a href="#main" className="skip-link">
        跳到正文
      </a>
      <Nav />

      <main id="main">
        {/* ── Hero ─────────────────────────────────────────── */}
        <div id="top" style={{ padding: '4.5rem 0 3rem' }}>
          <div className="wrap">
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '0.8rem',
                color: 'var(--green)',
                marginBottom: '1rem',
              }}
            >
              ❯ bcode --explain ./SHARING.md
            </div>
            <h1>
              从零实现一个
              <br />
              Claude Code
            </h1>
            <p
              style={{
                fontSize: '1.08rem',
                color: 'var(--text-dim)',
                maxWidth: '44rem',
                marginBottom: '1.6rem',
              }}
            >
              {SOURCE_META.subtitle} —— 面向{SOURCE_META.audience}。不需要读源码,跟着往下看就行。
            </p>

            <div
              style={{
                display: 'flex',
                gap: '1.4rem',
                flexWrap: 'wrap',
                fontFamily: 'var(--mono)',
                fontSize: '0.78rem',
                color: 'var(--text-faint)',
                paddingTop: '1rem',
                borderTop: '1px solid var(--border)',
              }}
            >
              <span>
                <span style={{ color: 'var(--text)' }}>
                  {SOURCE_META.loc.toLocaleString('en-US')}
                </span>{' '}
                行业务代码
              </span>
              <span>
                <span style={{ color: 'var(--text)' }}>{SOURCE_META.testsTotal}</span> 条测试
              </span>
              <span>
                <span style={{ color: 'var(--text)' }}>v{SOURCE_META.version}</span>
              </span>
              <a
                href={`https://github.com/bysking/b-code`}
                style={{ marginLeft: 'auto', textDecoration: 'none' }}
              >
                github.com/bysking/b-code ↗
              </a>
            </div>
          </div>
        </div>

        {/* ── §0 这类工具有什么用 ───────────────────────────── */}
        <Section id="intro">
          <SectionHead
            num="0"
            title="这类工具有什么用"
            src="§0"
            lede="你可能用过 ChatGPT 网页版:你问它问题,它回答你。但你让它「修一下这个 bug」,它只能给你一段代码 —— 你自己去复制、粘贴、保存、跑测试。"
          />

          <p style={{ color: 'var(--text-dim)', marginBottom: '1.4rem' }}>
            Claude Code 这类工具改变的是最后一步 —— 它<strong>自己动手</strong>。
          </p>

          <RaceComparison />

          <div className="callout">
            <p style={{ margin: 0 }}>{COMPARISON_CHAT_VS_AGENT.takeaway}</p>
          </div>
        </Section>

        {/* ── §1 第一性原理 ─────────────────────────────────── */}
        <Section id="loop">
          <SectionHead
            num="1"
            title="第一性原理:那个循环"
            src="§1"
            lede="先看这个循环,它是全部的核心。约 1.2 万行业务代码,但这几行就是它的心脏。"
          />

          <div className="grid-2" style={{ alignItems: 'start' }}>
            <div>
              <pre className="code-block" style={{ borderColor: 'var(--accent-line)' }}>
                {LOOP_PSEUDOCODE}
              </pre>
              <div className="callout callout-warn">
                <span className="callout-title">决定循环转不转的,是模型,不是代码</span>
                <p style={{ margin: 0, fontSize: '0.88rem' }}>
                  传统程序的分支是程序员写死的(<code>if 文件不存在 then 创建</code>)。Agent 的下一步,
                  是模型读完上一步结果后<strong>现场决定</strong>的。代码只提供「能做什么」的清单,
                  不规定「先做什么后做什么」。
                </p>
              </div>
              <ul style={{ fontSize: '0.88rem', color: 'var(--text-dim)' }}>
                <li>你没法预测它会调几次工具(可能 2 次,可能 20 次)</li>
                <li>你没法用测试断言「一定走了某条路径」</li>
                <li>但正因如此,它能处理你没预设过的情况</li>
              </ul>
            </div>
            <LoopSimulator />
          </div>
        </Section>

        {/* ── §2 三样东西 ───────────────────────────────────── */}
        <Section id="three-things">
          <SectionHead
            num="2"
            title="循环转起来需要的三样东西"
            src="§2"
            lede="回到上面那个伪代码,你会发现它引用了三个还不存在的东西。"
          />
          <AssemblyDiagram />
        </Section>

        {/* ── §3 后端层 ─────────────────────────────────────── */}
        <Section id="backend">
          <SectionHead
            num="3"
            title="模块一:怎么跟模型说话"
            src="§3"
            lede="最直觉的写法是把 SDK 调用直接写在循环里。但今天用 Anthropic、明天想用 DeepSeek,两家格式不一样 —— 循环里就会长满 if/else。"
          />

          <BackendBoundaryDiagram />

          <h3 style={{ marginTop: '1.6rem' }}>字段逐条对应</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.92rem' }}>
            结论:<strong>差异不在「消息内容」,而在「工具调用放在哪儿」</strong>。普通文本对话两家几乎一样,
            一旦涉及工具就开始分叉。点选字段看两边对应项:
          </p>
          <FormatConverter />

          <h3 style={{ marginTop: '2rem' }}>两个最容易踩的坑</h3>
          <div className="grid-2">
            {BACKEND_PITFALLS.map((p) => (
              <div
                key={p.id}
                className="card-inset"
                style={{ borderLeft: '3px solid var(--amber)', borderRadius: '0 var(--radius) var(--radius) 0' }}
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

          <p
            style={{
              fontSize: '0.84rem',
              color: 'var(--text-faint)',
              margin: '1rem 0 0',
              paddingLeft: '0.7rem',
              borderLeft: '2px solid var(--border-strong)',
            }}
          >
            这也是内部固定一种形状的理由:两套格式直接进主循环,上面这些坑就会散布在循环、
            上下文压缩、会话存储每一处;固定后,全部差异被压缩到两个可单独测试的纯函数里。
          </p>
        </Section>

        {/* ── §4 工具系统 ───────────────────────────────────── */}
        <Section id="tools">
          <SectionHead
            num="4"
            title="模块二:工具系统"
            src="§4"
            lede="模型不是「知道」它能读文件,而是我们在每次请求里告诉它一份清单。每个工具声明:叫什么名字、干什么用、需要什么参数(JSON Schema)。"
          />

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
                所以对循环来说,<code>read_file</code> 和 <code>mcp__github__create_issue</code> 没有任何区别。
                这是「注册表」这个抽象带来的直接好处。
              </p>
            </div>
          </div>

          <h3 style={{ marginTop: '2rem' }}>陷阱:工具结果把上下文撑爆</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.92rem', marginBottom: '1rem' }}>
            假设模型让你 <code>cat</code> 一个 10 万行的日志文件 —— 原样塞回历史,单次就吃掉了大半上下文窗口。
            所以不是「满了再处理」,而是从轻到重的多道防线:
          </p>
          <ContextFunnel />

          <CompactionDemo />

          <h3 style={{ marginTop: '2rem' }}>MCP:SDK 替你做了哪些脏活</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.9rem', marginBottom: '0.9rem' }}>
            接一个外部工具,真正麻烦的从来不是「调一次」,而是收发、对号、超时、换连接方式这些杂事。
            官方 SDK 把这些都包了 —— 你只管写「这个工具干什么」。
          </p>
          <McpSdkVisual />
        </Section>

        {/* ── §5 权限系统 ───────────────────────────────────── */}
        <Section id="permissions">
          <SectionHead
            num="5"
            title="模块三:权限系统"
            src="§5"
            lede="一个能执行 rm -rf / 的 AI,和一个只能聊天的 AI,风险等级完全不同。这个模块是 B Code 存在的必要条件 —— 没有它,其他所有功能都不能给真人用。"
          />

          {/* 一个入口:模式 × 命令 × 白名单,下面的模拟器全部可验证 */}
          <PermissionSimulator />

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))',
              gap: '0.7rem',
              marginTop: '1rem',
            }}
          >
            <Note title="不可逆 vs 可商量" tone="red">
              危险命令<b>没有商量余地</b>,任何模式都拒;而 <code>git push</code> 这类只是
              <b>会改动远端</b>,提交还在本地 —— 所以允许你授权后免问。
            </Note>
            <Note title="不确定就拦" tone="amber">
              没声明类型的工具(未来接进来的 MCP、别人写的插件)默认<b>要求确认</b>,而不是默认放行。
              反过来会让新工具白拿权限。
            </Note>
          </div>

          <Disclosure summary="白名单凭什么记住某条命令?(4 条准入规则)">
            <div style={{ display: 'grid', gap: '0.4rem', margin: '0.2rem 0 0.7rem' }}>
              {ALLOWLIST_RULES.map((r) => (
                <div
                  key={r.rule}
                  style={{ display: 'grid', gridTemplateColumns: '13rem minmax(0,1fr)', gap: '0.7rem', fontSize: '0.85rem' }}
                >
                  <span style={{ color: 'var(--text)' }}>{r.rule}</span>
                  <span style={{ color: 'var(--text-faint)' }}>{r.why}</span>
                </div>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: '0.85rem', borderLeft: '2px solid var(--accent)', paddingLeft: '0.7rem' }}>
              {ALLOWLIST_PHILOSOPHY}
            </p>
          </Disclosure>
        </Section>

        {/* ── §6 最小闭环 ───────────────────────────────────── */}
        <Section id="minimal">
          <SectionHead
            num="6"
            title="现在已经有一个能跑的 Agent 了"
            src="§6"
            lede="到这里,最小闭环已经有了。但如果只用这个最小版本,你会在一周内遇到下面这些问题。"
          />
          <div className="grid-3">
            {['循环能转', '能跟模型通信', '能读文件、改文件、跑命令', '不会把你磁盘删了'].map((x) => (
              <div key={x} className="card-inset" style={{ fontSize: '0.9rem' }}>
                <span style={{ color: 'var(--green)', marginRight: 6 }}>✓</span>
                {x}
              </div>
            ))}
          </div>
          <div className="callout" style={{ marginTop: '1.2rem' }}>
            <p style={{ margin: 0 }}>下面每一节,都是从一个真实痛点里长出来的。</p>
          </div>
        </Section>

        {/* ── §7-§13 七个痛点 ──────────────────────────────── */}
        <Section id="pain-points">
          <SectionHead
            num="7"
            title="七个真实痛点"
            src="§7-§13"
            lede="每加一个模块,都应该能回答「它解决了哪一个具体问题」。下面是七个真实踩出来的坑,以及填法。"
          />

          <PainPoints />
        </Section>

        {/* ── §14 对比 ──────────────────────────────────────── */}
        <Section id="compare">
          <SectionHead
            num="14"
            title="和 Claude Code 的对比"
            src="§14"
            lede="B Code 在架构思想上和 Claude Code 高度一致,在工程选择上有明显取舍。这不是「模仿」,而是同一个问题的正确答案会收敛到相似的形状 —— 就像所有数据库都有 B+ 树,不是互相抄。"
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
              <ol style={{ fontSize: '0.85rem', color: 'var(--text-dim)', margin: '0 0 0.6rem', paddingLeft: '1.2rem' }}>
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
            src="§15"
            lede="从零开始的正确顺序(也是 B Code 实际的演进路径)。"
          />

          <RoadmapVisual />
        </Section>

        {/* ── §17 结语 + 附录 ──────────────────────────────── */}
        <Section id="appendix">
          <SectionHead
            num="17"
            title="结语与速览"
            src="§17 + 附录"
            lede="回到最开始那个四行的循环。那 1.2 万行代码,本质上都是在让这四行能在真实世界里可靠运行。"
          />

          {/* 问题 → 模块:每个模块都为某个具体现实问题而生 */}
          <div style={{ display: 'grid', gap: '0.4rem', marginBottom: '1.6rem' }}>
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
                <span style={{ textAlign: 'center', color: 'var(--accent)', fontSize: '0.8rem' }}>──▶</span>
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
              marginBottom: '1.2rem',
            }}
          >
            <p style={{ margin: 0, fontSize: '1rem', lineHeight: 1.7 }}>
              <strong>{CLOSING_PRINCIPLE}</strong>
            </p>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              fontFamily: 'var(--mono)',
              fontSize: '0.8rem',
              color: 'var(--text-faint)',
            }}
          >
            <span>想读代码:从</span>
            <code>src/agent.ts</code>
            <span>搜索</span>
            <code>while</code>
            <span>开始,顺着「它调用了谁」一路看下去 —— 整个项目的结构会自己展开。</span>
          </div>
        </Section>

        {/* ── 知识自测 ──────────────────────────────────────── */}
        <Section id="quiz">
          <SectionHead
            num="✦"
            title="知识自测"
            src="全篇"
            lede="十道题覆盖核心机制。答错不是失败 —— 那正好指出哪一节需要回头再看。每题都标了原文出处。"
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
            <span style={{ fontFamily: 'var(--mono)' }}>
              文档基于 B Code v{SOURCE_META.version} 的实际代码整理 · {SOURCE_META.loc.toLocaleString('en-US')} 行
            </span>
            <a href="#top" style={{ marginLeft: 'auto', textDecoration: 'none' }}>
              回到顶部 ↑
            </a>
          </div>
          {/* 原文勘误保留一行 —— 数字对不上不该静默略过 */}
          <div style={{ marginTop: '0.6rem', fontSize: '0.74rem', color: 'var(--text-faint)' }}>
            已核对源码:{SOURCE_CORRECTIONS.map((c) => `原文「${c.claim}」实测为「${c.actual}」`).join(';')}。
            其余数字(危险命令 9 条、四档模式、压缩阈值)均与代码一致。
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
