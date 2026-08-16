/**
 * init-repo 命令 — 创建新的 AI agent plugin marketplace 仓库
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { resolveInvocationPath } from '../utils/helpers.js';
import { CommandError } from '../core/errors.js';
import {
  executeWorkspaceCreation,
  normalizeWorkspaceCreationRequest,
  planWorkspaceCreation,
} from '../application/workspace-create.js';

const CLI_PACKAGE = 'agent-plugkit';
export function runInitRepo(
  name: string | undefined,
  options: { organization?: string; plugkit?: boolean; root?: string },
): void {
  const rootDir = options.root ? resolveInvocationPath(options.root) : resolveInvocationPath('.');
  if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true });
  const request = normalizeWorkspaceCreationRequest(
    rootDir,
    name,
    options.organization,
    options.plugkit !== false,
  );
  const plan = planWorkspaceCreation(request);
  const existingMarketplace = plan.conflicts.find(
    (conflict) => conflict.code === 'MARKETPLACE_EXISTS',
  );
  if (existingMarketplace) {
    throw new CommandError(
      `marketplace.yaml 已存在: ${join(rootDir, 'marketplace.yaml')}`,
    );
  }
  if (plan.status === 'blocked') {
    throw new CommandError(plan.conflicts[0]?.message ?? '无法初始化仓库');
  }

  console.log(chalk.blue(`⟳ 初始化 AI agent plugin marketplace 仓库: ${request.name}`));
  const result = executeWorkspaceCreation(request, plan.fingerprint);
  if (result.status !== 'created') {
    const message =
      result.status === 'blocked'
        ? result.conflicts[0]?.message
        : result.message;
    throw new CommandError(message ?? '无法初始化仓库');
  }

  if (request.includePlugkit) {
    const writtenPlugkit = result.written.filter((path) =>
      path.startsWith('plugins/plugkit/'),
    );
    const preservedPlugkit = result.preserved.filter((path) =>
      path.startsWith('plugins/plugkit/'),
    );
    if (writtenPlugkit.length > 0) {
      console.log(chalk.green('✓ 已初始化官方 plugkit 插件'));
      for (const path of writtenPlugkit) {
        console.log(chalk.gray(`  → ${path}`));
      }
    }
    if (preservedPlugkit.length > 0) {
      console.log(chalk.yellow('! 官方 plugkit 插件文件已存在，保留现有文件'));
      for (const path of preservedPlugkit) {
        console.log(chalk.gray(`  → ${path}`));
      }
    }
  }

  console.log(chalk.green(`✓ 仓库初始化完成: ${rootDir}`));
  console.log(chalk.gray(`  → npx ${CLI_PACKAGE} init my-plugin`));
  console.log(chalk.gray(`  → npx ${CLI_PACKAGE} add skill plugkit audit`));
  console.log(chalk.gray(`  → npx ${CLI_PACKAGE} validate --all`));
}
