/**
 * release-local 命令 — 组装本地发布产物
 *
 * CLI 只拥有终端呈现；目录、manifest、README、archive 身份与事务
 * 由共享 application plan/commit 能力负责。
 */

import { join } from "node:path";
import chalk from "chalk";
import {
  commitLocalReleasePlan,
  planLocalRelease,
} from "../application/local-release.js";
import { resolveRepoContext } from "../utils/helpers.js";

export function runReleaseLocal(options: { root?: string } = {}): void {
  console.log(chalk.blue("⟳ 组装本地发布包...\n"));

  const plan = planLocalRelease(resolveRepoContext(options.root).rootDir);
  const result = commitLocalReleasePlan(plan);
  if (result.status !== "success") {
    throw new Error(
      result.status === "canceled"
        ? result.message
        : result.phase === "archive"
          ? `发布包压缩失败: ${plan.archiveName}`
          : result.message,
    );
  }

  const archivePath = join(plan.workspaceDirectory, plan.archiveRelativePath);
  console.log(chalk.green(`  ✓ dist/release (${plan.pluginCount} 个插件)`));
  console.log(chalk.green(`  ✓ ${archivePath}`));
  console.log(chalk.green("\n✓ 本地发布包生成完成"));
}
