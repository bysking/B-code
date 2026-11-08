import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { SECTIONS } from '../content/knowledge';

/** 顶部导航 + 阅读进度条 */
export function Nav() {
  const [active, setActive] = useState<string>('');
  const [progress, setProgress] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      setProgress(max > 0 ? (doc.scrollTop / max) * 100 : 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // 用 IntersectionObserver 标记当前所在章节
  useEffect(() => {
    const ids = SECTIONS.map((s) => s.id);
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-10% 0px -70% 0px', threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'var(--bg-nav)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          height: 2,
          background: 'transparent',
          position: 'absolute',
          inset: 'auto 0 -1px 0',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${progress}%`,
            background: 'var(--accent)',
            transition: 'width 80ms linear',
          }}
        />
      </div>

      <div
        className="wrap"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          minHeight: '3.4rem',
          padding: '0.4rem 1.5rem',
        }}
      >
        <a
          href="#top"
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '0.85rem',
            fontWeight: 700,
            color: 'var(--text-strong)',
            textDecoration: 'none',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: '0.45rem',
          }}
        >
          <span style={{ color: 'var(--green)' }}>❯</span> B Code 架构
        </a>

        <nav
          aria-label="章节导航"
          className="nav-links"
          style={{
            display: 'flex',
            gap: '0.15rem',
            overflowX: 'auto',
            scrollbarWidth: 'none',
            flex: 1,
          }}
        >
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              aria-current={active === s.id ? 'true' : undefined}
              style={{
                fontSize: '0.78rem',
                padding: '0.3rem 0.55rem',
                borderRadius: 5,
                whiteSpace: 'nowrap',
                textDecoration: 'none',
                color: active === s.id ? 'var(--accent)' : 'var(--text-dim)',
                background: active === s.id ? 'var(--accent-bg)' : 'transparent',
                fontWeight: active === s.id ? 600 : 400,
              }}
            >
              {s.num !== '' ? `${s.num} ` : ''}
              {s.short}
            </a>
          ))}
        </nav>

        <button
          className="btn btn-ghost btn-sm nav-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-nav"
        >
          {open ? '收起' : '目录'}
        </button>
      </div>

      {open && (
        <nav
          id="mobile-nav"
          aria-label="章节导航(移动端)"
          className="wrap"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
            gap: '0.3rem',
            padding: '0 1.5rem 0.9rem',
          }}
        >
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={() => setOpen(false)}
              style={{
                fontSize: '0.8rem',
                padding: '0.35rem 0.5rem',
                borderRadius: 5,
                textDecoration: 'none',
                color: active === s.id ? 'var(--accent)' : 'var(--text-dim)',
                background: active === s.id ? 'var(--accent-bg)' : 'transparent',
              }}
            >
              {s.num} {s.title}
            </a>
          ))}
        </nav>
      )}
    </header>
  );
}

/** 章节标题 + 原文锚点回溯 */
export function SectionHead({
  num,
  title,
  src,
  lede,
}: {
  num: string;
  title: string;
  src: string;
  lede?: string;
}) {
  return (
    <>
      <div className="section-head">
        <span className="section-num">{num}</span>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="src-note" title="SHARING.md 中的章节">
          原文 {src}
        </span>
      </div>
      {lede && <p className="section-lede">{lede}</p>}
    </>
  );
}

/** 可展开的细节块 —— 渐进式披露 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const reduce = useReducedMotion();

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        marginBottom: '0.7rem',
        overflow: 'hidden',
        background: 'var(--bg-raised)',
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          padding: '0.65rem 0.95rem',
          background: 'transparent',
          border: 'none',
          color: 'var(--text)',
          fontFamily: 'var(--sans)',
          fontSize: '0.9rem',
          fontWeight: 550,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span>{summary}</span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          aria-hidden="true"
          style={{ color: 'var(--text-faint)', fontSize: '0.7rem', flexShrink: 0 }}
        >
          ▼
        </motion.span>
      </button>
      {open && (
        <motion.div
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          transition={{ duration: reduce ? 0 : 0.22, ease: [0.4, 0, 0.2, 1] }}
          style={{ overflow: 'hidden' }}
        >
          <div
            style={{
              padding: '0 0.95rem 0.9rem',
              fontSize: '0.9rem',
              color: 'var(--text-dim)',
              borderTop: '1px solid var(--border)',
              paddingTop: '0.8rem',
            }}
          >
            {children}
          </div>
        </motion.div>
      )}
    </div>
  );
}
