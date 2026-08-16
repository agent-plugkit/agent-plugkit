/**
 * add 命令 — 向已有插件追加组件
 *
 * 用法：agent-plugkit add <skill|mcp|lsp|hook> <plugin-name> <component-name>
 */

import chalk from 'chalk';
import {
  executePluginComponentPlan,
  planPluginComponentMutation,
  readPluginComponents,
} from '../application/plugin-components.js';
import { CommandError } from '../core/errors.js';
import { resolveRepoContext } from '../utils/helpers.js';
import {
  addedComponentEntry,
  assertKebabName,
  parseComponentType,
  type ComponentType,
} from './component-scaffold.js';

function componentLabel(type: ComponentType): string {
  switch (type) {
    case 'skill':
      return 'Skill';
    case 'mcp':
      return 'MCP server';
    case 'lsp':
      return 'LSP server';
    case 'hook':
      return 'Hook';
  }
}

export function runAdd(
  typeArg: string,
  pluginName: string,
  componentName: string,
  options: { root?: string } = {},
): void {
  const type = parseComponentType(typeArg);
  assertKebabName(pluginName, '插件名');
  assertKebabName(componentName, '组件名');

  const context = resolveRepoContext(options.root);
  const entry = addedComponentEntry(type, componentName);
  const value =
    type === 'skill'
      ? entry.skills?.[0]
      : type === 'mcp'
        ? entry.mcp?.[0]
        : type === 'hook'
          ? entry.hooks?.[0]
          : entry.lsp?.[0];
  if (value === undefined) {
    throw new CommandError(`无法创建 ${componentLabel(type)} 默认声明`);
  }
  const current = readPluginComponents({
    directory: context.rootDir,
    pluginDirectoryName: pluginName,
  });
  if (current.status !== 'loaded') {
    throw new CommandError(
      current.status === 'unavailable'
        ? `插件目录不存在或不可用: plugins/${pluginName}`
        : current.message,
    );
  }
  if (current.canonicalName !== pluginName) {
    throw new CommandError(
      `plugin.yaml 中的 name (${current.canonicalName}) 与目录名 (${pluginName}) 不一致`,
    );
  }
  const planned = planPluginComponentMutation({
    directory: context.rootDir,
    pluginDirectoryName: pluginName,
    expectedRevision: current.revision,
    mutation: {
      operation: 'add',
      kind: type,
      value,
      createScaffold: type === 'skill' || type === 'hook',
    },
  });
  if (planned.status !== 'planned') {
    const issue = 'issues' in planned ? planned.issues[0] : undefined;
    throw new CommandError(issue?.message ?? planned.message);
  }

  console.log(chalk.blue(`⟳ 向插件 ${pluginName} 添加 ${componentLabel(type)}: ${componentName}`));
  const result = executePluginComponentPlan(planned.plan);
  if (result.status !== 'saved') {
    throw new CommandError(
      result.status === 'conflict'
        ? 'plugin.yaml 已在外部变化，请重新运行 add'
        : result.message,
    );
  }

  console.log(chalk.green(`✓ 已添加 ${componentLabel(type)}: plugins/${pluginName}`));
  console.log(chalk.gray(`  → 运行 agent-plugkit build ${pluginName}`));
  console.log(chalk.gray(`  → 运行 agent-plugkit validate ${pluginName}`));
}
