import 'dotenv/config';
import { existsSync } from 'node:fs';
import { runCli } from './cli.js';
import { defaultModel, useOpenAI } from './backend.js';
import { applySettings, ensureDataDirs, settingsPath } from './config.js';
import { createSetupCommand, ensureSetup } from './setup.js';
import { setupLogging, log } from './utils/log.js';
import { basePath, dirs } from './utils/paths.js';

// 支持手动运行 bcode setup 重新配置
const firstArg = process.argv[2];
if (firstArg === 'setup' || firstArg === 'init') {
  try {
    const setupCmd = createSetupCommand();
    await setupCmd.parseAsync(process.argv.slice(2));
  } catch (err) {
    console.error('\n❌ 配置过程出错:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  process.exit(0);
}

// 首次启动检测：检查全局 settings.json 是否存在
// 不存在则引导用户交互式填写核心配置并创建 settings.json
if (!existsSync(settingsPath())) {
  try {
    await ensureSetup();
  } catch (err) {
    console.error('\n❌ 配置初始化失败:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// 启动装配顺序：.env → 全局配置（缺省补 env）→ 确保数据目录 → 日志
applySettings();
ensureDataDirs();
setupLogging();
log.debug('b-code starting', {
  basePath: basePath(),
  settings: settingsPath(),
  sessionFile: dirs.sessionFile(),
  backend: useOpenAI() ? 'openai-compatible' : 'anthropic',
  model: defaultModel(),
  platform: process.platform,
  node: process.version,
  cwd: process.cwd(),
});

await runCli();
