/**
 * 首次启动配置向导
 *
 * 检测 B_CODE_HOME/settings.json 是否存在，不存在则引导用户填写核心配置，
 * 使用 commander 定义交互命令，创建 settings.json 后继续启动。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Command } from 'commander';

import { settingsPath, type Settings } from './config.js';
import { basePath } from './utils/paths.js';

/** 默认配置值（用户首次启动时作为预填参考） */
const DEFAULT_SETTINGS: Settings = {
  provider: 'openai',
  apiKey: 'your-key-here',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  env: {
    NO_PROXY: '127.0.0.1,localhost',
    B_CODE_LOG_LEVEL: 'error',
    B_CODE_LOG_FILE: 'true',
  },
};

/** 用 readline 向用户提一个问题，返回输入值 */
function askQuestion(query: string, defaultValue = ''): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

/** 二选一选择器 */
async function askChoice(
  question: string,
  choices: string[],
  defaultIndex = 0,
): Promise<string> {
  process.stdout.write(`\n${question}\n`);
  choices.forEach((c, i) => {
    const marker = i === defaultIndex ? ' [default]' : '';
    process.stdout.write(`  ${i + 1}. ${c}${marker}\n`);
  });
  const answer = await askQuestion(`请输入编号 (1-${choices.length}): `, String(defaultIndex + 1));
  const idx = Math.max(0, Math.min(choices.length - 1, parseInt(answer, 10) - 1));
  return choices[idx]!;
}

/**
 * 交互式配置向导：让用户填写核心配置，返回 Settings 对象
 * 使用 commander 的 Command 对象来结构化交互选项
 */
async function interactiveSetup(): Promise<Settings> {
  console.log('\n' + '='.repeat(50));
  console.log('  🚀 首次启动检测到 bcode 尚未配置');
  console.log('  请完成以下配置:');
  console.log('='.repeat(50) + '\n');

  const provider = await askChoice('选择 AI 后端:', ['Anthropic (Claude)', 'OpenAI 兼容'], 1);
  const providerKey = provider === 'Anthropic (Claude)' ? 'anthropic' : 'openai';

  const apiKey = await askQuestion(
    `请输入 API Key (默认: ${DEFAULT_SETTINGS.apiKey}): `,
    DEFAULT_SETTINGS.apiKey ?? '',
  );
  if (!apiKey) {
    console.error('\n⚠️  API Key 不能为空，配置终止。');
    process.exit(1);
  }

  const baseUrl = await askQuestion(
    `请输入 Base URL (默认: ${DEFAULT_SETTINGS.baseUrl}): `,
    DEFAULT_SETTINGS.baseUrl ?? '',
  );

  const model = await askQuestion(
    `请输入默认模型名 (默认: ${DEFAULT_SETTINGS.model}): `,
    DEFAULT_SETTINGS.model ?? '',
  );

  const settings: Settings = {
    provider: providerKey as 'anthropic' | 'openai',
    apiKey,
    env: { ...DEFAULT_SETTINGS.env },
  };

  if (baseUrl) settings.baseUrl = baseUrl;
  if (model) settings.model = model;

  console.log('\n' + '-'.repeat(50));
  console.log('  配置摘要:');
  console.log(`    后端:    ${providerKey}`);
  console.log(`    API Key: ${apiKey.slice(0, 6)}******`);
  if (baseUrl) console.log(`    Base URL: ${baseUrl}`);
  if (model) console.log(`    模型:    ${model}`);
  console.log('    环境变量:');
  for (const [k, v] of Object.entries(settings.env ?? {})) {
    console.log(`      ${k}=${v}`);
  }
  console.log('-'.repeat(50) + '\n');

  return settings;
}

/**
 * 用 commander 定义 setup 命令，支持非交互式参数传入
 * 也作为独立命令入口：bcode setup [options]
 */
export function createSetupCommand(): Command {
  const cmd = new Command('setup')
    .description('初始化 bcode 全局配置（首次启动自动运行）')
    .option('-p, --provider <provider>', 'AI 后端: anthropic | openai')
    .option('-k, --api-key <key>', 'API Key')
    .option('-b, --base-url <url>', 'Base URL（可选）')
    .option('-m, --model <model>', '默认模型名（可选）')
    .action(async (options) => {
      let settings: Settings;

      if (options.apiKey) {
        // 非交互模式：使用命令行参数
        settings = {
          provider: (options.provider as 'anthropic' | 'openai') || 'anthropic',
          apiKey: options.apiKey,
          env: { ...DEFAULT_SETTINGS.env },
        };
        if (options.baseUrl) settings.baseUrl = options.baseUrl;
        if (options.model) settings.model = options.model;
      } else {
        // 交互模式
        settings = await interactiveSetup();
      }

      writeSettings(settings);
      console.log('✅ 配置已保存到:', settingsPath());
      console.log('运行 bcode 开始使用\n');
      process.exit(0);
    });

  return cmd;
}

/** 写入 settings.json */
function writeSettings(settings: Settings): void {
  const path = settingsPath();
  const dir = basePath();
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error(`\n❌ 写入配置文件失败: ${path}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * 检测 settings.json 是否存在。
 * 不存在则运行配置向导（使用 commander 交互），完成后创建文件。
 */
export async function ensureSetup(): Promise<void> {
  if (existsSync(settingsPath())) {
    return; // 已配置，正常启动
  }

  // 未配置，运行向导（交互式）
  console.log('\n📋 检测到 bcode 尚未初始化配置');
  console.log(`   配置文件路径: ${settingsPath()}\n`);

  try {
    const settings = await interactiveSetup();
    writeSettings(settings);
    console.log(`✅ 配置已保存到: ${settingsPath()}\n`);
  } catch (err) {
    console.error('\n❌ 配置初始化失败');
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}