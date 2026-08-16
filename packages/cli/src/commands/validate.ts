/**
 * validate command — terminal presentation over the shared read-only health
 * scan. The public stdout and exit behavior remains the CLI contract.
 */

import chalk from 'chalk';
import { adaptHealthToCliValidation } from '../adapters/cli-validation.js';
import { scanWorkspaceHealth } from '../application/workspace-health.js';
import { CommandError } from '../core/errors.js';
import {
  listPluginNames,
  resolveRepoContext,
} from '../utils/helpers.js';

export function runValidate(
  name: string | undefined,
  options: { all: boolean; root?: string },
): void {
  const context = resolveRepoContext(options.root);
  const names = options.all ? listPluginNames(context) : name ? [name] : [];

  if (names.length === 0) {
    throw new CommandError('请指定插件名或使用 --all');
  }

  const scan = scanWorkspaceHealth({
    directory: context.rootDir,
    pluginNames: names,
  });
  if (scan.status === 'unavailable') {
    throw new CommandError(
      scan.error.technicalDetail ?? scan.error.message,
    );
  }
  const results = adaptHealthToCliValidation(
    scan.snapshot,
    scan.validationDiagnostics,
    names,
  );

  console.log(chalk.blue(`⟳ 验证 ${names.length} 个插件...\n`));

  let allValid = true;
  for (const result of results) {
    if (result.valid) {
      console.log(chalk.green(`  ✓ ${result.name}`));
      continue;
    }
    allValid = false;
    console.log(chalk.red(`  ✗ ${result.name}`));
    for (const error of result.errors) {
      console.log(chalk.red(`    └─ ${error}`));
    }
  }

  console.log();
  if (allValid) {
    console.log(chalk.green('✓ 所有插件验证通过'));
  } else {
    throw new CommandError('存在验证错误');
  }
}
