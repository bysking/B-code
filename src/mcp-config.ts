import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirs } from "./utils/paths.js";

/**
 * MCP 配置解析（P5 前置）：mcp.json 在哪里找、怎么合并。
 *
 * 搜索链（env 最高优先，同名 server 后者胜）：
 *   1. $B_CODE_MCP_CONFIG                        显式覆盖（CI / 多环境）
 *   2. {cwd}/.claude/mcp.json                    项目级
 *   3. {basePath}/mcp.json                       用户级·随 B_CODE_HOME 迁移
 *
 * 纯函数、不校验具体 server 字段——P5 的 mcp-loader 从这里拿配置去 spawn。
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 声明 "read" 则该 server 所有工具按只读放行（免确认）；缺省 fail-closed → confirm */
  mode?: "read";
}

export type McpConfig = Record<string, McpServerConfig>;

export const MCP_CONFIG_ENV = "B_CODE_MCP_CONFIG";

/** 按优先级列出候选配置文件路径 */
export function mcpConfigPaths(cwd: string = process.cwd()): string[] {
  const paths: string[] = [];
  const envPath = process.env[MCP_CONFIG_ENV];
  if (envPath) paths.push(envPath);
  paths.push(join(cwd, ".claude", "mcp.json"));
  paths.push(dirs.mcpConfigFile()); // {basePath}/mcp.json
  return paths;
}

/** 合并各来源的 MCP server（低优先级先合并，高优先级后覆盖同名）；坏文件跳过 */
export function resolveMcpConfigs(cwd: string = process.cwd()): McpConfig {
  const merged: McpConfig = {};
  // 优先级高者最后写入（覆盖同名 server）：从用户级 → 项目级 → env 依次合并
  for (const file of [...mcpConfigPaths(cwd)].reverse()) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8"));
      const servers: Record<string, McpServerConfig> = raw.mcpServers ?? raw;
      for (const [name, cfg] of Object.entries(servers)) {
        if (cfg && typeof cfg === "object") merged[name] = cfg;
      }
    } catch {
      // 坏配置文件跳过，不阻塞启动
    }
  }
  return merged;
}