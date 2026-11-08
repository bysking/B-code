import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ANTHROPIC_SAMPLE, OPENAI_SAMPLE } from '../content/knowledge';

/**
 * 格式互转演示 —— 逐条展示 §3 的字段对应关系。
 *
 * 左边 Anthropic 形状,右边 OpenAI 形状。选中一条字段,两边对应项同时高亮,
 * 并显示转换方向(`toOpenAIMessages` / `fromOpenAIResponse`)。
 */

interface Pair {
  concept: string;
  aLabel: string;
  aDetail: string;
  oLabel: string;
  oDetail: string;
  pitfall?: string;
  /** 消息条数变化 */
  countDelta?: { a: number; o: number };
}

const PAIRS: Pair[] = [
  {
    concept: 'system',
    aLabel: '顶层 system 参数,支持多块',
    aDetail: '{ "system": [{ "type": "text", "text": "..." }] }',
    oLabel: 'messages 里的 role: "system"',
    oDetail: '{ "role": "system", "content": "..." }',
  },
  {
    concept: '工具清单',
    aLabel: '{ name, description, input_schema }',
    aDetail: 'input_schema 直接是 JSON Schema',
    oLabel: '{ type: "function", function: { … parameters } }',
    oDetail: '多包一层 "function",schema 改名 "parameters"',
  },
  {
    concept: '工具调用',
    aLabel: 'assistant content 里的 tool_use 块',
    aDetail: '工具调用与文本同在一个 content 数组里,顺序有意义',
    oLabel: 'assistant 消息上的 tool_calls 数组',
    oDetail: '文本走 content,调用走并行数组',
  },
  {
    concept: '调用参数',
    aLabel: 'input:已解析的对象',
    aDetail: '{ "path": "a.txt" }',
    oLabel: 'arguments:JSON 字符串',
    oDetail: '"{\\"path\\":\\"a.txt\\"}" —— 流式下还是分片拼的',
    pitfall:
      '转过去要 JSON.stringify(input),转回来要 JSON.parse(arguments);解析失败必须兜底成空对象。',
  },
  {
    concept: '工具结果',
    aLabel: 'user content 里的 tool_result 块',
    aDetail: '用 tool_use_id 关联',
    oLabel: '独立的 role: "tool" 消息',
    oDetail: '用 tool_call_id 关联',
  },
  {
    concept: '一条 user 消息',
    aLabel: '可同时含 text + image + tool_result',
    aDetail: '1 条消息装下 3 个结果',
    oLabel: '必须拆开:内容走 user,结果走 tool',
    oDetail: '裂成 3 条 role: "tool" 消息',
    countDelta: { a: 1, o: 3 },
    pitfall: '「消息数量」在两套格式里对不上 —— 做压缩或 token 计数时不能按条数换乘。',
  },
  {
    concept: '结束原因',
    aLabel: 'stop_reason',
    aDetail: 'end_turn / tool_use / max_tokens',
    oLabel: 'finish_reason',
    oDetail: 'stop / tool_calls / length',
  },
];

export function FormatConverter() {
  const [sel, setSel] = useState(0);
  const reduce = useReducedMotion();
  const pair = PAIRS[sel]!;

  const counts = useMemo(() => {
    // 用示例 JSON 粗略统计消息条数,直观展示「条数会变」
    const aMsgs = (ANTHROPIC_SAMPLE.match(/"role":/g) ?? []).length;
    const oMsgs = (OPENAI_SAMPLE.match(/"role":/g) ?? []).length;
    return { a: aMsgs, o: oMsgs };
  }, []);

  return (
    <div>
      {/* 字段选择 */}
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
        {PAIRS.map((p, i) => (
          <button
            key={p.concept}
            className={`btn btn-sm ${sel === i ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSel(i)}
            aria-pressed={sel === i}
            style={p.pitfall && sel !== i ? { borderColor: 'var(--amber-line)' } : undefined}
          >
            {p.concept}
            {p.pitfall ? ' •' : ''}
          </button>
        ))}
      </div>

      <div className="grid-2">
        {[
          { side: 'Anthropic', label: pair.aLabel, detail: pair.aDetail, color: 'var(--accent)' },
          { side: 'OpenAI 兼容', label: pair.oLabel, detail: pair.oDetail, color: 'var(--purple)' },
        ].map((card) => (
          <div
            key={card.side}
            className="card"
            style={{ borderColor: sel >= 0 ? undefined : 'var(--border)' }}
          >
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '0.7rem',
                color: card.color,
                letterSpacing: '0.05em',
                marginBottom: '0.5rem',
              }}
            >
              {card.side}
            </div>
            <motion.div
              key={`${sel}-${card.side}`}
              initial={reduce ? false : { opacity: 0.4 }}
              animate={{ opacity: 1 }}
              transition={{ duration: reduce ? 0 : 0.25 }}
            >
              <div style={{ fontWeight: 600, fontSize: '0.92rem', marginBottom: '0.4rem' }}>
                {card.label}
              </div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: '0.76rem',
                  color: 'var(--text-faint)',
                  wordBreak: 'break-all',
                }}
              >
                {card.detail}
              </div>
            </motion.div>
          </div>
        ))}
      </div>

      {pair.pitfall && (
        <div className="callout callout-warn" style={{ marginTop: '0.9rem' }}>
          <span className="callout-title">易踩的坑</span>
          <p style={{ margin: 0 }}>{pair.pitfall}</p>
        </div>
      )}

      {pair.countDelta && (
        <div className="card-inset" style={{ marginTop: '0.9rem' }}>
          <div
            style={{
              fontSize: '0.72rem',
              fontFamily: 'var(--mono)',
              color: 'var(--text-faint)',
              marginBottom: '0.45rem',
            }}
          >
            条数变化
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', fontSize: '0.85rem' }}>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
              1 条 user
            </span>
            <span style={{ color: 'var(--text-faint)' }}>→</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--purple)' }}>
              1 条 user + 1 条 tool
            </span>
            <span style={{ color: 'var(--text-faint)', fontSize: '0.78rem', marginLeft: 'auto' }}>
              示例整体:{counts.a} 条 → {counts.o} 条
            </span>
          </div>
        </div>
      )}

      {/* 并排原始 JSON */}
      <div className="grid-2" style={{ marginTop: '1rem' }}>
        <div>
          <div className="src-note" style={{ marginBottom: '0.35rem' }}>
            Anthropic 形状(内部统一)
          </div>
          <pre className="code-block" style={{ maxHeight: '17rem', overflowY: 'auto' }}>
            {ANTHROPIC_SAMPLE}
          </pre>
        </div>
        <div>
          <div className="src-note" style={{ marginBottom: '0.35rem' }}>
            OpenAI 兼容(边界处转换)
          </div>
          <pre className="code-block" style={{ maxHeight: '17rem', overflowY: 'auto' }}>
            {OPENAI_SAMPLE}
          </pre>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.4rem', flexWrap: 'wrap' }}>
        <span className="tag tag-read" style={{ fontFamily: 'var(--mono)' }}>
          toOpenAIMessages()
        </span>
        <span style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>↔</span>
        <span className="tag tag-external" style={{ fontFamily: 'var(--mono)' }}>
          fromOpenAIResponse()
        </span>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>
          全部格式差异被压缩到这两个纯函数里,可单独测试
        </span>
      </div>
    </div>
  );
}
