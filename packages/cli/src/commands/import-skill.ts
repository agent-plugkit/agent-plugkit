/**
 * import-skill 命令 — 导入已有 skill 目录，生成新的 skill 插件
 *
 * 用法：agent-plugkit import-skill <source> [name] [--description <text>] [--author <name>]
 *
 * 命令层只保留既有终端呈现。源检查、推导、预算、staging、冲突检查与
 * 回滚全部由共享 application 能力拥有。
 */

import chalk from 'chalk';
import {
  executePluginTransaction,
  planSkillImport,
} from '../application/plugin-lifecycle.js';
import { CommandError } from '../core/errors.js';
import { resolveInvocationPath, resolveRepoContext } from '../utils/helpers.js';

interface ImportSkillOptions {
  description?: string;
  author?: string;
  root?: string;
}

export function runImportSkill(
  source: string,
  name: string | undefined,
  options: ImportSkillOptions = {},
): void {
  const absSource = resolveInvocationPath(source);
  const context = resolveRepoContext(options.root);
  const planned = planSkillImport({
    workspaceDirectory: context.rootDir,
    sourceDirectory: absSource,
    ...(name === undefined ? {} : { name }),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(options.author === undefined ? {} : { author: options.author }),
  });
  if (planned.status !== 'planned') {
    throw new CommandError(planned.problem.message);
  }

  const pluginName = planned.plan.derivation.pluginName;
  console.log(chalk.blue(`⟳ 导入 skill: ${absSource} → plugins/${pluginName}`));
  for (const warning of planned.plan.derivation.warnings) {
    console.log(chalk.yellow(`  ! ${warning.message}`));
  }

  const created = executePluginTransaction(planned.plan);
  if (created.status !== 'created') {
    throw new CommandError(created.problem.message);
  }

  console.log(chalk.green(`✓ 插件创建成功: plugins/${pluginName}/`));
  console.log(chalk.gray(`  → 运行 agent-plugkit build ${pluginName}`));
  console.log(chalk.gray(`  → 运行 agent-plugkit validate ${pluginName}`));
}
