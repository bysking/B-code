import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * 统一数据根目录：所有「数据往哪放」的问题都收敛到这里
 *
 * 解析顺序：
 *   1. $B_CODE_HOME    —— 显式覆盖（必须绝对路径）。测试隔离 / 换机迁移 / CI 注入的唯一入口
 *   2. {主目录}/.b-code —— 默认。os.homedir() 天然跨平台：
 *        Windows → %USERPROFILE%（未设则 HOMEDRIVE+HOMEPATH）
 *        macOS/Linux → $HOME
 *
 * 未来会话（session.json）、日志、记忆、mcp.json、缓存全部以 basePath() 为根。
 */

const DATA_DIR_NAME = '.b-code';
export const BASE_PATH_ENV = 'B_CODE_HOME';

/** 当前系统登录用户主目录（跨平台） */
export function userHomeDir(): string {
  return homedir();
}

/** 数据根目录：B_CODE_HOME 覆盖优先，否则 ~/.b-code */
export function basePath(): string {
  const override = process.env[BASE_PATH_ENV];
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(`${BASE_PATH_ENV} 必须是绝对路径（当前值: "${override}"）`);
    }
    return override;
  }
  return join(userHomeDir(), DATA_DIR_NAME);
}

/** 各类存放位置（懒函数，避免初始化顺序问题） */
export const dirs = {
  /** 会话持久化文件 */
  sessionFile: () => join(basePath(), 'session.json'),
  /** 调试日志目录 */
  logsDir: () => join(basePath(), 'logs'),
  /** 跨项目记忆根目录（P4 使用） */
  projectsDir: () => join(basePath(), 'projects'),
  /** 用户级技能目录（随 B_CODE_HOME 迁移；P4 使用） */
  skillsDir: () => join(basePath(), 'skills'),
  /** 用户级 MCP 服务器配置（P5 使用） */
  mcpConfigFile: () => join(basePath(), 'mcp.json'),
  /** Plan 文件目录（P5 使用） */
  plansDir: () => join(basePath(), 'plans'),
};

/**
 * 文件名清洗：Windows 保留字符 : * ? " < > | 与控制字符直接导致建文件失败，
 * 同时去掉头尾点号（Windows 尾点非法）、压缩空白、限制长度。
 * P4 记忆/技能文件名必须过这里。
 */
export function safeName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f\s]/g, '_')
    .replace(/^\.+|\.+$/g, '_')
    .replace(/_+/g, '_')
    .trim()
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return cleaned || 'unnamed';
}
