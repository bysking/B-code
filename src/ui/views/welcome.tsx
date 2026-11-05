import { COLORS, attrs, tone } from '../primitives/theme.js';

/**
 * 启动欢迎横幅。
 *
 * ## 为什么需要
 *
 * 全新会话时历史区是一大片空白（终端 80×24 也就罢了，宽屏下那一屏空白很扎眼）。
 * 空态不该是"什么都没显示"，而应该告诉用户：这是哪、能干什么、怎么开始。
 *
 * ## 设计
 *
 * - **只在没有历史时显示**：一旦有对话内容，横幅就让位（避免占掉宝贵的可视区）
 * - 用 ASCII 大字 + 一句 slogan + 快捷上手提示
 * - 配色沿用主题（accent 描边、muted 说明），不引入新色
 *
 * 横幅宽度按终端自适应：太窄时降级成单行标题，不硬塞大字。
 */

/** ASCII 大字：BC 的方块字母（每级都是等宽，拼接后对齐） */
const BANNER_LINES = [
  '██████╗  ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██████╔╝██║     ██║   ██║██║  ██║█████╗  ',
  '██╔══██╗██║     ██║   ██║██║  ██║██╔══╝  ',
  '██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

/** ASCII 大字占用宽度（所有行等宽） */
const BANNER_WIDTH = BANNER_LINES[0]!.length;
/** 加上左右 padding 与边框后的最小终端宽度 */
const MIN_WIDTH_FOR_BANNER = BANNER_WIDTH + 6;

/** 上手提示（按顺序展示，帮助新用户快速开始） */
const TIPS: { key: string; desc: string }[] = [
  { key: '/', desc: '唤起命令菜单' },
  { key: 'Shift+Tab', desc: '切换权限模式' },
  { key: 'Ctrl+O', desc: '查看工具输出' },
  { key: 'Esc', desc: '中断当前对话' },
];

export function Welcome({ cols, version }: { cols: number; version?: string }) {
  const wide = cols >= MIN_WIDTH_FOR_BANNER;

  return (
    <box flexDirection="column" marginBottom={2} paddingY={1}>
      {wide ? (
        // 宽终端：ASCII 大字
        <box flexDirection="column" marginBottom={1}>
          {BANNER_LINES.map((line, i) => (
            <text key={i} fg={tone('accent')} attributes={attrs('bold')} wrapMode="none">
              {line}
            </text>
          ))}
        </box>
      ) : (
        // 窄终端：降级成单行标题（大字会折行成一团）
        <text fg={tone('accent')} attributes={attrs('bold')}>
          B CODE{version ? ` v${version}` : ''}
        </text>
      )}

      <text fg={tone('text')} attributes={attrs('bold')}>
        每一个伟大的背后，都来源于一次勇敢的尝试。
      </text>
      {/* 副标题：大字模式下补品牌名与版本（大字只有 "BC" 缩写）；窄终端标题已含，只留描述 */}
      <text fg={tone('muted')}>
        {wide
          ? `B Code${version ? ` v${version}` : ''} · 终端里的 AI 编程助手_@bysking`
          : '终端里的 AI 编程助手_@bysking'}
      </text>

      <box flexDirection="column" marginTop={1}>
        {TIPS.map((t) => (
          <text key={t.key} fg={tone('muted')}>
            <span fg={tone('user')}>{t.key}</span>
            {'  '}
            {t.desc}
          </text>
        ))}
      </box>

      <box marginTop={1}>
        <text fg={COLORS.muted} attributes={attrs('dim')}>
          直接输入你想做的事，或输入 / 查看全部命令
        </text>
      </box>
    </box>
  );
}

/** 供布局预算用：横幅占用的行数（宽/窄两种形态） */
export function welcomeHeight(cols: number): number {
  return cols >= MIN_WIDTH_FOR_BANNER
    ? BANNER_LINES.length + 2 + 1 + TIPS.length + 1 + 1 // 大字 + slogan + 提示 + 底部
    : 1 + 2 + TIPS.length + 1 + 1; // 单行标题 + slogan + 提示 + 底部
}
