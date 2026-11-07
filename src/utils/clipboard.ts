import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 剪贴板图片读取工具
 *
 * 跨平台（macOS / Linux / Windows）检测并读取剪贴板中的图片数据，
 * 返回 base64 编码 + media_type 供大模型消息嵌入。
 *
 * 三个平台各走各的系统命令（osascript / xclip·wl-paste / powershell），
 * 没有平台分支命中时返回 null。
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
 * 写入剪贴板文本（跨平台）。
 *
 * 用 pbcopy (macOS) / xclip / wl-copy (Linux)。Windows 走 clip。
 * 失败抛错——调用方（/copy）要能告诉用户"没复制成功"。
 */
export function writeClipboardText(text: string): void {
  const run = (cmd: string, args: string[]): void => {
    execFileSync(cmd, args, { input: text, timeout: 3000 });
  };
  if (process.platform === 'darwin') {
    run('pbcopy', []);
    return;
  }
  if (process.platform === 'win32') {
    run('clip', []);
    return;
  }
  // Linux：X11 优先，降级 Wayland
  try {
    run('xclip', ['-selection', 'clipboard']);
  } catch {
    run('wl-copy', []);
  }
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
    if (process.platform === 'win32') {
      return readClipboardWindows();
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

/**
 * Windows 剪贴板图片读取（PowerShell + System.Windows.Forms）
 *
 * 流程：
 *   1. `Clipboard::ContainsImage()` 检测剪贴板里是不是图
 *   2. 是 → `Clipboard::GetImage()` 存成临时 PNG
 *   3. node 读文件 base64 → 删临时文件
 *
 * ## 为什么必须 -STA
 *
 * `System.Windows.Forms.Clipboard` 是 STA COM 组件。pwsh 7+ 默认以 **MTA** 启动，
 * 在 MTA 线程上碰它会抛 `ThreadStateException: Current thread must be set to
 * single thread apartment (STA)`。Windows PowerShell 5.1（powershell.exe）默认
 * 是 STA，但为稳妥起见两者都显式加 `-STA`——pwsh 也认这个参数。
 *
 * ## 为什么用 -EncodedCommand 而不是 -Command
 *
 * 脚本里有 `"`、`$`、`|` 和换行。走 `-Command` 要跟 cmd.exe 的引号规则搏斗
 * （execFileSync 直接调 exe 时虽不经 shell，但 PowerShell 自己还要解析一遍
 * 参数串，多级转义极易出错）。`-EncodedCommand` 收 base64(UTF-16LE)，
 * 完全绕开引号：脚本原样送达，与 shell 无关。
 *
 * ## 为什么要先探测再读
 *
 * `GetImage()` 在剪贴板无图时返回 null，但**调用它本身就会因剪贴板被别的
 * 程序占用而抛 ExternalException**。先 `ContainsImage()` 短路掉"本来就没图"
 * 的常见情况（用户只是 Ctrl+V 粘文本），少一次无谓的 COM 调用。
 */
function readClipboardWindows(): ClipboardImage | null {
  const tmpDir = mkdtempSync(join(tmpdir(), 'bcode-clip-'));
  const tmpFile = join(tmpDir, 'clipboard.png');
  // 路径要嵌进 PowerShell 单引号串：反斜杠本身不必转义，但我们要防的是
  // 路径里出现单引号（PowerShell 里用 '' 表示一个 '）
  const psPath = tmpFile.replace(/'/g, "''");

  // 注意：这里**不**用 osascript 那种 `execSync(字符串)`——那条路径要经 shell，
  // 而 Windows 上 node 用的是 cmd.exe，引号规则完全不同。execFileSync 直接调
  // exe，参数以数组传递，不经过任何 shell。
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $img) { exit 3 }',
    `$img.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$img.Dispose()',
  ].join('; ');

  // -EncodedCommand 要求 UTF-16LE 的 base64
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
      timeout: 10000,
      // 不让子进程的 stderr 漏进 TUI（备用屏里会直接花屏）
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!existsSync(tmpFile)) return null;
    const buf = readFileSync(tmpFile);
    if (buf.length > 0) {
      return { data: buf.toString('base64'), media_type: 'image/png' };
    }
    return null;
  } catch {
    // exit 3（无图片）、powershell 不可用、COM 被占用 → 一律当作"没图"
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* 忽略 */ }
    try { rmdirSync(tmpDir); } catch { /* 目录非空或不存在，忽略 */ }
  }
}
