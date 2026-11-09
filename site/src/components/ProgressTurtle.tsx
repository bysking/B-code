import { useEffect, useState } from 'react';
import { motion, useMotionValue, useSpring, useReducedMotion, useTransform } from 'motion/react';

/**
 * 顶部进度条上的小乌龟 —— 永远慢半拍地追着进度条爬。
 *
 * 实现要点:
 *   真进度条 = 线性跟随滚动(瞬时)
 *   小乌龟   = 弹簧跟随(有惯性、会过冲),所以两者天然产生滞后
 *
 * 只要滚动速度超过弹簧的追赶速度,乌龟就会落在后面;
 * 停下来之后它才慢慢追上去 —— 这正是要的「去追进度条」的观感。
 *
 * 到达终点(>=99%)后:站起来、转身、比心。
 *
 * prefers-reduced-motion 下:不做位移动画,但保留终点的心形(静态)。
 */

/** 弹簧参数:故意偏低频 + 低阻尼,让它追得慢、还能轻微过冲 */
const SPRING = { stiffness: 26, damping: 11, mass: 1.15 };

/** 判定「到终点」的阈值 */
const FINISH_AT = 99;

export function ProgressTurtle({ progress }: { progress: number }) {
  const reduce = useReducedMotion();

  const target = useMotionValue(progress);
  const lagged = useSpring(target, SPRING);

  const [rushing, setRushing] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    target.set(progress);
  }, [progress, target]);

  // 用「乌龟位置」而不是原始进度判定终点,保证它是真的爬到了才庆祝
  useEffect(() => {
    const unsub = lagged.on('change', (v) => {
      const d = progress - v;
      setRushing(Math.abs(d) > 1.2);
      setFinished(v >= FINISH_AT);
    });
    return unsub;
  }, [lagged, progress]);

  // 越落后越前倾(上限 22 度),追上后回到水平;到终点时抬起头
  const rotate = useTransform(lagged, (v) => {
    if (v >= FINISH_AT) return 0;
    const d = progress - v;
    return Math.max(-22, Math.min(22, d * 1.6));
  });

  const left = useTransform(lagged, (v) => `${v}%`);

  return (
    <motion.div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left,
        bottom: 0,
        x: '-50%',
        y: -3,
        pointerEvents: 'none',
        zIndex: 2,
        display: 'flex',
        alignItems: 'flex-end',
      }}
    >
      {/* 屁股后面的喷气:追赶时从尾端喷出小气团 + 加速线 */}
      {!finished && !reduce && <JetPuffs active={rushing} />}

      {/* 落后时拖一条渐隐的尾迹,表示「正在追」 */}
      {!finished && !reduce && (
        <motion.span
          animate={{ opacity: [0.4, 0.15, 0.4] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            position: 'absolute',
            right: '100%',
            bottom: 3,
            width: 20,
            height: 2,
            borderRadius: 2,
            background: 'linear-gradient(90deg, transparent, var(--accent-line))',
            marginRight: 1,
          }}
        />
      )}

      <motion.div
        style={{
          rotate: finished ? undefined : rotate,
          transformOrigin: '60% 85%',
        }}
        animate={
          reduce
            ? undefined
            : finished
              ? {
                  // 魔性跳舞:左右摇摆 + 上下弹跳,节奏不对称才「魔性」
                  rotate: [0, -13, 9, -9, 13, 0],
                  y: [0, -4, 0, -5, 0, -4],
                  scaleX: [1, 1.06, 0.96, 1.06, 0.96, 1],
                }
              : { y: rushing ? [0, -1.6, 0] : [0, -0.45, 0] }
        }
        transition={
          reduce
            ? { duration: 0 }
            : finished
              ? {
                  duration: 1.15,
                  repeat: Infinity,
                  repeatType: 'loop',
                  ease: 'easeInOut',
                  times: [0, 0.18, 0.36, 0.54, 0.72, 1],
                }
              : { duration: rushing ? 0.3 : 0.95, repeat: Infinity, ease: 'easeInOut' }
        }
      >
        <Turtle rushing={rushing && !reduce} finished={finished} reduce={Boolean(reduce)} />
      </motion.div>
    </motion.div>
  );
}

/**
 * 屁股后面的喷气尾焰 —— 从龟壳尾端向左喷出小气团 + 速度线。
 * 落后得越多(active=true)喷得越急、越远。
 */
function JetPuffs({ active }: { active: boolean }) {
  // 原地时尽可能安静,只在真正追赶时喷得急
  const duration = active ? 0.52 : 1.4;
  const puffs = [0, 1, 2];

  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        right: '100%',
        bottom: 5,
        width: 0,
        height: 0,
        pointerEvents: 'none',
      }}
    >
      {/* 气团:向左飞出、散开、淡出 */}
      {puffs.map((i) => (
        <motion.span
          key={i}
          animate={{
            x: [0, active ? -9 : -3.5, active ? -17 : -7],
            y: [0, -1.6, -3.4],
            scale: [0.35, active ? 0.85 : 0.45, active ? 1.2 : 0.6],
            opacity: [0, active ? 0.85 : 0.32, 0],
          }}
          transition={{
            duration,
            times: [0, 0.45, 1],
            repeat: Infinity,
            ease: 'easeOut',
            delay: (i * duration) / 3,
          }}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 5,
            height: 5,
            borderRadius: '50%',
            // 一深一浅交错,像喷出的烟圈
            background: i % 2 ? 'var(--accent-line)' : 'var(--accent)',
          }}
        />
      ))}

      {/* 加速线:两条向后的速度线,只有真的在追时才出现 */}
      {active &&
        [0, 1].map((i) => (
          <motion.span
            key={`streak-${i}`}
            animate={{ x: [0, -7, -14], opacity: [0, 0.55, 0], scaleX: [0.6, 1, 0.4] }}
            transition={{
              duration: 0.36,
              times: [0, 0.4, 1],
              repeat: Infinity,
              ease: 'easeOut',
              delay: i * 0.18,
            }}
            style={{
              position: 'absolute',
              right: 4,
              bottom: i === 0 ? 1 : 6,
              width: 9,
              height: 1,
              borderRadius: 1,
              transformOrigin: 'right center',
              background: 'linear-gradient(90deg, transparent, var(--accent-line))',
            }}
          />
        ))}
    </span>
  );
}

/** 乌龟本体 —— 平时朝右爬;到终点站起来比心 */
function Turtle({
  rushing,
  finished,
  reduce,
}: {
  rushing: boolean;
  finished: boolean;
  reduce: boolean;
}) {
  // 站立姿态:整只抬起并略微旋转,像是在挥手
  return (
    <motion.div
      animate={finished && !reduce ? { y: -6 } : { y: 0 }}
      transition={{ type: 'spring', stiffness: 200, damping: 16 }}
      style={{ position: 'relative', display: 'block' }}
    >
      <svg width="22" height="13.5" viewBox="0 0 34 21" fill="none" style={{ display: 'block', overflow: 'visible' }}>
        {/* ── 腿 ── */}
        <g>
          {[
            { cx: 11, cy: 18.2, d: 0 },
            { cx: 17.5, cy: 18.7, d: 0.14 },
            { cx: 24, cy: 18.2, d: 0.28 },
          ].map((leg) => (
            <motion.ellipse
              key={leg.cx}
              cx={leg.cx}
              rx="2.4"
              ry="1.7"
              fill="var(--accent)"
              animate={
                finished
                  ? { cy: [leg.cy - 1.6, leg.cy + 0.2, leg.cy - 1.6], rx: 2.2 } // 踢腿
                  : { cy: rushing ? [leg.cy, leg.cy - 1.1, leg.cy] : [leg.cy, leg.cy - 0.28, leg.cy] }
              }
              transition={
                finished
                  ? {
                      duration: 0.42,
                      repeat: Infinity,
                      ease: 'easeInOut',
                      delay: leg.d * 1.6,
                    }
                  : {
                      duration: rushing ? 0.3 : 0.95,
                      repeat: Infinity,
                      ease: 'easeInOut',
                      delay: leg.d,
                    }
              }
              cy={leg.cy}
            />
          ))}
        </g>

        {/* ── 尾巴(到终点时收起来) ── */}
        <motion.path
          d="M3.6 11.2 L0.7 12.6 L3.6 13.8 Z"
          fill="var(--accent)"
          animate={{ opacity: finished ? 0 : 0.85 }}
          transition={{ duration: 0.25 }}
        />

        {/* ── 龟壳 ── */}
        <ellipse cx="15" cy="10.4" rx="11.2" ry="7.6" fill="var(--accent)" />
        <ellipse cx="15" cy="10.4" rx="11.2" ry="7.6" stroke="var(--bg)" strokeWidth="1" opacity="0.5" />
        <path
          d="M10.4 5.4 L11.8 10.2 L10.2 15.4 M15.8 4.4 L16.2 10.2 L15.4 16 M21 5.6 L19.8 10.3 L20.8 15.2"
          stroke="var(--bg)"
          strokeWidth="0.95"
          strokeLinecap="round"
          opacity="0.45"
        />

        {/* ── 头 ── */}
        <circle cx="28.2" cy="8.4" r="4.1" fill="var(--accent)" />

        {/* 眼睛:平时一个小点;到终点变成开心的弯眼 */}
        {finished ? (
          <motion.path
            d="M29.6 7.2 q1.1 -1.5 2.2 0"
            stroke="var(--bg)"
            strokeWidth="0.95"
            strokeLinecap="round"
            fill="none"
            initial={reduce ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.35, delay: 0.15 }}
          />
        ) : (
          <motion.circle
            cy="7.3"
            r="0.85"
            fill="var(--bg)"
            cx={30.1}
            animate={reduce ? undefined : { cx: [30.1, 29.4, 30.5, 30.1], cy: [7.3, 7.0, 7.5, 7.3] }}
            transition={{ duration: 1.15, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}

        {/* 嘴:平时用力抿着;到终点咧嘴笑 */}
        <motion.path
          d={finished ? 'M30.4 10.3 q1.5 1.5 3 0' : 'M30.8 10.6 q1.1 0.6 2.1 -0.1'}
          stroke="var(--bg)"
          strokeWidth="0.8"
          strokeLinecap="round"
          fill="none"
          animate={{ d: finished ? 'M30.4 10.3 q1.5 1.5 3 0' : 'M30.8 10.6 q1.1 0.6 2.1 -0.1' }}
          transition={{ duration: 0.3 }}
        />
      </svg>

      {/* ── 到终点:魔性跳舞,冒出音符和星星 ── */}
      {finished && (
        <motion.div
          initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.3, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={
            reduce
              ? { duration: 0 }
              : { type: 'spring', stiffness: 260, damping: 15, delay: 0.25 }
          }
          style={{
            position: 'absolute',
            left: '50%',
            top: '-13px',
            translateX: '-50%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            pointerEvents: 'none',
          }}
        >
          {/* 音符「♪」在头顶左右飘 */}
          <motion.span
            animate={
              reduce
                ? undefined
                : { y: [0, -6, 0], x: [-3, 4, -3], rotate: [-10, 12, -10], opacity: [0.9, 1, 0.9] }
            }
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              fontSize: '11px',
              lineHeight: 1,
              color: 'var(--purple)',
              fontFamily: 'var(--mono)',
              fontWeight: 700,
              textShadow: '0 1px 2px rgba(109,59,191,0.25)',
            }}
          >
            ♪
          </motion.span>
          {/* 第二颗音符,相位错开 */}
          <motion.span
            animate={
              reduce
                ? undefined
                : { y: [0, -4, 0], x: [3, -4, 3], rotate: [12, -12, 12], opacity: [0.75, 1, 0.75] }
            }
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: 0.5 }}
            style={{
              fontSize: '9px',
              lineHeight: 1,
              color: 'var(--amber)',
              fontFamily: 'var(--mono)',
              fontWeight: 700,
              position: 'absolute',
              left: '100%',
              top: '-2px',
              whiteSpace: 'nowrap',
            }}
          >
            ♫
          </motion.span>
        </motion.div>
      )}
    </motion.div>
  );
}
