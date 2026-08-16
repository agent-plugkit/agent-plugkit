/**
 * init 命令 — 创建新插件骨架
 *
 * 用法：agent-plugkit init <name> [--type skill|mcp|lsp|hook]
 */

import chalk from 'chalk';
import { resolveRepoContext } from '../utils/helpers.js';
import { CommandError } from '../core/errors.js';
import {
  executePluginTransaction,
  planPluginCreation,
} from '../application/plugin-lifecycle.js';
import {
  assertKebabName,
  parseComponentType,
} from './component-scaffold.js';

export function runInit(name: string, options: { type: string; root?: string }): void {
  const context = resolveRepoContext(options.root);
  assertKebabName(name, '插件名');
  const type = parseComponentType(options.type || 'skill');
  const planned = planPluginCreation(context.rootDir, name, type);
  if (planned.status !== 'planned') {
    throw new CommandError(planned.problem.message);
  }

  console.log(chalk.blue(`⟳ 创建插件: ${name} (类型: ${type})`));
  const created = executePluginTransaction(planned.plan);
  if (created.status !== 'created') {
    throw new CommandError(created.problem.message);
  }

  console.log(chalk.green(`✓ 插件创建成功: plugins/${name}/`));
  console.log(chalk.gray(`  → 编辑 plugin.yaml 完善配置`));
  if (type === 'skill' || type === 'mcp' || type === 'lsp') {
    console.log(chalk.gray(`  → 编辑 skills/${name}/SKILL.md 编写指令`));
  }
  if (type === 'hook') {
    console.log(chalk.gray(`  → 编辑 hooks/${name}.sh 实现逻辑`));
  }
}
