import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_PATH_ENV } from '../src/utils/paths.js';
import { MCP_CONFIG_ENV, formatMcpList, mcpConfigPaths, resolveMcpConfigs } from '../src/mcp-config.js';
import type { McpConfig } from '../src/mcp-config.js';

let home: string;
let proj: string;
let dataHome: string;
const savedHomeEnv = process.env[BASE_PATH_ENV];
const savedMcpEnv = process.env[MCP_CONFIG_ENV];

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'b-code-mcpcfg-'));
  proj = join(home, 'proj');
  dataHome = join(home, 'data');
  await mkdir(join(proj, '.claude'), { recursive: true });
  await mkdir(dataHome, { recursive: true });
  process.env[BASE_PATH_ENV] = dataHome;
});

after(async () => {
  if (savedHomeEnv === undefined) delete process.env[BASE_PATH_ENV];
  else process.env[BASE_PATH_ENV] = savedHomeEnv;
  if (savedMcpEnv === undefined) delete process.env[MCP_CONFIG_ENV];
  else process.env[MCP_CONFIG_ENV] = savedMcpEnv;
  await rm(home, { recursive: true, force: true });
});

test('mcpConfigPaths：env 覆盖 > 项目 > B_CODE_HOME', async () => {
  const envPath = join(home, 'env-mcp.json');
  process.env[MCP_CONFIG_ENV] = envPath;
  try {
    const paths = mcpConfigPaths(proj);
    assert.equal(paths[0], envPath);
    assert.equal(paths[1], join(proj, '.claude', 'mcp.json'));
    assert.equal(paths[2], join(dataHome, 'mcp.json'));
  } finally {
    delete process.env[MCP_CONFIG_ENV];
  }
});

test('resolveMcpConfigs：项目 server 覆盖 B_CODE_HOME 同名，env 覆盖项目', async () => {
  await writeFile(
    join(dataHome, 'mcp.json'),
    JSON.stringify({ mcpServers: { fs: { command: 'node', args: ['/user-level.js'] } } }),
  );
  await writeFile(
    join(proj, '.claude', 'mcp.json'),
    JSON.stringify({
      mcpServers: { fs: { command: 'node', args: ['/project-level.js'] }, extra: { command: 'npx' } },
    }),
  );

  const merged = resolveMcpConfigs(proj);
  assert.deepEqual(merged.fs, { command: 'node', args: ['/project-level.js'] }, '项目覆盖用户级');
  assert.equal(merged.extra?.command, 'npx');

  // env 配置最高优先
  const envPath = join(home, 'env-mcp.json');
  await writeFile(envPath, JSON.stringify({ mcpServers: { fs: { command: 'deno', args: [] } } }));
  process.env[MCP_CONFIG_ENV] = envPath;
  try {
    const out = resolveMcpConfigs(proj);
    assert.equal(out.fs?.command, 'deno', 'env 配置覆盖项目');
  } finally {
    delete process.env[MCP_CONFIG_ENV];
  }
});

test('坏配置文件跳过，返回已有合并结果', async () => {
  await writeFile(join(dataHome, 'mcp.json'), '{ this is not json');
  const merged = resolveMcpConfigs(proj);
  assert.ok(merged, '不抛异常');
});

// ── /mcp 展示格式化 ──────────────────────────────────────────
test('formatMcpList：连接/未连接 + 命令与工具数', () => {
  const configs: McpConfig = {
    fs: { command: 'node', args: ['server.js'] },
    docs: { command: 'npx' },
  };
  const count = (name: string) => (name === 'fs' ? 3 : null);
  const out = formatMcpList(configs, count);
  assert.match(out, /✓ fs — node server\.js — 3 工具/);
  assert.match(out, /✗ docs — npx — 未连接/);
});

test('formatMcpList：read 模式标注；空配置给提示', () => {
  const configs: McpConfig = { docs: { command: 'npx', args: ['-y', '@x/y'], mode: 'read' } };
  assert.match(
    formatMcpList(configs, () => 5),
    /✓ docs — npx -y @x\/y — 5 工具 \(read\)/,
  );
  assert.equal(
    formatMcpList({}, () => null),
    '(no MCP servers configured)',
  );
});
