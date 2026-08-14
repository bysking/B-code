import "dotenv/config";
import { Agent } from "./agent.js";
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

const instruction = process.argv.slice(2).join(" ").trim();

if (!instruction) {
  console.log("b-code skeleton ready");
  console.log(
    `Usage: pnpm dev "<instruction>"   # one-shot 模式（B_CODE_HOME 可覆盖数据目录，B_CODE_LOG_LEVEL 控制日志）`,
  );
  process.exit(0);
}

const agent = new Agent();
await agent.chat(instruction);
console.log("\n(done)");