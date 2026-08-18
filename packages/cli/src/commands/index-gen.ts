/**
 * index-gen 命令 — 生成 marketplace 索引文件
 *
 * Claude Code: 生成 .claude-plugin/marketplace.json
 * Codex: 生成 .agents/plugins/marketplace.json
 * GitHub Copilot / VS Code: 生成 .github/plugin/marketplace.json
 * 根 marketplace.json: 生成 Copilot 优先查找路径所需的兼容镜像
 * Cursor: 生成 .cursor-plugin/marketplace.json
 * Grok Build: 生成 .grok-plugin/marketplace.json
 */

import chalk from 'chalk';
import {
  resolveRepoContext,
} from '../utils/helpers.js';
import {
  commitMarketplaceIndexPlan,
  planMarketplaceIndex,
} from '../application/artifact-generation.js';

export function runIndexGen(options: { root?: string } = {}): void {
  console.log(chalk.blue('⟳ 生成 marketplace 索引...\n'));

  const context = resolveRepoContext(options.root);
  const plan = planMarketplaceIndex(context.rootDir);

  if (plan.pluginCount === 0) {
    console.log(chalk.yellow('  ⚠ 没有找到插件'));
    return;
  }

  const result = commitMarketplaceIndexPlan(plan);
  if (result.status !== 'committed' && result.status !== 'verified') {
    throw new Error(
      'message' in result ? result.message : '索引提交没有完成',
    );
  }
  console.log(chalk.green('  ✓ .claude-plugin/marketplace.json (Claude Code)'));
  console.log(chalk.green('  ✓ .agents/plugins/marketplace.json (Codex)'));
  console.log(chalk.green('  ✓ .github/plugin/marketplace.json (GitHub Copilot / VS Code)'));
  console.log(chalk.green('  ✓ .cursor-plugin/marketplace.json (Cursor)'));
  console.log(chalk.green('  ✓ .grok-plugin/marketplace.json (Grok Build)'));
  console.log(chalk.green('  ✓ marketplace.json (GitHub Copilot 优先路径兼容镜像)'));
  console.log(chalk.green('  ✓ plugins/CATALOG.md'));

  console.log(chalk.green(`\n✓ 索引生成完成 (${plan.pluginCount} 个插件)`));
}
