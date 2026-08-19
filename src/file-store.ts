import { createHash } from "node:crypto";

/**
 * 会话级文件快照缓存（根治"压缩丢内容 → 模型重读"的关键设施）。
 *
 * 核心思想：文件字节是权威数据（磁盘可再取），不该常驻消息历史。本 store
 * 在会话内存里按路径缓存最近读过的文件内容 + 版本标签，供：
 *   - read_file 非首次读取时返回指针（而非全文）——结构性防膨胀
 *   - file_content 按需取回 / status_only 探针
 *   - 压缩时 buildFileIndex 生成确定性"已读文件索引"
 *
 * 版本判定只用 stat（mtimeMs + size），绝不比较内容——stat.size 是字节、
 * content.length 是字符，多字节文件（中文）直接比较会永久假变。
 * hash 只作指针里的"版本标签"，不进判定路径。
 */

export const FILE_CACHE_MAX_BYTES = 1024 * 1024; // 只缓存 ≤1MB（对齐 grep_search 跳过阈值）
export const FILE_CACHE_MAX_ENTRIES = 30; // 条数上限，防止长会话无限增长

export interface FileSnapshot {
  mtimeMs: number;
  /** 磁盘字节数（stat.size），不是字符数 */
  size: number;
  /** 内容指纹：对原始 UTF-8 buffer 计算，sha1 前 12 位 */
  hash: string;
  content: string;
  /** true = store 里的内容可能已过期（检测到磁盘 stat 变化，或写入失败） */
  dirty: boolean;
}

/** 对 UTF-8 buffer 计算内容指纹（sha1 截断，版本标签用，不参与新鲜度判定） */
export function contentHash(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex").slice(0, 12);
}

/** 生成 read_file 结果末尾的指针行（也供非首次读取时单独返回） */
export function filePointer(path: string, snap: FileSnapshot): string {
  const lines = snap.content.split("\n").length;
  return `\n\n📄 ${path} (${lines} 行, ${snap.size} 字节, hash ${snap.hash})`;
}

export class FileStore {
  private map = new Map<string, FileSnapshot>();

  get(path: string): FileSnapshot | undefined {
    return this.map.get(path);
  }

  /** 首次读取落快照：path 必须已 resolve() 规范化 */
  set(path: string, snap: FileSnapshot): void {
    this.map.set(path, snap);
    this.evict();
  }

  /** 编辑工具已知新内容 → 直接更新快照（标 fresh，内容即当前磁盘态） */
  updateContent(path: string, content: string, mtimeMs: number, size: number, hash: string): void {
    this.map.set(path, { mtimeMs, size, hash, content, dirty: false });
    this.evict();
  }

  /** 检测到磁盘 stat 变化：store 内容过期，标记 dirty 供索引展示 */
  markDirty(path: string): void {
    const snap = this.map.get(path);
    if (snap) this.map.set(path, { ...snap, dirty: true });
  }

  /** 重建快照后复位 dirty */
  markFresh(path: string): void {
    const snap = this.map.get(path);
    if (snap) this.map.set(path, { ...snap, dirty: false });
  }

  /** 供 buildFileIndex / 测试遍历（快照顺序稳定） */
  entries(): [string, FileSnapshot][] {
    return [...this.map.entries()];
  }

  private evict(): void {
    if (this.map.size <= FILE_CACHE_MAX_ENTRIES) return;
    // 简单 cap：超过上限丢最早插入的（Map 迭代序 = 插入序）
    const oldest = this.map.keys().next().value as string | undefined;
    if (oldest !== undefined) this.map.delete(oldest);
  }
}

/** 缓存门控：超过 1MB 不缓存（仍返回内容，只是不进 store） */
export function cacheable(size: number): boolean {
  return size <= FILE_CACHE_MAX_BYTES;
}
