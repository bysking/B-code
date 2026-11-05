import React, { useState } from 'react';
import { Box, Text, useInput } from './ui/index.js';
import type { CapabilityItem, CapabilityKind } from './controller.js';
import { isCompactTerminal, terminalCols, useTerminalSize } from './scroll-budget.js';
import { scrollWindow } from './scroll-budget.js';

/**
 * 能力面板（/skills、/mcp）：可交互的启停开关。
 *
 * 打开时 App 让出键盘（与 /todo 编辑器同一模式），全部按键在此消费。
 *
 * 键位：↑↓/jk 选择 · 空格 启停 · R 重连（仅 MCP）· Esc 关闭。
 *
 * ## 为什么用"滚动窗口"而不是"头部裁切"
 *
 * 早先的做法是 `clampByLines` 从头截断到面板高度上限，再显示"还有 N 项"。
 * 那意味着**被截掉的项永远看不到、也选不到**——用户装了 20 个技能就永远调不了后面 8 个。
 * 正确语义是窗口随光标滚动：光标到哪，哪一项就保证在可见区内。
 *
 * ## 条数怎么定
 *
 * 按**终端行数**推（外部已知量），不用 `useBoxMetrics` 实测——那会形成自指反馈环：
 * 测量值小 → 只渲染 1 行 → 测量值仍小 → 永远 1 行。高度必须由外部常量推出。
 */

/** 面板最多展示的条数上限（再多就挤占正文了；配合窗口滚动足够） */
const MAX_VISIBLE = 12;
/** 矮终端上限 */
const MAX_VISIBLE_COMPACT = 5;

/**
 * 面板自身除候选项外的固定占用：
 * 上下边框 2 + 标题 1 + 滚动提示 1 + 键位提示 1 + marginTop 1
 */
const PANEL_CHROME_LINES = 6;

/** 当前终端下最多展示几条（rows 由调用方从 useTerminalSize 传入） */
function maxVisibleRows(termRows: number): number {
  const cap = isCompactTerminal() ? MAX_VISIBLE_COMPACT : MAX_VISIBLE;
  // 给视口留至少 3 行，其余才归面板
  const avail = termRows - PANEL_CHROME_LINES - 3;
  return Math.max(1, Math.min(cap, avail));
}

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
  const { rows: termRows } = useTerminalSize();
  const rows = maxVisibleRows(termRows);

  const enabledCount = items.filter((it) => it.enabled).length;
  const title = kind === 'skill' ? '🔧 技能' : '🔌 MCP Server';

  // 光标收敛在 [0, len)：列表变短（启停后重建）时不能越界
  const active = items.length === 0 ? 0 : Math.min(idx, items.length - 1);
  // 滚动窗口：保证 active 落在窗口内（这就是"最后隐藏的项也能看到"的关键）
  const [start, end] = scrollWindow(active, items.length, rows);

  const move = (delta: number) => {
    if (items.length === 0) return;
    setIdx((i) => {
      const cur = Math.min(i, items.length - 1);
      return (cur + delta + items.length) % items.length;
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
      const cur = items[active];
      if (cur) {
        onToggle(cur.name);
        onRefresh?.();
      }
      return;
    }
    // R：仅 MCP 有「重连」语义（技能是本地文件，没有连接可言）
    if ((input === 'r' || input === 'R') && kind === 'mcp') {
      const cur = items[active];
      if (cur) {
        onReconnect?.(cur.name);
        onRefresh?.();
      }
      return;
    }
  });

  const visibleItems = items.slice(start, end);
  const above = start;
  const below = items.length - end;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text bold color="cyan">
        {title} · {enabledCount} 启用 / {items.length}
      </Text>

      {items.length === 0 ? (
        <Text dimColor>({kind === 'skill' ? '没有可用技能' : '没有配置 MCP server'})</Text>
      ) : (
        visibleItems.map((it, i) => {
          const isActive = start + i === active;
          return (
            <Box key={it.name}>
              <Text color={isActive ? 'cyan' : undefined} bold={isActive}>
                {isActive ? '❯ ' : '  '}
              </Text>
              {/* 勾选框：与 /todo 编辑器同一套视觉语言 */}
              <Text color={it.enabled ? 'green' : undefined}>{it.enabled ? '☑' : '☐'} </Text>
              <Text
                color={isActive ? 'cyan' : undefined}
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

      {/* 滚动位置：上面/下面各有几项，比"还有 N 项"信息更全（用户可以往回翻） */}
      {above > 0 || below > 0 ? (
        <Text dimColor>
          {' '}
          {above > 0 ? `↑ ${above} ` : ''}
          {active + 1}/{items.length}
          {below > 0 ? ` ↓ ${below}` : ''}
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
 * 面板实际渲染行数（供布局预算与测试断言）。
 *
 * 面板自身是 `flexShrink={0}` 的底栏内容，实际不会被压缩；这个函数给出的是
 * "按当前终端高度，面板会占多少行"，用于验证不会挤占正文。
 */
export function capabilityPanelHeight(items: CapabilityItem[], termRows = 40): number {
  if (items.length === 0) return PANEL_CHROME_LINES + 1;
  const rows = maxVisibleRows(termRows);
  // chrome + 可见条数 + （有滚动提示时 +1）
  return PANEL_CHROME_LINES + Math.min(items.length, rows) + (items.length > rows ? 1 : 0);
}

/** 供测试断言：当前终端下最多可见几条 */
export function capabilityVisibleRows(termRows = 40): number {
  return maxVisibleRows(termRows);
}

/** 供测试断言：面板固定 chrome 行数 */
export const CAPABILITY_CHROME_LINES = PANEL_CHROME_LINES;
