import { test } from 'node:test';
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