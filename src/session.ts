import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { basePath } from './utils/paths.js';
import { log } from './utils/log.js';

/**
 * 会话持久化（多会话版）：
 *   {basePath}/sessions/<id>.json   每个会话一个文件（可 --session <id> 恢复）
 *   {basePath}/sessions/current.txt 最近一次会话 id（--resume 用）
 *   旧版单文件 {basePath}/session.json 首次读取时自动迁移为 current 会话。
 */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 生成人类可读的会话 id：20260814-183000-abc */
export function newSessionId(): string {
  const d = new Date();
  const rand = Math.floor(Math.random() * 36 ** 2)
    .toString(36)
    .padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

function sessionsDir(): string {
  return join(basePath(), 'sessions');
}

export function sessionFile(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

function currentFile(): string {
  return join(sessionsDir(), 'current.txt');
}

// 惰性求值：basePath() 依赖运行时 env（测试会切换 B_CODE_HOME），不能顶层固定
function legacySessionFile(): string {
  return join(basePath(), 'session.json');
}

/** 保存会话：写入 <id>.json + 记录为 current（id 缺省时仅写入给定文件） */
export async function saveSession(messages: unknown[], id: string): Promise<void> {
  try {
    await mkdir(sessionsDir(), { recursive: true });
    await writeFile(sessionFile(id), JSON.stringify(messages, null, 2), 'utf-8');
    await writeFile(currentFile(), id, 'utf-8');
  } catch (err) {
    log.warn(`session save failed: ${id}`, (err as Error).message);
  }
}

/** 读取会话：id 缺省 = 最近一次（--resume）；无 current 时尝试迁移旧单文件 */
export async function loadSession(id?: string): Promise<MessageParam[] | null> {
  if (id) return readJson(sessionFile(id));

  const cur = await readText(currentFile());
  if (cur) {
    const arr = await readJson(sessionFile(cur.trim()));
    if (arr) return arr;
  }
  // 旧版单文件 → 迁移为 current
  if (existsSync(legacySessionFile())) {
    const legacy = await readJson(legacySessionFile());
    if (legacy) {
      const adopt = newSessionId();
      await saveSession(legacy, adopt);
      return legacy;
    }
  }
  return null;
}

/** 删除会话文件（并保留 current 指向不变；若删除的是 current 则同时清 current） */
export async function clearSessionFile(id?: string): Promise<void> {
  try {
    if (id) {
      await rm(sessionFile(id), { force: true });
      return;
    }
    await rm(legacySessionFile(), { force: true });
    const cur = await readText(currentFile());
    if (cur) await rm(sessionFile(cur.trim()), { force: true });
    await rm(currentFile(), { force: true });
  } catch (err) {
    log.warn('session clear failed', (err as Error).message);
  }
}

/** 恢复会话时展示的"轮"：user 消息为轮边界，tool_result 不回显 */
export interface ResumeTurn {
  role: 'user' | 'assistant';
  text: string;
  /** assistant 的 tool_use 名称清单 */
  tools: string[];
}

/**
 * 取最近 maxRounds 轮对话（含无 user 文本的压缩摘要轮）。
 * 用于 --resume / --session 时回看来龙去脉。
 */
export function recentTurns(messages: MessageParam[], maxRounds = 5): ResumeTurn[] {
  const userStart: number[] = [];
  messages.forEach((m, i) => {
    // 只有 string 型 user 内容才是"一轮的起点"（tool_result 是块数组，不算）
    if (m.role === 'user' && typeof m.content === 'string') userStart.push(i);
  });
  const starts = userStart.slice(-maxRounds);
  if (starts.length === 0) return [];

  const begin = starts[0] ?? 0;
  const out: ResumeTurn[] = [];
  for (let i = begin; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', text: m.content, tools: [] });
      } else {
        // content 数组：提取 text + 标记 image
        const textBlocks: string[] = [];
        let hasImage = false;
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b.type === 'text' && b.text) textBlocks.push(b.text);
          else if (b.type === 'image') hasImage = true;
        }
        const text = textBlocks.join('');
        if (text || hasImage) {
          out.push({ role: 'user', text: hasImage ? `[图片] ${text}` : text, tools: [] });
        }
        // 纯 tool_result 的消息：不是对话轮，跳过
      }
    } else if (m.role === 'assistant') {
      const text: string[] = [];
      const tools: string[] = [];
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text' && b.text) text.push(b.text);
        else if (b.type === 'tool_use') tools.push(b.name);
      }
      out.push({ role: 'assistant', text: text.join(''), tools });
    }
  }
  return out;
}

/** 恢复会话的紧凑文本展示（非 TTY）；"轮" = user 消息数 */
export function renderRecentTurns(turns: ResumeTurn[]): string {
  if (turns.length === 0) return '';
  const rounds = turns.filter((t) => t.role === 'user').length;
  const lines = turns.map((t) => {
    const prefix = t.role === 'user' ? 'user' : 'bcode';
    const tools = t.tools.length ? ` [tools: ${t.tools.join(', ')}]` : '';
    const body = t.text
      .trim()
      .replace(/\s*\n+/g, ' ')
      .slice(0, 160);
    const text = body || '(no text)';
    return `${prefix}:${tools} ${text}`;
  });
  return `── 最近 ${rounds} 轮对话 ──\n${lines.join('\n')}\n`;
}

async function readJson(file: string): Promise<MessageParam[] | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf-8'));
    return Array.isArray(raw) ? (raw as MessageParam[]) : null;
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf-8');
  } catch {
    return null;
  }
}
