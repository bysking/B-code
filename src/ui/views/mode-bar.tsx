import type { Mode } from '../../permissions.js';
import { COLORS, MODE_TONE, attrs, tone } from '../primitives/theme.js';

/**
 * 底部模式栏：展示当前权限模式 + 版本更新提示。
 *
 * OpenTUI 写法注意：`<box>` 默认是 column，横向排列要显式 flexDirection="row"。
 */

const MODE_LABEL: Record<Mode, string> = {
  default: 'default',
  plan: 'plan',
  auto: 'auto',
  bypass: 'bypass',
};

export function ModeBar({
  mode,
  updateInfo,
}: {
  mode: Mode;
  updateInfo?: { current: string; latest: string } | null;
}) {
  const label = MODE_LABEL[mode] ?? 'default';
  const color = tone(MODE_TONE[mode] ?? 'accent');

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={COLORS.statusText}>当前权限审批模式（Shift+Tab 切换）：── </text>
        <text fg={color} attributes={attrs('bold')}>
          {label}
        </text>
        <text fg={COLORS.statusText}> ──</text>
      </box>
      {updateInfo ? (
        <box flexDirection="row">
          <text fg={COLORS.warning}>
            ⬆️ 发现新版本 v{updateInfo.current} → v{updateInfo.latest}，运行 npm i -g
            @bysking/b-code 升级
          </text>
        </box>
      ) : null}
    </box>
  );
}
