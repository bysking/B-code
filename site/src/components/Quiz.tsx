import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { QUIZ } from '../content/knowledge';
import { STAGES } from '../content/journey';

/**
 * 知识自测 —— 答错时给出解释而不是只判对错。
 *
 * 两个刻意的设计:
 *   1. 每个选项都带自己的错因(optionNotes),而不是只显示「正确答案是 B」——
 *      读者真正需要知道的是「我选的那个为什么不对」。
 *   2. 每题挂到主线的一个时刻上,答错时直接给一个跳回那一节的锚点,
 *      省的读者自己去找「这考的是哪一章」。
 */
export function Quiz() {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const reduce = useReducedMotion();

  const answeredCount = Object.keys(answers).length;
  const correctCount = useMemo(() => QUIZ.filter((q) => answers[q.id] === q.answer).length, [answers]);
  const done = answeredCount === QUIZ.length;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.8rem',
          padding: '0.7rem 1rem',
          borderRadius: 'var(--radius)',
          background: 'var(--bg-raised)',
          border: '1px solid var(--border)',
          marginBottom: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', color: 'var(--text-dim)' }}>
          已答 {answeredCount}/{QUIZ.length}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', color: 'var(--green)' }}>
          正确 {correctCount}
        </span>
        <div
          style={{
            flex: 1,
            minWidth: '6rem',
            height: 4,
            background: 'var(--bg-inset)',
            borderRadius: 999,
            overflow: 'hidden',
          }}
          role="progressbar"
          aria-valuenow={answeredCount}
          aria-valuemin={0}
          aria-valuemax={QUIZ.length}
          aria-label="答题进度"
        >
          <div
            style={{
              height: '100%',
              width: `${(answeredCount / QUIZ.length) * 100}%`,
              background: 'var(--accent)',
              transition: 'width 0.3s',
            }}
          />
        </div>
        {answeredCount > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={() => setAnswers({})}>
            ⟲ 重做
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gap: '0.85rem' }}>
        {QUIZ.map((q, qi) => {
          const picked = answers[q.id];
          const isAnswered = picked !== undefined;
          const isCorrect = picked === q.answer;
          const stage = STAGES.find((s) => s.id === q.stage);

          return (
            <div
              key={q.id}
              className="card"
              style={{
                borderColor: isAnswered
                  ? isCorrect
                    ? 'var(--green-line)'
                    : 'var(--red-line)'
                  : 'var(--border)',
              }}
            >
              <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '0.6rem', alignItems: 'baseline' }}>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: '0.72rem',
                    color: 'var(--text-faint)',
                    flexShrink: 0,
                  }}
                >
                  Q{qi + 1}
                </span>
                <span style={{ fontWeight: 600, fontSize: '0.95rem', flex: 1 }}>{q.question}</span>
              </div>

              {/* 考点标签:答之前也显示 —— 读者可以据此判断自己该不该会这道题 */}
              {stage && (
                <a
                  href={`#stage-${stage.id}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    marginBottom: '0.6rem',
                    fontFamily: 'var(--mono)',
                    fontSize: '0.68rem',
                    color: isAnswered ? (isCorrect ? 'var(--green)' : 'var(--amber)') : 'var(--text-faint)',
                    textDecoration: 'none',
                    border: `1px solid ${
                      isAnswered ? (isCorrect ? 'var(--green-line)' : 'var(--amber-line)') : 'var(--border)'
                    }`,
                    borderRadius: 999,
                    padding: '0.05em 0.55em',
                  }}
                >
                  第 {stage.n} 站 · {stage.short}
                  <span style={{ opacity: 0.7 }}>{q.src}</span>
                  {isAnswered && !isCorrect && <span>· 回去看 →</span>}
                </a>
              )}

              <div style={{ display: 'grid', gap: '0.35rem' }}>
                {q.options.map((opt, oi) => {
                  const selected = picked === oi;
                  const showAsCorrect = isAnswered && oi === q.answer;
                  const showAsWrong = isAnswered && selected && oi !== q.answer;
                  // 选错时,把这个选项自己的错因一起显示出来
                  const note = showAsWrong ? q.optionNotes[oi] : null;

                  return (
                    <button
                      key={oi}
                      onClick={() => setAnswers((a) => ({ ...a, [q.id]: oi }))}
                      aria-pressed={selected}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '0.6rem',
                        textAlign: 'left',
                        padding: '0.5rem 0.7rem',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontFamily: 'var(--sans)',
                        fontSize: '0.85rem',
                        lineHeight: 1.6,
                        color: showAsCorrect
                          ? 'var(--green)'
                          : showAsWrong
                            ? 'var(--red)'
                            : 'var(--text-dim)',
                        background: showAsCorrect
                          ? 'var(--green-bg)'
                          : showAsWrong
                            ? 'var(--red-bg)'
                            : 'var(--bg-inset)',
                        border: `1px solid ${
                          showAsCorrect
                            ? 'var(--green-line)'
                            : showAsWrong
                              ? 'var(--red-line)'
                              : 'var(--border)'
                        }`,
                        transition: reduce ? 'none' : 'all 0.15s',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: '0.72rem',
                          flexShrink: 0,
                          paddingTop: 2,
                          color: showAsCorrect
                            ? 'var(--green)'
                            : showAsWrong
                              ? 'var(--red)'
                              : 'var(--text-faint)',
                        }}
                      >
                        {showAsCorrect ? '✓' : showAsWrong ? '✗' : String.fromCharCode(65 + oi)}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        {opt}
                        {note && (
                          <motion.span
                            initial={reduce ? false : { opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: reduce ? 0 : 0.2 }}
                            style={{
                              display: 'block',
                              marginTop: '0.3rem',
                              paddingTop: '0.3rem',
                              borderTop: '1px solid var(--red-line)',
                              fontSize: '0.79rem',
                              color: 'var(--text-dim)',
                            }}
                          >
                            ↳ {note}
                          </motion.span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>

              {isAnswered && (
                <motion.div
                  initial={reduce ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  transition={{ duration: reduce ? 0 : 0.2 }}
                  style={{
                    overflow: 'hidden',
                    marginTop: '0.6rem',
                    paddingTop: '0.6rem',
                    borderTop: '1px solid var(--border)',
                    fontSize: '0.83rem',
                    color: 'var(--text-dim)',
                  }}
                >
                  <span
                    style={{
                      color: isCorrect ? 'var(--green)' : 'var(--amber)',
                      fontWeight: 600,
                    }}
                  >
                    {isCorrect ? '正确 —— ' : '再看一眼 —— '}
                  </span>
                  {q.explanation}
                </motion.div>
              )}
            </div>
          );
        })}
      </div>

      {done && (
        <div
          className="callout"
          style={{ marginTop: '1rem', marginBottom: 0, borderLeftColor: 'var(--green)' }}
        >
          <p style={{ margin: 0, fontSize: '0.88rem' }}>
            答完 {QUIZ.length} 题,对了 {correctCount} 题。
            {correctCount === QUIZ.length
              ? '核心机制应该都抓住了 —— 接下来建议直接去读 src/agent.ts 里的那个 while 循环。'
              : '每道题上都有一个「第 N 站」的链接,点回去就是它考的那一节 —— 错的那几题,正是最容易「觉得懂了其实没懂」的地方。'}
          </p>
        </div>
      )}
    </div>
  );
}
