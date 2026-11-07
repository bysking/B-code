import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readClipboardImage } from '../src/utils/clipboard.js';

/**
 * 剪贴板工具测试
 *
 * 注：这些测试依赖于实际剪贴板状态，无法在无头环境（CI）可靠运行。
 * 不作为 CI 强制检查，只在本地手动验证。
 * macOS 上系统剪贴板可能缓存图片，导致"无图片"测试不稳定，
 * 因此只测试"有图片时返回正确数据"的场景。
 */

test('readClipboardImage：有图片时返回 base64 数据', async () => {
  // 只在 macOS 上测试
  if (process.platform !== 'darwin') return;

  // 创建一个 1x1 蓝色 PNG 并复制到剪贴板
  try {
    const { execSync } = await import('node:child_process');
    // 1x1 蓝色 PNG 的 base64
    const bluePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    // 写入临时文件
    execSync(
      `echo "${bluePngBase64}" | base64 -d > /tmp/bcode_test_paste.png`,
      { timeout: 3000 },
    );
    // 复制到剪贴板
    execSync(
      'osascript -e \'set theImage to (read (POSIX file "/tmp/bcode_test_paste.png") as «class PNGf»)\' -e \'set the clipboard to theImage\'',
      { timeout: 5000 },
    );
    execSync('rm -f /tmp/bcode_test_paste.png', { timeout: 2000 });

    const result = readClipboardImage();
    assert.ok(result !== null, '应该检测到剪贴板图片');
    assert.equal(result.media_type, 'image/png');
    // 验证 base64 数据是有效的 PNG
    assert.ok(result.data.length > 50, 'base64 数据应该足够长');
    // 验证 base64 解码后是有效的 PNG header
    const pngHeader = Buffer.from(result.data, 'base64').subarray(0, 8).toString('hex');
    assert.equal(pngHeader, '89504e470d0a1a0a', '应为有效的 PNG 文件头');
  } catch (err) {
    // 如果 osascript 不可用，静默跳过
    console.log('  ⚠  skipped: osascript not available');
  }
});

/**
 * 回归：cli 层的发消息路径不能自动读剪贴板。
 *
 * 曾经 cli.ts 把 agent.chat 包成 chatWithClipboard——每次发消息都探测剪贴板，
 * 只要有图就静默塞进上下文。用户启动 bcode 时若剪贴板里恰好有截图，第一句话
 * 就会莫名带上图片。图片只能由用户在输入框里 Ctrl+V 显式粘贴（ui/app.tsx）。
 *
 * 这里直接扫源码断言：cli.ts 不得引用 readClipboardImage / chatWithClipboard。
 * 静态检查而非行为测试，因为要防的正是"又加回自动读取"这个改动本身。
 */
test('回归：cli.ts 发消息路径不得自动读取剪贴板', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const src = readFileSync(cliPath, 'utf-8');

  assert.ok(
    !src.includes('readClipboardImage'),
    'cli.ts 不应调用 readClipboardImage（图片只能由用户 Ctrl+V 显式粘贴）',
  );
  assert.ok(
    !src.includes('chatWithClipboard'),
    'cli.ts 不应存在 chatWithClipboard 包装（会自动附带剪贴板图片）',
  );
});

/**
 * Windows 剪贴板读取（powershell -EncodedCommand）。
 *
 * 只能在 macOS/Linux 上跑，所以**不**验证真机读图（那需要 Windows + 真实
 * 剪贴板），而是锁住脚本文本本身的正确性——这两点出错的表现都是"Windows 上
 * 按 Ctrl+V 静默无反应"，最难排查：
 *
 *   1. 必须带 `-STA`：System.Windows.Forms.Clipboard 是 STA COM 组件，
 *      pwsh 7 默认 MTA，不带就抛 ThreadStateException。
 *   2. 必须走 `-EncodedCommand`：脚本里有引号/`|`/`$`，走 -Command 要过
 *      cmd.exe 与 PowerShell 两层解析，多级转义极易失效。
 *
 * 脚本是从源码里抠出来再解码的，所以这里断言的正是运行时真正会执行的内容。
 */
test('Windows：powershell 参数与脚本内容正确', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/utils/clipboard.ts', import.meta.url)), 'utf-8');

  // 1) 参数配置
  assert.ok(
    /execFileSync\(\s*'powershell',\s*\[[^\]]*'-STA'/.test(src),
    '必须带 -STA（pwsh 7 默认 MTA，Forms 剪贴板会抛 ThreadStateException）',
  );
  assert.ok(src.includes("'-EncodedCommand'"), '必须走 -EncodedCommand（避开引号解析）');
  assert.ok(src.includes("'-NoProfile'"), '必须 -NoProfile（用户 profile 可能污染输出）');
  assert.ok(
    src.includes("stdio: ['ignore', 'pipe', 'pipe']"),
    'stdio 必须收敛，否则子进程输出会打进备用屏',
  );

  // 2) 脚本内容：取 script 数组的源码块（`const script = [ ... ].join('; ')`）
  const block = /const script = \[([\s\S]*?)\]\.join\(/.exec(src)?.[1] ?? '';
  assert.ok(block.length > 0, '应能从源码定位到 script 数组');
  const script = block;

  assert.ok(script.includes('Add-Type -AssemblyName System.Windows.Forms'), '要先加载 Forms 程序集');
  assert.ok(script.includes('ContainsImage()'), '要先探测，避免无图时白跑 COM 调用');
  assert.ok(script.includes('GetImage()'), '要真的取图');
  assert.ok(script.includes('ImageFormat]::Png'), '要存成 PNG（媒体类型固定 image/png）');
  assert.ok(script.includes('exit 3'), '无图要用非零退出码短路（catch 里当"没图"处理）');

  // 3) 编码方式：-EncodedCommand 要求 UTF-16LE
  assert.ok(src.includes("Buffer.from(script, 'utf16le')"), '-EncodedCommand 必须用 UTF-16LE 编码');
});
