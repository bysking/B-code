import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 剪贴板图片读取工具
 *
 * 跨平台（macOS / Linux）检测并读取剪贴板中的图片数据，
 * 返回 base64 编码 + media_type 供大模型消息嵌入。
 *
 * Windows 暂不支持（返回 null），可后续扩展。
 */

/**
 * 读取剪贴板文本（跨平台）
 * 返回纯文本内容，剪贴板为空或非文本时返回 null。
 * 同步执行（内部使用 execSync）。
 */
export function readClipboardText(): string | null {
  try {
    if (process.platform === 'darwin') {
      const text = execSync('pbpaste', { encoding: 'utf-8', timeout: 3000 }).trim();
      return text || null;
    }
    if (process.platform === 'linux') {
      try {
        const text = execSync('xclip -selection clipboard -o', { encoding: 'utf-8', timeout: 3000 }).trim();
        return text || null;
      } catch {
        const text = execSync('wl-paste 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
        return text || null;
      }
    }
  } catch {
    // 静默降级
  }
  return null;
}

export interface ClipboardImage {
  /** base64 编码的图片二进制数据 */
  data: string;
  /** MIME 类型 */
  media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

/**
 * 读取剪贴板图片。
 * 如果剪贴板中没有图片，或平台不支持，返回 null。
 * 每次调用开销约 30-80ms（osascript/xclip 进程启动延迟）。
 * 同步执行（内部使用 execSync）。
 */
export function readClipboardImage(): ClipboardImage | null {
  try {
    if (process.platform === 'darwin') {
      return readClipboardMacOS();
    }
    if (process.platform === 'linux') {
      return readClipboardLinux();
    }
  } catch {
    // 静默降级：剪贴板读取失败不阻塞用户输入
  }
  return null;
}

/**
 * macOS 剪贴板图片读取（osascript）
 *
 * 流程：
 *   1. clipboard info 检测是否包含图片（PNGf / TIFF / JPEG 等）
 *   2. 有图片 → osascript 写入临时文件 → node 读取并 base64 编码 → 删除临时文件
 *
 * 为什么不用 pbpaste -Prefer PNG：
 *   pbpaste 的 -Prefer PNG 在剪贴板含图片时可能返回 PDF 数据（macOS 10.14+），
 *   osascript 的 get the clipboard as 直接获取原始图片数据更可靠。
 */
function readClipboardMacOS(): ClipboardImage | null {
  // 检测剪贴板是否包含图片
  const info = execSync('osascript -e "clipboard info"', {
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();

  // 检测图片格式（PNGf / TIFF / JPEG / GIF 等）
  const hasImage = /PNGf|TIFF|JPEG|GIFf/i.test(info);
  if (!hasImage) return null;

  // 写入临时文件
  const tmpDir = mkdtempSync(join(tmpdir(), 'bcode-clip-'));
  const tmpFile = join(tmpDir, 'clipboard.png');
  try {
    execSync(
      `osascript -e 'set theImage to (the clipboard as «class PNGf»)' -e 'set outPath to "${tmpFile}"' -e 'set fileRef to open for access outPath with write permission' -e 'write theImage to fileRef' -e 'close access fileRef' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10000 },
    );

    // 读取临时文件并用 base64 编码
    const buf = readFileSync(tmpFile);
    if (buf.length > 0) {
      return { data: buf.toString('base64'), media_type: 'image/png' };
    }
    return null;
  } finally {
    // 清理临时文件
    try { unlinkSync(tmpFile); } catch { /* 忽略 */ }
    try { rmdirSync(tmpDir); } catch { /* 目录非空或不存在，忽略 */ }
  }
}

/**
 * Linux 剪贴板图片读取
 *
 * 优先 X11（xclip），降级 Wayland（wl-paste）。
 */
function readClipboardLinux(): ClipboardImage | null {
  // X11：xclip
  try {
    execSync('which xclip', { encoding: 'utf-8', timeout: 2000 });
    // 检测是否有图片格式
    const targets = execSync('xclip -selection clipboard -t TARGETS -o', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const formats = targets.split('\n').map((l) => l.trim());
    const pngFormat = formats.find((f) => f.toLowerCase().includes('image/png'));
    if (!pngFormat) return null;

    const data = execSync('xclip -selection clipboard -t image/png -o | base64', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (data && data.length > 50) {
      return { data, media_type: 'image/png' };
    }
    return null;
  } catch {
    // xclip 不可用或无图片，继续尝试 wl-paste
  }

  // Wayland：wl-paste
  try {
    execSync('which wl-paste', { encoding: 'utf-8', timeout: 2000 });
    const types = execSync('wl-paste --list-types 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const hasImage = /image\//i.test(types);
    if (!hasImage) return null;

    const data = execSync('wl-paste --type image/png 2>/dev/null | base64', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (data && data.length > 50) {
      return { data, media_type: 'image/png' };
    }
    return null;
  } catch {
    return null;
  }
}