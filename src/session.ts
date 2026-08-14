import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { dirs } from "./utils/paths.js";
import { log } from "./utils/log.js";

/**
 * 会话持久化：把消息数组 JSON 化即"存会话"，读回即"恢复会话"。
 * Agent 的唯一状态就是这个数组——这是它能 --resume 的全部秘密。
 *
 * 落点：{basePath}/session.json（B_CODE_HOME 可一键搬迁）。
 */

/** 每轮对话后调用；写入失败仅记日志，不阻塞主流程 */
export async function saveSession(messages: unknown[]): Promise<void> {
  const file = dirs.sessionFile();
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(messages, null, 2), "utf-8");
  } catch (err) {
    log.warn(`session save failed: ${file}`, (err as Error).message);
  }
}

/** 读回会话；文件不存在或损坏时返回 null（不崩溃，静默降级） */
export async function loadSession(): Promise<MessageParam[] | null> {
  const file = dirs.sessionFile();
  try {
    const raw = JSON.parse(await readFile(file, "utf-8"));
    if (!Array.isArray(raw)) return null;
    return raw as MessageParam[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`session load failed: ${file}`, (err as Error).message);
    }
    return null;
  }
}

export async function clearSessionFile(): Promise<void> {
  try {
    await rm(dirs.sessionFile(), { force: true });
  } catch {
    // 忽略
  }
}