import "dotenv/config";
import { runCli } from "./cli.js";
import { defaultModel, useOpenAI } from "./backend.js";
import { setupLogging, log } from "./utils/log.js";
import { basePath, dirs } from "./utils/paths.js";

setupLogging();
log.debug("b-code starting", {
  basePath: basePath(),
  sessionFile: dirs.sessionFile(),
  backend: useOpenAI() ? "openai-compatible" : "anthropic",
  model: defaultModel(),
  platform: process.platform,
  node: process.version,
  cwd: process.cwd(),
});

await runCli();