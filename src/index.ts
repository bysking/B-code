import "dotenv/config";
import { runCli } from "./cli.js";
import { defaultModel, useOpenAI } from "./backend.js";
import { applySettings, ensureDataDirs, settingsPath } from "./config.js";
import { setupLogging, log } from "./utils/log.js";
import { basePath, dirs } from "./utils/paths.js";

// 启动装配顺序：.env → 全局配置（缺省补 env）→ 确保数据目录 → 日志
applySettings();
ensureDataDirs();
setupLogging();
log.debug("b-code starting", {
  basePath: basePath(),
  settings: settingsPath(),
  sessionFile: dirs.sessionFile(),
  backend: useOpenAI() ? "openai-compatible" : "anthropic",
  model: defaultModel(),
  platform: process.platform,
  node: process.version,
  cwd: process.cwd(),
});

await runCli();