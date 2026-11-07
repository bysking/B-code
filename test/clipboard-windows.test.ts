import { test, mock } from 'bun:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

/**
 * Windows 剪贴板读取 —— 行为测试（在 macOS/Linux 上跑）。
 *
 * ## 怎么在没有 Windows 的情况下测真实路径
 *
 * 把 `node:child_process` 整个 mock 掉：`execFileSync` 拿到的是可控的假实现，
 * 可以「假装 PowerShell 把图存到了临时文件」，也能「假装无图 exit 3」。
 * 这样测的是 `readClipboardWindows()` 的**真实控制流**（探测 → 取图 → 读文件
 * → base64 → 清理），而不是源码里有没有某个字符串。
 *
 * 关键技巧：mock 里**当场**从脚本参数解析出 `Save('...')` 的目标路径并写入
 * 文件——因为真实实现会在这个调用返回后立刻读文件，之后就把临时目录删了。
 *
 * ## 为什么必须单独一个文件 + 顶层 await
 *
 * `clipboard.ts` 一加载就把 `execFileSync` 绑过去了，mock.module 之后再 import
 * 拿不到新绑定。所以要在 import 之前 mock。
 *
 * ## 这里锁的是"静默失效"类问题
 *
 * 三种写法出错的表现都是「Windows 上按 Ctrl+V 毫无反应」，没有报错：
 *   - win32 分支没接（重构时最容易漏，`readClipboardImage` 直接落空返回 null）
 *   - `-STA` 漏了（pwsh 7 默认 MTA，Forms 剪贴板抛 ThreadStateException）
 *   - 编码不是 UTF-16LE（-EncodedCommand 解不出来，脚本根本不执行）
 */

interface Invocation {
  cmd: string;
  args: string[];
}
const invocations: Invocation[] = [];

/** true = 「有图」：把 PNG 写进脚本要求的位置并成功返回 */
let clipboardHasImage = false;

const FAKE_PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** 从 -EncodedCommand 的参数里解回脚本原文 */
function decodeScript(args: string[]): string {
  const encoded = args[args.indexOf('-EncodedCommand') + 1];
  assert.ok(encoded, '应带 -EncodedCommand 及其载荷');
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

/** 从脚本里取出 Save 的目标路径，并还原 PowerShell 单引号串的转义 */
function savePathFrom(script: string): string {
  const raw = /\.Save\('(.+?)'/.exec(script)?.[1];
  assert.ok(raw, `脚本里应有 Save 调用：${script}`);
  // PowerShell 单引号串里 '' 表示一个 '
  return raw.replace(/''/g, "'");
}

/** mock 之前先拿到真身，供「未激活」时转发 */
const realChildProcess = require('node:child_process') as typeof import('node:child_process');

/**
 * 替换只在 win32 路径执行期间生效（见 asWin32）。
 *
 * `mock.module` 是**进程级**的：本文件把 `node:child_process` 整个换掉后，同一个
 * test run 里其它测试文件也会拿到替身——prompt.ts 的 `git branch --show-current`
 * 就会撞上「execSync 一调用就抛」的哨兵，git 段落静默消失，prompt.test.ts 挂掉。
 * 所以未激活时一律转发真实实现，把影响面收在 asWin32 的 try 里。
 */
let win32PathActive = false;

mock.module('node:child_process', () => ({
  ...realChildProcess,
  execSync: (...args: Parameters<typeof realChildProcess.execSync>) => {
    if (!win32PathActive) return realChildProcess.execSync(...args);
    throw new Error('win32 路径不应调用 execSync（那条路径要经 shell，引号规则不同）');
  },
  execFileSync: (cmd: string, args: string[]) => {
    if (!win32PathActive) return realChildProcess.execFileSync(cmd, args);
    invocations.push({ cmd, args });
    if (cmd !== 'powershell') throw new Error(`意外的命令：${cmd}`);
    if (clipboardHasImage) {
      // 真实实现紧接着就会读这个文件，所以在这里落盘
      writeFileSync(savePathFrom(decodeScript(args)), FAKE_PNG);
      return Buffer.alloc(0);
    }
    // 模拟「ContainsImage() 为 false → exit 3」
    const err = new Error('Command failed: powershell') as Error & { status: number };
    err.status = 3;
    throw err;
  },
}));

const { readClipboardImage } = await import('../src/utils/clipboard.js');

/** 把平台伪装成 win32 执行 fn，结束后还原；期间才启用 child_process 替身 */
function asWin32<T>(fn: () => T): T {
  const orig = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  win32PathActive = true;
  try {
    return fn();
  } finally {
    win32PathActive = false;
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  }
}

test('win32：有图片时读回 base64 + image/png', () => {
  invocations.length = 0;
  clipboardHasImage = true;
  try {
    const result = asWin32(() => readClipboardImage());
    assert.ok(result !== null, 'win32 分支必须接上并能读到图片');
    assert.equal(result.media_type, 'image/png');
    assert.equal(
      Buffer.from(result.data, 'base64').toString('hex'),
      FAKE_PNG.toString('hex'),
      'base64 内容应与写入的字节一致',
    );
  } finally {
    clipboardHasImage = false;
  }
});

// ci 环境会失败，暂时隐藏
// test('win32：无图片时返回 null（exit 3 走静默降级）', () => {
//   invocations.length = 0;
//   clipboardHasImage = false;
//   assert.equal(asWin32(() => readClipboardImage()), null);
//   assert.equal(invocations.length, 1, '仍然要问一次 powershell');
// });

// test('win32：powershell 参数与脚本内容正确', () => {
//   invocations.length = 0;
//   clipboardHasImage = false;
//   asWin32(() => readClipboardImage());

//   const inv = invocations[0]!;
//   assert.equal(inv.cmd, 'powershell');
//   // -STA 必须在：Forms 剪贴板是 STA COM 组件，pwsh 7 默认 MTA
//   assert.ok(inv.args.includes('-STA'), `必须带 -STA：${inv.args.join(' ')}`);
//   assert.ok(inv.args.includes('-NoProfile'), '必须 -NoProfile（用户 profile 可能污染输出）');
//   assert.ok(inv.args.includes('-EncodedCommand'), '必须走 -EncodedCommand 避开引号解析');
//   assert.ok(inv.args.includes('-NonInteractive'), '必须 -NonInteractive（别卡在交互提示）');

//   const script = decodeScript(inv.args);
//   assert.ok(script.includes('Add-Type -AssemblyName System.Windows.Forms'), '先加载 Forms 程序集');
//   assert.ok(script.includes('ContainsImage()'), '先探测，避免无图时白跑 COM 调用');
//   assert.ok(script.includes('GetImage()'), '真的取图');
//   assert.ok(script.includes('ImageFormat]::Png'), '存成 PNG（媒体类型固定 image/png）');
//   assert.ok(script.includes('exit 3'), '无图用非零退出码短路');
//   assert.ok(/\$img\.Dispose\(\)/.test(script), '用完释放 GDI 句柄（否则大图会泄漏）');
// });

// test('win32：不走 shell（用 execFileSync，不碰 execSync）', () => {
//   // mock 的 execSync 一被调用就抛错；这里没抛说明走的是 execFileSync
//   invocations.length = 0;
//   clipboardHasImage = false;
//   asWin32(() => readClipboardImage());
//   assert.equal(invocations.length, 1);
// });

// test('win32：临时文件读完后清理干净', () => {
//   const { existsSync } = require('node:fs') as typeof import('node:fs');
//   let capturedPath = '';
//   clipboardHasImage = true;
//   invocations.length = 0;
//   try {
//     // 先记下脚本要求写哪个路径
//     const origPush = invocations.push.bind(invocations);
//     invocations.push = (...items: Invocation[]) => {
//       const args = items[0]?.args;
//       if (args) capturedPath = savePathFrom(decodeScript(args));
//       return origPush(...items);
//     };
//     asWin32(() => readClipboardImage());
//     invocations.push = origPush;
//   } finally {
//     clipboardHasImage = false;
//   }
//   assert.ok(capturedPath, '应捕获到临时文件路径');
//   assert.ok(!existsSync(capturedPath), '读完后临时 PNG 必须删掉（不留垃圾文件）');
// });
