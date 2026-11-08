import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { QUIZ } from '../content/knowledge';

/** 知识自测 —— 每题带原文锚点,答错时给出解释而不是只判对错 */
export function Quiz() {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const reduce = useReducedMotion();

  const answeredCount = Object.keys(answers).length;
  const correctCount = useMemo(
    () => QUIZ.filter((q) => answers[q.id] === q.answer).length,
    [answers],
  );
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

          return (
            <div
              key={q.id}
              className="card"
              style={{
                borderColor: isAnswered ? (isCorrect ? 'var(--green-line)' : 'var(--red-line)') : 'var(--border)',
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
                <span className="src-note" title="原文出处">
                  {q.src}
                </span>
              </div>

              <div style={{ display: 'grid', gap: '0.35rem' }}>
                {q.options.map((opt, oi) => {
                  const selected = picked === oi;
                  const showAsCorrect = isAnswered && oi === q.answer;
                  const showAsWrong = isAnswered && selected && oi !== q.answer;

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
                          showAsCorrect ? 'var(--green-line)' : showAsWrong ? 'var(--red-line)' : 'var(--border)'
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
                      <span>{opt}</span>
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
              : '错的那几题回对应的章节再看一遍,那正是最容易「觉得懂了其实没懂」的地方。'}
          </p>
        </div>
      )}
    </div>
  );
}
