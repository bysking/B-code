import { useMemo, useState } from 'react';
import { PERM_MODES, TOOLS } from '../content/knowledge';
import { PermissionFlowchart } from './Diagrams';

/**
 * 权限判定模拟器 —— 严格镜像 src/permissions.ts 的 checkPermission + resolvePermission。
 *
 * 这是全站最需要精确的一块:判定顺序本身就是设计,展示错了就失去了说服力。
 * 下面的正则与源码逐条一致;`CMD_START` 边界规则也照搬。
 *
 * 版面:左边是「现场」(调模式、写命令),右边是「判定」(判定链 + 结论)。
 * 读者先看到「它想删库」这一刻,再顺着右边的链子看这条命令走到哪一步。
 */

const CMD_START = /(?:^|[;&|]\s*)/;

/** 与 DANGEROUS_PATTERNS 一一对应 */
const DANGEROUS: RegExp[] = [
  /\brm\s+-rf\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
  />\s*\/dev\//,
  new RegExp(`${CMD_START.source}dd\\s`),
  new RegExp(`${CMD_START.source}kill\\b`),
  new RegExp(`${CMD_START.source}reboot\\b`),
  new RegExp(`${CMD_START.source}shutdown\\b`),
];

const SENSITIVE: RegExp[] = [/\bgit\s+push\b/];

type Mode = 'default' | 'plan' | 'auto' | 'bypass';
type ToolMode = 'read' | 'write' | 'shell' | 'external';

interface Outcome {
  verdict: 'allow' | 'deny' | 'confirm';
  /** 命中的规则序号 ①-⑤,或特殊分支标记 */
  rule: string;
  ruleLabel: string;
  /** bypass 下最终是否真的放行 */
  finalAllow: boolean;
  /** 是否需要弹确认框 */
  asksUser: boolean;
  /** 为什么 */
  reason: string;
  /** 备注(如 auto 分类器、白名单) */
  extra?: string;
}

const RULE_LABELS: Record<string, string> = {
  '0': '⓪ 自授权工具',
  '1': '① 危险命令',
  '2': '② plan 只读契约',
  '3': '③ 只读放行',
  '4': '④ 敏感命令',
  '5': '⑤ fail-closed 兜底',
};

/** 镜像 checkPermission(mp, input, mode) */
function checkPermission(toolMode: ToolMode, selfGranted: boolean, allowInPlan: boolean, command: string, mode: Mode) {
  // ⓪ 自授权
  if (selfGranted) return { verdict: 'allow' as const, rule: '0' };
  // ① 危险命令(任何模式)
  if (toolMode === 'shell' && DANGEROUS.some((re) => re.test(command))) {
    return { verdict: 'deny' as const, rule: '1' };
  }
  // ② plan 只读契约
  if (mode === 'plan' && toolMode !== 'read' && !allowInPlan) {
    return { verdict: 'deny' as const, rule: '2' };
  }
  // ③ 只读放行
  if (toolMode === 'read') return { verdict: 'allow' as const, rule: '3' };
  // ④ 敏感命令
  if (toolMode === 'shell' && SENSITIVE.some((re) => re.test(command))) {
    return { verdict: 'confirm' as const, rule: '4' };
  }
  // ⑤ fail-closed
  return { verdict: 'confirm' as const, rule: '5' };
}

/** 镜像 resolvePermission:把三态 + 模式解析成最终行为 */
function resolve(
  toolMode: ToolMode,
  selfGranted: boolean,
  allowInPlan: boolean,
  command: string,
  mode: Mode,
  allowlisted: boolean,
): Outcome {
  const { verdict, rule } = checkPermission(toolMode, selfGranted, allowInPlan, command, mode);
  const ruleLabel = RULE_LABELS[rule] ?? rule;

  if (verdict === 'deny') {
    const reason =
      rule === '1'
        ? '命中危险命令清单 —— 不可逆操作,任何模式(含 bypass)都拒绝,没有例外。'
        : rule === '2'
          ? 'plan 模式下非只读操作一律拦截(allowInPlan 的 write_plan 除外)。'
          : '被权限系统拒绝。';
    return { verdict, rule, ruleLabel, finalAllow: false, asksUser: false, reason };
  }

  if (verdict === 'allow') {
    const reason =
      rule === '0'
        ? 'selfGranted:与用户对话本身,不该再触发一次权限确认。'
        : rule === '3'
          ? '只读操作不需要打扰用户。'
          : '放行。';
    return { verdict, rule, ruleLabel, finalAllow: true, asksUser: false, reason };
  }

  // ── verdict === 'confirm' ──
  const sensitive = toolMode === 'shell' && SENSITIVE.some((re) => re.test(command));

  // auto 模式:写/shell 先过分类器;敏感命令跳分类器
  if (!sensitive && mode === 'auto' && (toolMode === 'write' || toolMode === 'shell')) {
    return {
      verdict,
      rule,
      ruleLabel,
      finalAllow: true,
      asksUser: false,
      reason: 'auto 模式:由 AI 分类器代替你判断(此处假设分类器通过)。',
      extra: '分类器若拒绝,则拦下 —— 相当于「信任但留一道保险」。',
    };
  }

  // bypass 跳过确认,但敏感命令连 bypass 也要问
  if (mode === 'bypass' && !sensitive) {
    return {
      verdict,
      rule,
      ruleLabel,
      finalAllow: true,
      asksUser: false,
      reason: 'bypass 模式:不问,直接干。',
    };
  }

  // 白名单命中则免问
  if (allowlisted) {
    return {
      verdict,
      rule,
      ruleLabel,
      finalAllow: true,
      asksUser: false,
      reason: '白名单命中:这条你已经授权过「以后别问」。',
      extra: sensitive ? '敏感命令也可经用户授权后写入白名单。' : undefined,
    };
  }

  // 否则问用户
  const reason = sensitive
    ? '敏感但可商量:一律人工确认 —— auto 模式也跳过分类型器,bypass 也要问。确认后可持久化免问。'
    : 'fail-closed:未声明类型的工具默认要求确认,而不是默认放行。';
  return { verdict, rule, ruleLabel, finalAllow: false, asksUser: true, reason };
}

/** 示例命令 —— 覆盖每个分支 */
const PRESETS: { label: string; tool: string; command: string; hint: string }[] = [
  { label: 'rm -rf node_modules', tool: 'run_shell', command: 'rm -rf node_modules', hint: '危险 → 任何模式都拒' },
  { label: 'ls -la', tool: 'run_shell', command: 'ls -la', hint: '普通命令 → 确认' },
  { label: 'git push origin main', tool: 'run_shell', command: 'git push origin main', hint: '敏感 → auto/bypass 也要问' },
  { label: 'git reset --hard HEAD~1', tool: 'run_shell', command: 'git reset --hard HEAD~1', hint: '危险 → 拒' },
  { label: 'ls; kill 2', tool: 'run_shell', command: 'ls; kill 2', hint: '命令边界 → 危险' },
  { label: 'npm run kill-port', tool: 'run_shell', command: 'npm run kill-port', hint: '不误杀(非命令边界)' },
];

export function PermissionSimulator() {
  // 开局就是这一节标题里的那个时刻:它想删 node_modules 重装依赖
  const [mode, setMode] = useState<Mode>('default');
  const [tool, setTool] = useState('run_shell');
  const [command, setCommand] = useState('rm -rf node_modules');
  const [allowlisted, setAllowlisted] = useState(false);

  const toolMeta = TOOLS.find((t) => t.name === tool);
  const toolMode: ToolMode = toolMeta?.mode ?? 'external';
  const selfGranted = tool === 'ask_user' || tool === 'todo_write';
  const allowInPlan = tool === 'write_plan';

  const outcome = useMemo(
    () => resolve(toolMode, selfGranted, allowInPlan, command, mode, allowlisted),
    [toolMode, selfGranted, allowInPlan, command, mode, allowlisted],
  );

  const dangerousHit = toolMode === 'shell' ? DANGEROUS.some((re) => re.test(command)) : false;
  const sensitiveHit = toolMode === 'shell' ? SENSITIVE.some((re) => re.test(command)) : false;

  const activeMode = PERM_MODES.find((m) => m.id === mode);

  const verdictColor =
    outcome.verdict === 'deny' ? 'var(--red)' : outcome.asksUser ? 'var(--amber)' : 'var(--green)';
  const verdictBg =
    outcome.verdict === 'deny' ? 'var(--red-bg)' : outcome.asksUser ? 'var(--amber-bg)' : 'var(--green-bg)';
  const verdictLine =
    outcome.verdict === 'deny' ? 'var(--red-line)' : outcome.asksUser ? 'var(--amber-line)' : 'var(--green-line)';
  const verdictText = outcome.asksUser ? 'confirm' : outcome.verdict;

  return (
    <div
      style={{
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--bg-raised)',
        overflow: 'hidden',
      }}
    >
      <div className="perm-cols">
        {/* ══ 左:现场 —— 调模式、写命令 ══ */}
        <div className="perm-console">
          {/* 模式 */}
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 1rem' }}>
            <legend className="perm-label" style={{ marginBottom: '0.4rem' }}>
              模式
            </legend>
            <div className="btn-row">
              {PERM_MODES.map((m) => (
                <button
                  key={m.id}
                  className={`btn btn-sm ${mode === m.id ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setMode(m.id)}
                  aria-pressed={mode === m.id}
                  title={`${m.onWrite} —— ${m.when}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {/* 选中的模式当下解释,替代原来的三列表格 */}
            <p
              style={{
                fontSize: '0.78rem',
                color: 'var(--text-faint)',
                margin: '0.45rem 0 0',
                minHeight: '1.2rem',
              }}
            >
              {activeMode?.onWrite} · {activeMode?.when}
            </p>
          </fieldset>

          {/* 工具 */}
          <div style={{ marginBottom: '1rem' }}>
            <label htmlFor="perm-tool" className="perm-label">
              工具
            </label>
            <select
              id="perm-tool"
              className="perm-input"
              value={tool}
              onChange={(e) => setTool(e.target.value)}
            >
              {TOOLS.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} — {t.mode}
                  {t.note ? ` · ${t.note}` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* 命令输入 */}
          {toolMode === 'shell' && (
            <div style={{ marginBottom: '1rem' }}>
              <label htmlFor="perm-cmd" className="perm-label">
                命令
              </label>
              <input
                id="perm-cmd"
                type="text"
                className={`perm-input${dangerousHit ? ' perm-input-danger' : ''}`}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                spellCheck={false}
              />
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setTool(p.tool);
                      setCommand(p.command);
                    }}
                    title={p.hint}
                    style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem' }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.82rem',
              color: 'var(--text-dim)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={allowlisted}
              onChange={(e) => setAllowlisted(e.target.checked)}
              style={{ accentColor: 'var(--accent)', width: 15, height: 15 }}
            />
            已在白名单中(此前授权过「以后别问」)
          </label>
        </div>

        {/* ══ 右:判定 —— 这条命令走到哪一步、结论是什么 ══ */}
        <div className="perm-decision">
          <div>
            <div className="perm-label" style={{ marginBottom: '0.7rem' }}>
              判定流程
            </div>
            <PermissionFlowchart
              outcome={{ rule: outcome.rule, verdict: outcome.verdict, asksUser: outcome.asksUser }}
            />
          </div>

          {/* 结论 */}
          <div
            style={{
              border: `1px solid ${verdictLine}`,
              background: verdictBg,
              borderRadius: 8,
              padding: '0.7rem 0.85rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.7rem',
                marginBottom: '0.35rem',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  color: verdictColor,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {verdictText}
              </span>
              <span className="src-note">命中 {outcome.ruleLabel}</span>
              {sensitiveHit && (
                <span className="tag tag-write" style={{ fontSize: '0.65rem' }}>
                  敏感命令:auto 跳分类器 · bypass 仍要问
                </span>
              )}
              {outcome.verdict === 'deny' && (
                <span className="tag tag-shell" style={{ fontSize: '0.65rem' }}>
                  任何模式都绕不过
                </span>
              )}
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)', margin: 0 }}>{outcome.reason}</p>
            {outcome.extra && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-faint)', margin: '0.35rem 0 0' }}>
                {outcome.extra}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
