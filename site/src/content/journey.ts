/**
 * 任务时间线 —— 整个站点的唯一主轴。
 *
 * 不再按「章节」组织内容,而是跟着一条真实指令走完一遍:
 * 「这个 bug 帮我修一下」。每个模块只在**它被需要的那一刻**登场,
 * 讲完立刻回到主线继续跑。
 *
 * 原文的章节号保留在 `src` 里,方便回溯到 SHARING.md。
 */

export type StageId =
  | 'ask'
  | 'loop'
  | 'prompt'
  | 'backend'
  | 'tools'
  | 'permissions'
  | 'context'
  | 'subagent'
  | 'goal'
  | 'done'
  | 'memory';

export interface Stage {
  id: StageId;
  /** 在第几步发生 */
  n: number;
  /** 主线上发生了什么 */
  event: string;
  /** 此刻登场的模块(没讲完的模块名) */
  module?: string;
  /** 一句话说清「为什么现在需要它」 */
  why: string;
  /** 回溯到原文 */
  src: string;
  /** 时间线缩略标签 */
  short: string;
}

export const STAGES: Stage[] = [
  {
    id: 'ask',
    n: 1,
    event: '你说:「这个项目的测试挂了,帮我看看」',
    why: '聊天机器人到这就只能给你一段代码。Agent 从这里开始动手。',
    src: '§0',
    short: '你开口',
  },
  {
    id: 'loop',
    n: 2,
    event: '消息发给模型 → 模型决定:先读 package.json',
    module: '核心循环',
    why: '决定下一步做什么的是模型,不是代码。这个循环是整个工具的心脏。',
    src: '§1',
    short: '循环转起来',
  },
  {
    id: 'prompt',
    n: 3,
    event: '每次请求都要把「我是谁、该怎么干」重新讲一遍',
    module: 'System Prompt',
    why: '模型没有记忆,每一轮都是新来的。而这段话怎么写、怎么排,直接决定成本和行为稳定性。',
    src: '§7',
    short: '先立规矩',
  },
  {
    id: 'backend',
    n: 4,
    event: '这一轮大模型请求走DeepSeek（也支持Anthropic）',
    module: '后端层',
    why: '两类消息格式不一样。不统一适配层,循环里就会硬编码长满 if/else。',
    src: '§3',
    short: '换个模型',
  },
  {
    id: 'tools',
    n: 5,
    event: '模型说:我要调 read_file,参数 {"path":"package.json"}',
    module: '工具系统',
    why: '模型不是「知道」能读文件 —— 是每次请求里都给了它一份清单。',
    src: '§4',
    short: '它要动手了',
  },
  {
    id: 'permissions',
    n: 6,
    event: '下一步它想跑 rm -rf node_modules 重装依赖',
    module: '权限系统',
    why: '这是唯一一个「没有就不能给真人用」的模块 —— 所以它必须拦在最前面。',
    src: '§5',
    short: '差点删库',
  },
  {
    id: 'context',
    n: 7,
    event: '跑到第 41 轮,它 cat 了一个 10 万行日志',
    module: '上下文',
    why: '单次结果就吃掉大半窗口。不设防线,后面全都没空间。',
    src: '§4 / §8',
    short: '塞不下了',
  },
  {
    id: 'subagent',
    n: 8,
    event: '它需要查「这个项目用什么测试框架」',
    module: '子 Agent',
    why: '自己读 20 个文件会把主上下文弄脏。派个临时工读完就扔。',
    src: '§10',
    short: '派个人去查',
  },
  {
    id: 'goal',
    n: 9,
    event: '你说:「一直改到测试通过为止」',
    module: '目标评估器',
    why: '让干活的自己打分,它倾向于说「我干完了」。得找个独立的来判断。',
    src: '§12',
    short: '谁说了算',
  },
  {
    id: 'done',
    n: 10,
    event: '578 passed, 0 failed —— 修好了',
    why: '1.2 万行代码,本质上都是为了让最开始那个循环能在真实世界里跑稳。',
    src: '§17',
    short: '跑通了',
  },
  {
    id: 'memory',
    n: 11,
    event: '关掉终端,第二天在新目录里重新打开:你还得再说一遍「用 pnpm,别用 npm」',
    module: '持久化记忆',
    why: '前面每一节都在解决「这一次会话」的问题,只有它是为「下一次会话」准备的 —— 写完就扔的上下文,需要一条能跨过进程边界的通道。',
    src: '§14',
    short: '记住下次',
  },
];

/** 时间线之外、作为「余论」的两节 */
export const EPILOGUE = [
  { id: 'compare', title: '和 Claude Code 对比', src: '§14', short: '对比' },
  { id: 'roadmap', title: '建议的实现顺序', src: '§15', short: '顺序' },
  { id: 'quiz', title: '知识自测', src: '全篇', short: '自测' },
] as const;
