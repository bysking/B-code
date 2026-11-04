import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CapabilityItem, CapabilityKind } from './controller.js';
import { clampByLines, isCompactTerminal, terminalCols } from './scroll-budget.js';

/**
 * 能力面板（/skills、/mcp）：可交互的启停开关。
 *
 * 打开时 App 让出键盘（与 /todo 编辑器同一模式），全部按键在此消费。
 *
 * 键位：↑↓/jk 选择 · 空格 启停 · R 重连（仅 MCP）· Esc 关闭。
 *
 * 为什么不用 Select/多选组件：那些是「一次性提交」语义，而这里每次空格都要
 * 立即生效并落盘（用户边看边调）。持续编辑形态与 UserTodoEditor 一致。
 *
 * 高度约束：面板撑超终端行数会触发 ink 整屏清屏（连 scrollback 一起清），
 * 项目里反复踩过——因此用 clampByLines 按**渲染行数**裁切，不是按条数。
 */

/** 面板最多占用的行数（含边框/标题/提示行） */
const MAX_PANEL_LINES = 16;
/** 矮终端下的上限：正文才是主体，面板得让位 */
const MAX_PANEL_LINES_COMPACT = 8;

/** 面板固定占用：上下边框 2 + 标题 1 + 空行 1 + 键位提示 1 */
const PANEL_CHROME_LINES = 5;

export function CapabilityPanel({
  kind,
  items,
  onToggle,
  onReconnect,
  onClose,
  onRefresh,
}: {
  kind: CapabilityKind;
  items: CapabilityItem[];
  /** 空格：切换该项启停（父层负责落盘与重建列表） */
  onToggle: (name: string) => void;
  /** R：重连该 MCP server（仅 kind === 'mcp' 时可达） */
  onReconnect?: (name: string) => void;
  onClose: () => void;
  /** 每次按键后可选地重拉数据（避免外部变化导致列表过期） */
  onRefresh?: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const cols = terminalCols();
  const maxLines = isCompactTerminal() ? MAX_PANEL_LINES_COMPACT : MAX_PANEL_LINES;

  const enabledCount = items.filter((it) => it.enabled).length;
  const title = kind === 'skill' ? '🔧 技能' : '🔌 MCP Server';

  // 按渲染行数裁切：每项可能因描述过长折成 2 行，只限条数会撑爆面板
  const { visible, hidden } = clampByLines(
    items,
    (it) => (it.detail ? `${it.name}  ${it.detail}` : it.name),
    maxLines,
    { cols, reservedLines: PANEL_CHROME_LINES },
  );

  // 选择收敛在可见区内：裁剪窗口变化（列表变短）后光标不能落到看不见的行上
  const clamped = visible.length === 0 ? 0 : Math.min(idx, visible.length - 1);

  const move = (delta: number) => {
    if (visible.length === 0) return;
    setIdx((i) => {
      const cur = Math.min(i, visible.length - 1);
      return (cur + delta + visible.length) % visible.length;
    });
  };

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow || input === 'k') {
      move(-1);
      return;
    }
    if (key.downArrow || input === 'j') {
      move(1);
      return;
    }
    if (input === ' ') {
      const cur = visible[clamped];
      if (cur) {
        onToggle(cur.name);
        onRefresh?.();
      }
      return;
    }
    // R：仅 MCP 有「重连」语义（技能是本地文件，没有连接可言）
    if ((input === 'r' || input === 'R') && kind === 'mcp') {
      const cur = visible[clamped];
      if (cur) {
        onReconnect?.(cur.name);
        onRefresh?.();
      }
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold color="cyan">
        {title} · {enabledCount} 启用 / {items.length}
      </Text>

      {items.length === 0 ? (
        <Text dimColor>
          ({kind === 'skill' ? '没有可用技能' : '没有配置 MCP server'})
        </Text>
      ) : (
        visible.map((it, i) => {
          const active = i === clamped;
          return (
            <Box key={it.name}>
              <Text color={active ? 'cyan' : undefined} bold={active}>
                {active ? '❯ ' : '  '}
              </Text>
              {/* 勾选框：与 /todo 编辑器同一套视觉语言 */}
              <Text color={it.enabled ? 'green' : undefined}>{it.enabled ? '☑' : '☐'} </Text>
              <Text
                color={active ? 'cyan' : undefined}
                dimColor={!it.enabled}
                strikethrough={!it.enabled}
              >
                {it.name}
              </Text>
              {it.detail ? (
                <Text dimColor>
                  {'  '}
                  {it.detail}
                </Text>
              ) : null}
              {it.notice ? <Text color="yellow"> {it.notice}</Text> : null}
            </Box>
          );
        })
      )}

      {hidden > 0 ? (
        <Text dimColor>
          {' '}
          … 还有 {hidden} 项（面板高度受限）
        </Text>
      ) : null}

      <Text dimColor>
        {kind === 'mcp'
          ? '↑↓ 选择 · 空格 启停 · R 重连 · Esc 关闭'
          : '↑↓ 选择 · 空格 启停 · Esc 关闭'}
      </Text>
    </Box>
  );
}

/**
 * 面板实际渲染行数（供 live 预算扣除，与 capability-panel 渲染同口径）。
 *
 * 必须与渲染端算式一致：预算端少算了面板高度，正文就会按虚高的可用空间分配，
 * 整帧冲出终端 → ink 整屏清屏。
 */
export function capabilityPanelHeight(
  items: CapabilityItem[],
  opts: { cols?: number; compact?: boolean } = {},
): number {
  const cols = opts.cols ?? terminalCols();
  // 空列表：固定 chrome + 一行"(没有可用技能)"
  if (items.length === 0) return PANEL_CHROME_LINES + 1;
  const maxLines = opts.compact ? MAX_PANEL_LINES_COMPACT : MAX_PANEL_LINES;
  const { lines, hidden } = clampByLines(
    items,
    (it) => (it.detail ? `${it.name}  ${it.detail}` : it.name),
    maxLines,
    { cols, reservedLines: PANEL_CHROME_LINES },
  );
  // chrome（含键位提示行）+ 内容行 + 省略提示行（有隐藏项时才出现）
  return PANEL_CHROME_LINES + lines + (hidden > 0 ? 1 : 0);
}

