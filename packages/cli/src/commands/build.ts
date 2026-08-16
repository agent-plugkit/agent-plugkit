/**
 * build 命令 — 从 plugin.yaml 生成 portable 与平台原生 manifest
 */

import chalk from 'chalk';
import { CommandError } from '../core/errors.js';
import {
  listPluginNames,
  resolveRepoContext,
} from '../utils/helpers.js';
import {
  commitPluginBuildPlan,
  planPluginBuild,
} from '../application/artifact-generation.js';

export function runBuild(
  name: string | undefined,
  options: { all: boolean; root?: string },
): void {
  const context = resolveRepoContext(options.root);
  const names = options.all ? listPluginNames(context) : name ? [name] : [];

  if (names.length === 0) {
    throw new CommandError('请指定插件名或使用 --all');
  }

  console.log(chalk.blue(`⟳ 构建 ${names.length} 个插件的平台 manifest...\n`));

  for (const n of names) {
    try {
      const result = commitPluginBuildPlan(
        planPluginBuild(context.rootDir, n),
      );
      if (result.status !== 'committed' && result.status !== 'verified') {
        throw new Error(
          'message' in result ? result.message : '生成物提交没有完成',
        );
      }
      console.log(chalk.green(`  ✓ ${n}`));
    } catch (err) {
      throw new CommandError(`${n}: ${(err as Error).message}`);
    }
  }

  console.log(chalk.green(`\n✓ 构建完成`));
}
