import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { STAGES, EPILOGUE } from '../content/journey';

/**
 * 旅程进度轨 —— 左侧常驻,把「一次任务的 9 个时刻」画成一条竖线。
 *
 * 它不是目录,是**进度**:当前位置的圆点会亮,走过的地方连线变实,
 * 还没到的地方保持虚线。这样即使读者滚到任意位置,
 * 也始终知道「现在跑到任务的哪一步了」。
 */
export function JourneyRail() {
  const [active, setActive] = useState<string>('ask');
  const [passed, setPassed] = useState<Set<string>>(new Set());
  const reduce = useReducedMotion();

  useEffect(() => {
    const ids = [...STAGES.map((s) => s.id), ...EPILOGUE.map((e) => e.id)];
    const els = ids
      .map((id) => document.getElementById(`stage-${id}`) ?? document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    const obs = new IntersectionObserver(
      (entries) => {
        // 取当前视口内最靠上的那块作为「当前时刻」
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActive(visible[0].target.id.replace(/^stage-/, ''));
        }
        // 记录所有「顶部已滚过视口 60%」的段落
        setPassed((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            if (e.isIntersecting && e.boundingClientRect.top < window.innerHeight * 0.4) {
              next.add(e.target.id.replace(/^stage-/, ''));
            }
          }
          return next;
        });
      },
      { rootMargin: '-15% 0px -55% 0px', threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  const activeIdx = STAGES.findIndex((s) => s.id === active);
  const progress = activeIdx >= 0 ? (activeIdx + 1) / STAGES.length : 0;

  return (
    <nav
      aria-label="任务进度"
      style={{
        position: 'fixed',
        // 贴在内容区左侧的留白里;视口不够宽时(内容会被挤)自动隐藏,避免重叠
        left: 'max(0.75rem, calc((100vw - 68rem) / 2 - 12rem))',
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        width: '10.5rem',
      }}
      className="journey-rail"
    >
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: '0.66rem',
          color: 'var(--text-faint)',
          letterSpacing: '0.06em',
          marginBottom: '0.6rem',
        }}
      >
        一次任务的 9 个时刻
      </div>

      <div style={{ position: 'relative', paddingLeft: '1.1rem' }}>
        {/* 竖线:底色 + 已走过的实色 */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 5,
            top: 8,
            bottom: 8,
            width: 1,
            background: 'var(--border)',
          }}
        />
        <motion.div
          aria-hidden="true"
          animate={{ height: `${progress * 100}%` }}
          transition={{ duration: reduce ? 0 : 0.4, ease: [0.4, 0, 0.2, 1] }}
          style={{
            position: 'absolute',
            left: 5,
            top: 8,
            width: 1,
            background: 'var(--accent)',
            maxHeight: 'calc(100% - 16px)',
          }}
        />

        {STAGES.map((s) => {
          const on = active === s.id;
          const done = passed.has(s.id) && !on;
          return (
            <a
              key={s.id}
              href={`#stage-${s.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.28rem 0',
                textDecoration: 'none',
                position: 'relative',
              }}
            >
              {/* 圆点 */}
              <motion.span
                animate={{
                  scale: on ? 1.35 : 1,
                  backgroundColor: on
                    ? 'var(--accent)'
                    : done
                      ? 'var(--accent-line)'
                      : 'var(--bg)',
                  borderColor: on || done ? 'var(--accent)' : 'var(--border-strong)',
                }}
                transition={{ duration: reduce ? 0 : 0.2 }}
                style={{
                  position: 'absolute',
                  left: -11,
                  width: 9,
                  height: 9,
                  borderRadius: 999,
                  border: '1px solid',
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: '0.62rem',
                  color: on ? 'var(--accent-text)' : 'var(--text-faint)',
                  width: '0.7rem',
                  flexShrink: 0,
                }}
              >
                {s.n}
              </span>
              <span
                style={{
                  fontSize: '0.76rem',
                  color: on ? 'var(--accent-text)' : done ? 'var(--text-dim)' : 'var(--text-faint)',
                  fontWeight: on ? 650 : 400,
                  lineHeight: 1.4,
                  transition: 'color 0.2s',
                }}
              >
                {s.short}
              </span>
            </a>
          );
        })}

        {/* 余论:用虚线表示「主线之外」 */}
        <div
          style={{
            marginTop: '0.5rem',
            paddingTop: '0.5rem',
            borderTop: '1px dashed var(--border)',
            display: 'grid',
            gap: '0.2rem',
          }}
        >
          {EPILOGUE.map((e) => {
            const on = active === e.id;
            return (
              <a
                key={e.id}
                href={`#${e.id}`}
                style={{
                  fontSize: '0.74rem',
                  color: on ? 'var(--accent-text)' : 'var(--text-faint)',
                  fontWeight: on ? 650 : 400,
                  textDecoration: 'none',
                  paddingLeft: '0.7rem',
                }}
              >
                {e.short}
              </a>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
