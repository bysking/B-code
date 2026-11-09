import { DANGEROUS_COMMANDS, SENSITIVE_COMMANDS, CMD_BOUNDARY_NOTE } from '../content/knowledge';

/**
 * 危险命令清单 —— 那 9 条「任何模式都拒」的正则,逐条摆出来。
 *
 * 分两栏是刻意的:
 *   上  半 —— 危险(deny),谁都绕不过
 *   下半 —— 敏感(confirm),问你一次就能记住
 * 读者看完模拟器里的 rm -rf,正好在这里看到它具体命中了哪一条正则。
 */

/** 把 `xxx` 包起来的部分渲染成 inline code —— 源文案里就是用反引号标的 */
function inline(text: string) {
  return text.split('`').map((seg, i) =>
    i % 2 === 1 ? (
      <code key={i} style={{ fontSize: '0.85em' }}>
        {seg}
      </code>
    ) : (
      <span key={i}>{seg}</span>
    ),
  );
}

function Row({
  pattern,
  why,
  regex,
  tone,
}: {
  pattern: string;
  why: string;
  regex?: string;
  tone: 'red' | 'amber';
}) {
  const c = tone === 'red' ? { fg: 'var(--red)', line: 'var(--red-line)' } : { fg: 'var(--amber)', line: 'var(--amber-line)' };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 9.5rem) minmax(0, 1fr)',
        gap: '0.7rem',
        alignItems: 'baseline',
        padding: '0.3rem 0',
        borderTop: `1px solid ${c.line}`,
      }}
    >
      <code style={{ fontSize: '0.8rem', color: c.fg, fontWeight: 650 }}>{pattern}</code>
      <div style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>
        {why}
        {regex && (
          <span
            style={{
              display: 'block',
              fontFamily: 'var(--mono)',
              fontSize: '0.72rem',
              color: 'var(--text-faint)',
              marginTop: 2,
            }}
          >
            {regex}
          </span>
        )}
      </div>
    </div>
  );
}

export function DangerousCommandList() {
  return (
    <div>
      <div style={{ fontSize: '0.78rem', fontFamily: 'var(--mono)', color: 'var(--red)', marginBottom: '0.3rem' }}>
        危险 · 任何模式都拒
      </div>
      {DANGEROUS_COMMANDS.map((c) => (
        <Row key={c.pattern} pattern={c.pattern} why={c.why} regex={c.regex} tone="red" />
      ))}

      <div
        style={{
          fontSize: '0.78rem',
          fontFamily: 'var(--mono)',
          color: 'var(--amber)',
          margin: '0.9rem 0 0.3rem',
        }}
      >
        敏感 · 问你一次,授权后免问
      </div>
      {SENSITIVE_COMMANDS.map((c) => (
        <Row key={c.pattern} pattern={c.pattern} why={c.why} tone="amber" />
      ))}

      <p
        style={{
          margin: '0.9rem 0 0',
          fontSize: '0.82rem',
          color: 'var(--text-dim)',
          borderLeft: '2px solid var(--accent)',
          paddingLeft: '0.7rem',
        }}
      >
        {inline(CMD_BOUNDARY_NOTE)}
      </p>
    </div>
  );
}
