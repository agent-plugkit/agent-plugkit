#!/usr/bin/env node

/**
 * agent-plugkit CLI — AI agent plugin marketplace 工具
 *
 * 命令：
 *   agent-plugkit init-repo [name] 创建新插件仓库
 *   agent-plugkit init <name>      创建新插件
 *   agent-plugkit add <type>       向已有插件追加组件
 *   agent-plugkit import-skill <source> [name]  导入已有 skill 目录，生成新插件
 *   agent-plugkit validate [name]  验证插件格式
 *   agent-plugkit build [name]     生成 portable 与平台原生 manifest
 *   agent-plugkit index            生成 marketplace 索引
 *   agent-plugkit release-local    组装本地发布包
 *   agent-plugkit install-repo     注册已就绪的 marketplace 到客户端
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command, type Option } from 'commander';
import { runInitRepo } from './commands/init-repo.js';
import { runInit } from './commands/init.js';
import { runAdd } from './commands/add.js';
import { runImportSkill } from './commands/import-skill.js';
import { runValidate } from './commands/validate.js';
import { runBuild } from './commands/build.js';
import { runIndexGen } from './commands/index-gen.js';
import { runReleaseLocal } from './commands/release-local.js';
import { runInstallRepo } from './commands/install-repo.js';
import { isCommandError } from './core/errors.js';

const program = new Command();

function rootOption(): string | undefined {
  return program.opts<{ root?: string }>().root;
}

function readPackageVersion(): string {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const raw = readFileSync(packagePath, 'utf-8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version || '0.0.0';
}

const helpTitleMap: Record<string, string> = {
  'Usage:': '用法:',
  'Arguments:': '参数:',
  'Options:': '选项:',
  'Global Options:': '全局选项:',
  'Commands:': '命令:',
};

function formatOptionDescription(option: Option): string {
  const extraInfo: string[] = [];

  if (option.argChoices) {
    extraInfo.push(
      `可选值: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(', ')}`,
    );
  }

  if (option.defaultValue !== undefined) {
    const showDefault =
      option.required ||
      option.optional ||
      (option.isBoolean() && typeof option.defaultValue === 'boolean');
    if (showDefault) {
      extraInfo.push(`默认值: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`);
    }
  }

  if (option.presetArg !== undefined && option.optional) {
    extraInfo.push(`预设值: ${JSON.stringify(option.presetArg)}`);
  }

  if (option.envVar !== undefined) {
    extraInfo.push(`环境变量: ${option.envVar}`);
  }

  return extraInfo.length > 0 ? `${option.description} (${extraInfo.join(', ')})` : option.description;
}

program
  .name('agent-plugkit')
  .description('管理 Agent Plugins 兼容的多客户端 AI agent plugin marketplace 仓库')
  .version(readPackageVersion(), '-V, --version', '显示版本号')
  .helpOption('-h, --help', '显示帮助')
  .addHelpCommand('help [command]', '显示指定命令的帮助')
  .configureHelp({
    optionDescription: formatOptionDescription,
    styleTitle: (title) => helpTitleMap[title] || title,
  })
  .option('--root <dir>', '插件仓库根目录；默认从当前目录向上查找 marketplace.yaml');

program
  .command('init-repo [name]')
  .description('创建新的 AI agent plugin marketplace 仓库')
  .option('--organization <name>', 'marketplace 所属组织名称')
  .option('--no-plugkit', '跳过初始化官方 plugkit 插件')
  .action((name: string | undefined, options: { organization?: string; plugkit: boolean }) =>
    runInitRepo(name, { ...options, root: rootOption() }),
  );

program
  .command('init <name>')
  .description('创建新插件骨架')
  .option('-t, --type <type>', '插件类型: skill, mcp, lsp, hook', 'skill')
  .action((name: string, options: { type: string }) =>
    runInit(name, { ...options, root: rootOption() }),
  );

program
  .command('add <component> <plugin-name> <component-name>')
  .description('向已有插件追加组件: skill, mcp, lsp, hook')
  .action((component: string, pluginName: string, componentName: string) =>
    runAdd(component, pluginName, componentName, { root: rootOption() }),
  );

program
  .command('import-skill <source> [name]')
  .description('导入已有 skill 目录，生成新的 skill 插件')
  .option('--description <text>', '覆盖插件描述')
  .option('--author <name>', '覆盖插件作者名')
  .action(
    (
      source: string,
      name: string | undefined,
      options: { description?: string; author?: string },
    ) => runImportSkill(source, name, { ...options, root: rootOption() }),
  );

program
  .command('validate [name]')
  .description('验证插件格式')
  .option('-a, --all', '验证所有插件')
  .action((name: string | undefined, options: { all: boolean }) =>
    runValidate(name, { ...options, root: rootOption() }),
  );

program
  .command('build [name]')
  .description('从 plugin.yaml 生成 portable 与平台原生 manifest')
  .option('-a, --all', '构建所有插件')
  .action((name: string | undefined, options: { all: boolean }) =>
    runBuild(name, { ...options, root: rootOption() }),
  );

program
  .command('index')
  .description('生成 marketplace 索引文件')
  .action(() => runIndexGen({ root: rootOption() }));

program
  .command('release-local')
  .description('组装本地发布包')
  .action(() => runReleaseLocal({ root: rootOption() }));

program
  .command('install-repo <source>')
  .description('把已就绪的 marketplace 注册到所选 agent（不安装具体插件）')
  .option(
    '--agent <agent>',
    '目标 agent，可重复: claude, codex, copilot, vscode, cursor',
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option('--all', '选择全部五个 agent（Cursor 仍需手工处理）')
  .action(
    async (
      source: string,
      options: { agent: string[]; all: boolean },
    ) => {
      const result = await runInstallRepo(source, options);
      process.exitCode = result.exitCode;
    },
  );

try {
  await program.parseAsync();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`✗ ${message}`));
  process.exit(isCommandError(err) ? err.exitCode : 1);
}
