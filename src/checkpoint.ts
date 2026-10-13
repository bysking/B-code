import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Registry, RuntimeContext } from './registry.js';
import { log } from './utils/log.js';

/**
 * 文件检查点（/rewind 的基础）：在任何会改动文件的工具执行前，记录该文件的
 * "改动前内容"；/rewind 时按记录逆序还原，把工程恢复到改动前的状态。
 *
 * 覆盖 write_file / edit_file 这类直接改文件的工具。记录以会话内存为主
 * （不落盘：检查点只服务于当前会话的回退），条数与单文件大小都设上限防失控。
 */

/** 单次记录：before=null 表示文件原本不存在（回退时删除） */
interface CheckpointEntry {
  path: string;
  before: string | null;
  /** 记录序号（回退按逆序） */
  seq: number;
}

const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 超大文件不记（回退成本高且罕见）

export class CheckpointStore {
  private entries: CheckpointEntry[] = [];
  private seq = 0;

  /** 记录某文件改动前的内容（若已在本次检查点中记录过则跳过，保留最早的前像） */
  record(path: string): void {
    const abs = resolve(path);
    if (this.entries.some((e) => e.path === abs)) return; // 已有更早的前像，保留
    let before: string | null = null;
    try {
      if (existsSync(abs)) {
        const buf = readFileSync(abs);
        if (buf.byteLength <= MAX_FILE_BYTES) before = buf.toString('utf-8');
        else return; // 过大不记
      }
    } catch {
      return; // 读不了就不记（回退无从保证）
    }
    this.entries.push({ path: abs, before, seq: this.seq++ });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  /** 已记录的文件数 */
  size(): number {
    return this.entries.length;
  }

  /** 记录的文件路径清单（最近在后） */
  files(): string[] {
    return this.entries.map((e) => e.path);
  }

  /**
   * 回退：逆序还原全部记录（before=null → 删除文件），随后清空。
   * 返回还原/删除的文件路径，供调用方展示。
   */
  rewind(): { restored: string[]; deleted: string[] } {
    const restored: string[] = [];
    const deleted: string[] = [];
    for (const e of [...this.entries].reverse()) {
      try {
        if (e.before === null) {
          rmSync(e.path, { force: true });
          deleted.push(e.path);
        } else {
          mkdirSync(dirname(e.path), { recursive: true });
          writeFileSync(e.path, e.before, 'utf-8');
          restored.push(e.path);
        }
      } catch (err) {
        log.warn(`rewind failed for ${e.path}`, (err as Error).message);
      }
    }
    this.entries = [];
    return { restored, deleted };
  }

  /** 清空记录（不回退） */
  clear(): void {
    this.entries = [];
  }
}

/** 会改动文件内容的工具名（执行前记录检查点） */
const FILE_MUTATING_TOOLS = new Set(['write_file', 'edit_file']);

/**
 * 给文件类工具的 handler 包一层检查点记录：执行前先记录文件当前内容。
 * handler 不感知检查点，接线集中在这里，新增文件类工具只需加入上方集合。
 */
export function withCheckpoints(registry: Registry, store: CheckpointStore): void {
  for (const name of FILE_MUTATING_TOOLS) {
    const mp = registry.resolve(name);
    if (!mp) continue;
    const inner = mp.handler;
    mp.handler = async (input: Record<string, any>, ctx: RuntimeContext) => {
      const path = input.file_path;
      if (typeof path === 'string' && path) store.record(path);
      return inner(input, ctx);
    };
  }
}
