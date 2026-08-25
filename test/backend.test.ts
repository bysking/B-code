import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import {
  toOpenAITools,
  toOpenAIMessages,
  fromOpenAIResponse,
  defaultModel,
  callModel,
  estimateTokens,
  usageFromOpenAI,
  withToolCacheBreakpoint,
  withMessageCacheBreakpoint,
} from '../src/backend.js';

// 集成冒烟：本地起一个 OpenAI 兼容 mock 服务，env 指向它后 callModel 的真实 HTTP 链路。
// 同时验证代理层（undici EnvHttpProxyAgent）注入后不破坏直连请求。

let server: Server;
let baseUrl: string;

const savedApiKey = process.env.OPENAI_API_KEY;
const savedBaseUrl = process.env.OPENAI_BASE_URL;
const savedModel = process.env.B_CODE_MODEL;
const savedProxy = process.env.HTTP_PROXY;
const savedNoProxy = process.env.NO_PROXY;

before(async () => {
  server = createServer((req, res) => {
    if (req.url?.includes('/chat/completions')) {
      // OpenAI 兼容 SSE 流式响应：文本分两块到达，最后 [DONE]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"mock"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" says hi"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}/v1`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  for (const [k, v] of [
    ['OPENAI_API_KEY', savedApiKey],
    ['OPENAI_BASE_URL', savedBaseUrl],
    ['B_CODE_MODEL', savedModel],
    ['HTTP_PROXY', savedProxy],
    ['NO_PROXY', savedNoProxy],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('callModel 真实 HTTP 链路：SSE 流式 → 文本增量回调 + 归一化完整消息', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.B_CODE_MODEL = 'mock-model';
  process.env.NO_PROXY = '127.0.0.1'; // 代理层存在时，本机直连不被代理
  delete process.env.HTTP_PROXY;

  const deltas: string[] = [];
  const out = await callModel({
    model: 'mock-model',
    system: [{ type: 'text', text: 'sys' }],
    tools: [],
    messages: [{ role: 'user', content: 'ping' }],
    onText: (d) => deltas.push(d),
  });
  assert.deepEqual(deltas, ['mock', ' says hi']);
  assert.deepEqual(out.content, [{ type: 'text', text: 'mock says hi' }]);
});

test('真·流式：第一块文本在 callModel resolve 之前到达（打字机地基）', async () => {
  // server 分两段发送、中间停顿 80ms；旧实现 resp.text() 会等全部到齐才回调，
  // 这个用例在旧实现下必然失败（无第一段提前到达的效果）
  const evtServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first-frag"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"-second"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, 80);
  });
  await new Promise<void>((r) => evtServer.listen(0, '127.0.0.1', r));
  const addr = evtServer.address();
  const evtUrl = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}/v1`;

  const saved = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = evtUrl;
  try {
    const got: string[] = [];
    let resolved = false;
    const pending = callModel({
      model: 'mock-model',
      system: [{ type: 'text', text: 'sys' }],
      tools: [],
      messages: [{ role: 'user', content: 'go' }],
      onText: (d) => got.push(d),
    }).then((out) => {
      resolved = true;
      return out;
    });

    await new Promise((r) => setTimeout(r, 30)); // 停顿时长内，第一块应已到达
    assert.equal(resolved, false, 'callModel 尚未 resolve 时第一块就已到达');
    assert.deepEqual(got, ['first-frag'], '30ms 时只有第一块被回调');

    const out = await pending;
    assert.equal(resolved, true);
    assert.deepEqual(out.content, [{ type: 'text', text: 'first-frag-second' }]);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved;
    await new Promise((r) => evtServer.close(r));
  }
});

test('callModel SSE 流式：tool_calls 分片按 index 合并为完整参数', async () => {
  // 独立 server：一次请求返回工具调用流（name 整块 + arguments 分片）
  const toolServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
    );
    res.write(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file_path\\":\\"x\\""}}]}}]}\n\n',
    );
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((r) => toolServer.listen(0, '127.0.0.1', r));
  const addr = toolServer.address();
  const toolUrl = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}/v1`;

  const saved = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = toolUrl;
  try {
    const out = await callModel({
      model: 'mock-model',
      system: [{ type: 'text', text: 'sys' }],
      tools: [],
      messages: [{ role: 'user', content: 'go' }],
    });
    assert.deepEqual(out.content, [
      {
        type: 'tool_use',
        id: 'call-a',
        name: 'read_file',
        input: { file_path: 'x' },
      },
    ]);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved;
    await new Promise((r) => toolServer.close(r));
  }
});

const sampleTool = {
  name: 'read_file',
  description: 'Read a file',
  input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
} as const;

test('toOpenAITools：Anthropic 工具 → OpenAI function 格式', () => {
  const [tool] = toOpenAITools([sampleTool]);
  assert.equal(tool.type, 'function');
  assert.equal(tool.function.name, 'read_file');
  assert.equal(tool.function.description, 'Read a file');
  assert.deepEqual(tool.function.parameters, sampleTool.input_schema);
});

test('toOpenAIMessages：纯文本 user 消息直传', () => {
  const out = toOpenAIMessages([{ role: 'user', content: 'hello' }]);
  assert.deepEqual(out, [{ role: 'user', content: 'hello' }]);
});

test('toOpenAIMessages：assistant 的 text + tool_use 合并为一条', () => {
  const input = [
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'finding...' },
        {
          type: 'tool_use' as const,
          id: 't1',
          name: 'read_file',
          input: { file_path: 'x.ts' },
        },
      ],
    },
  ];
  const [msg] = toOpenAIMessages(input);
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content, 'finding...');
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].id, 't1');
  assert.equal(msg.tool_calls[0].function.name, 'read_file');
  assert.equal(msg.tool_calls[0].function.arguments, '{"file_path":"x.ts"}');
});

test('toOpenAIMessages：无 tool_use 的 assistant 不带 tool_calls 字段', () => {
  const input = [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'hi' }] }];
  const [msg] = toOpenAIMessages(input);
  assert.equal(msg.tool_calls, undefined);
});

test('toOpenAIMessages：tool_result 块 → role=tool 且带 tool_call_id', () => {
  const input = [
    {
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'file contents' }],
    },
  ];
  const [msg] = toOpenAIMessages(input);
  assert.equal(msg.role, 'tool');
  assert.equal(msg.tool_call_id, 't1');
  assert.equal(msg.content, 'file contents');
});

test('toOpenAIMessages：image 块（base64）→ image_url 格式', () => {
  const input = [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: '描述这张图片' },
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' },
        },
      ],
    },
  ];
  const [msg] = toOpenAIMessages(input);
  assert.equal(msg.role, 'user');
  assert.ok(Array.isArray(msg.content));
  assert.equal(msg.content[0].type, 'text');
  assert.equal(msg.content[0].text, '描述这张图片');
  assert.equal(msg.content[1].type, 'image_url');
  assert.ok(msg.content[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.ok(msg.content[1].image_url.url.includes('iVBORw0KGgo'));
});

test('toOpenAIMessages：image 块（URL）→ image_url 格式', () => {
  const input = [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: '看这个' },
        {
          type: 'image' as const,
          source: { type: 'url' as const, url: 'https://example.com/image.png' },
        },
      ],
    },
  ];
  const [msg] = toOpenAIMessages(input);
  assert.equal(msg.role, 'user');
  assert.equal(msg.content[1].type, 'image_url');
  assert.equal(msg.content[1].image_url.url, 'https://example.com/image.png');
});

test('fromOpenAIResponse：纯文本回复 → text 块', () => {
  const out = fromOpenAIResponse({ choices: [{ message: { content: 'done', tool_calls: [] } }] });
  assert.deepEqual(out.content, [{ type: 'text', text: 'done' }]);
});

test('fromOpenAIResponse：content=null + tool_calls → tool_use 块，参数 JSON 已解析', () => {
  const out = fromOpenAIResponse({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'grep_search', arguments: '{"pattern":"TODO"}' },
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(out.content, [
    { type: 'tool_use', id: 'call-1', name: 'grep_search', input: { pattern: 'TODO' } },
  ]);
});

test('fromOpenAIResponse：损坏的 arguments JSON → 空对象而非崩溃', () => {
  const out = fromOpenAIResponse({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{bad' } }],
        },
      },
    ],
  });
  const block = out.content[0];
  assert.equal(block?.type, 'tool_use');
  assert.deepEqual((block as { input: unknown }).input, {});
});

test('defaultModel：显式 B_CODE_MODEL 优先', () => {
  process.env.B_CODE_MODEL = 'my-model';
  assert.equal(defaultModel(), 'my-model');
  delete process.env.B_CODE_MODEL;
});

// ── token 估算与 usage 归一化（状态行实时展示用）───────────────
test('estimateTokens：CJK 计 1、ASCII 约 len/4、空串为 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('汉字测试'), 4);
  assert.equal(estimateTokens('hello world'), Math.ceil(11 / 4));
  assert.ok(estimateTokens('mixed 中文 here') > 0);
});

// ── 前缀缓存断点（0.1× 计费的关键，纯函数）────────────────────
test('withToolCacheBreakpoint：最后一个工具打 cache_control 断点', () => {
  const out = withToolCacheBreakpoint([sampleTool as never, { ...sampleTool, name: 'grep_search' } as never]);
  assert.equal(out.length, 2);
  assert.equal((out[0] as { cache_control?: unknown }).cache_control, undefined, '前序工具不打');
  assert.deepEqual((out[1] as { cache_control: unknown }).cache_control, { type: 'ephemeral' });
});

test('withToolCacheBreakpoint：空数组 / 已带断点 → 原样返回', () => {
  assert.deepEqual(withToolCacheBreakpoint([]), []);
  const already = [{ ...sampleTool, cache_control: { type: 'ephemeral' } } as never];
  assert.equal(withToolCacheBreakpoint(already), already, '不重复打断点（引用不变）');
});

test('withMessageCacheBreakpoint：最后一条纯文本 user 消息转 text block 带断点', () => {
  const msgs: import('@anthropic-ai/sdk/resources/messages/messages.js').MessageParam[] = [
    { role: 'user', content: 'hi' },
    { role: 'user', content: 'latest' },
  ];
  const out = withMessageCacheBreakpoint(msgs);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.content, 'hi', '前序消息不动');
  const last = out[1]!.content as unknown as Array<Record<string, unknown>>;
  assert.equal(last.length, 1);
  assert.equal(last[0]!.type, 'text');
  assert.equal(last[0]!.text, 'latest');
  assert.deepEqual(last[0]!.cache_control, { type: 'ephemeral' });
});

test('withMessageCacheBreakpoint：tool_result 消息（块数组）不动', () => {
  const msgs: import('@anthropic-ai/sdk/resources/messages/messages.js').MessageParam[] = [
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }],
    },
  ];
  assert.equal(withMessageCacheBreakpoint(msgs), msgs, '引用不变（不触碰块数组）');
});

test('withMessageCacheBreakpoint：空消息数组原样', () => {
  assert.deepEqual(withMessageCacheBreakpoint([]), []);
});

test('fromOpenAIResponse：usage(prompt/completion) 归一化', () => {
  const out = fromOpenAIResponse({
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  });
  assert.deepEqual(out.usage, { input_tokens: 5, output_tokens: 3 });
});

test('usageFromOpenAI：字段缺失优雅降级为 undefined', () => {
  assert.deepEqual(usageFromOpenAI({ usage: { prompt_tokens: 1, completion_tokens: 2 } }), {
    input_tokens: 1,
    output_tokens: 2,
  });
  assert.equal(usageFromOpenAI({ usage: { prompt_tokens: 1 } }), undefined, '缺 output 降级');
  assert.equal(usageFromOpenAI({}), undefined, '无 usage 降级');
});

test('SSE 流式：末尾 usage chunk 归一化到 ModelOutput.usage', async () => {
  const usageServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((r) => usageServer.listen(0, '127.0.0.1', r));
  const addr = usageServer.address();
  const url = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}/v1`;

  const saved = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = url;
  try {
    const out = await callModel({
      model: 'mock-model',
      system: [{ type: 'text', text: 's' }],
      tools: [],
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.deepEqual(out.content, [{ type: 'text', text: 'hi' }]);
    assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 7 }, 'usage chunk 归一化');
  } finally {
    if (saved === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved;
    await new Promise((r) => usageServer.close(r));
  }
});
