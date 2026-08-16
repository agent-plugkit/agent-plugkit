import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, posix } from "node:path";
import {
  authorizeExistingDirectory,
  resolveAuthorizedPath,
} from "../infrastructure/authorized-path.js";
import {
  listPluginNames,
  loadAllPlugins,
  loadMarketplaceMetadata,
  resolveRepoContext,
} from "../utils/helpers.js";
import { inspectWorkspaceArtifacts } from "./artifact-generation.js";
import {
  runWorkspaceOperation,
} from "./workspace-operation.js";
import type {
  WorkspaceOperationIssue,
} from "./workspace-operation-contract.js";

export const LOCAL_RELEASE_DIRECTORY = "dist/release";
export const LOCAL_RELEASE_MANIFEST = "dist/release/release-manifest.json";
export const LOCAL_RELEASE_LOCK = ".agent-plugkit-release.lock";
const RELEASE_TRANSACTION_PREFIX = ".agent-plugkit-release-";
const MAX_RELEASE_ENTRIES = 50_000;
const MAX_RELEASE_BYTES = 512 * 1024 * 1024;

export interface LocalReleaseBlocker {
  readonly id: string;
  readonly code: string;
  readonly objectLabel: string;
  readonly summary: string;
  readonly impact: string;
  readonly nextAction: string;
}

export type LocalReleasePreflightResult =
  | {
      readonly status: "ready";
      readonly pluginCount: number;
    }
  | {
      readonly status: "blocked";
      readonly pluginCount: number;
      readonly blockers: readonly LocalReleaseBlocker[];
    }
  | {
      readonly status: "unavailable";
      readonly message: string;
    };

export interface LocalReleasePreflightDependencies {
  readonly now?: () => Date;
  readonly yieldToEventLoop?: () => Promise<void>;
  readonly runValidation?: typeof runWorkspaceOperation;
  readonly inspectArtifacts?: typeof inspectWorkspaceArtifacts;
}

interface ReleaseSnapshotDirectory {
  readonly kind: "directory";
  readonly sourceRelativePath: string;
  readonly releaseRelativePath: string;
  readonly mode: number;
}

interface ReleaseSnapshotFile {
  readonly kind: "file";
  readonly sourceRelativePath?: string;
  readonly releaseRelativePath: string;
  readonly mode: number;
  readonly bytes: Uint8Array;
  readonly revision: string;
}

type ReleaseSnapshotEntry = ReleaseSnapshotDirectory | ReleaseSnapshotFile;

export interface LocalReleasePlan {
  readonly kind: "local-release";
  readonly workspaceDirectory: string;
  readonly marketplaceName: string;
  readonly generatedAt: string;
  readonly pluginCount: number;
  readonly archiveName: string;
  readonly archiveRelativePath: string;
  readonly releaseDirectoryRelativePath: typeof LOCAL_RELEASE_DIRECTORY;
  readonly manifestRelativePath: typeof LOCAL_RELEASE_MANIFEST;
  readonly releaseDirectoryExisted: boolean;
  readonly sourceEntries: readonly ReleaseSnapshotEntry[];
  readonly releaseEntries: readonly ReleaseSnapshotEntry[];
  readonly existingReleaseRevision: string | "missing";
}

export interface PlanLocalReleaseDependencies {
  readonly now?: () => Date;
}

export type LocalReleaseBoundary =
  | "prepare-start"
  | "prepare-complete"
  | "directory-commit-start"
  | "directory-commit-complete"
  | "archive-start"
  | "archive-returned"
  | "archive-complete"
  | "verify-start"
  | "verify-complete";

export interface LocalReleaseTransactionFacts {
  readonly releaseDirectory: "unchanged" | "committed" | "uncertain";
  readonly archive: "not-created" | "created" | "uncertain";
  readonly changedPaths: readonly string[];
  readonly canonicalPaths: readonly string[];
  readonly createdParentPaths: readonly string[];
  readonly residuePaths: readonly string[];
  readonly diskChanged: boolean;
  readonly cleanupComplete: boolean;
}

export type LocalReleaseCommitResult =
  | {
      readonly status: "success";
      readonly phase: "verify";
      readonly pluginCount: number;
      readonly facts: LocalReleaseTransactionFacts;
    }
  | {
      readonly status: "failed";
      readonly phase:
        | "prepare"
        | "directory-commit"
        | "archive"
        | "verify";
      readonly message: string;
      readonly pluginCount: number;
      readonly facts: LocalReleaseTransactionFacts;
    }
  | {
      readonly status: "canceled";
      readonly phase: "prepare" | "directory-commit" | "archive" | "verify";
      readonly message: string;
      readonly pluginCount: number;
      readonly facts: LocalReleaseTransactionFacts;
    };

export interface LocalReleaseArchiveRequest {
  readonly distDirectory: string;
  readonly temporaryArchivePath: string;
}

export type LocalReleaseExpectedArchiveEntry =
  | {
      readonly relativePath: string;
      readonly kind: "directory";
    }
  | {
      readonly relativePath: string;
      readonly kind: "file";
      readonly revision: string;
      readonly byteLength: number;
    };

export interface LocalReleaseCommitDependencies {
  readonly createToken?: () => string;
  readonly signal?: AbortSignal;
  readonly onBoundary?: (
    boundary: LocalReleaseBoundary,
    facts: LocalReleaseTransactionFacts,
  ) => void;
  readonly yieldToEventLoop?: () => Promise<void>;
  readonly beforeStageEntry?: (relativePath: string) => void;
  readonly beforeInstallReleaseDirectory?: () => void;
  readonly beforeArchiveCommit?: (archiveRelativePath: string) => void;
  readonly archiveExecutor?: (request: LocalReleaseArchiveRequest) => void;
  readonly archiveVerifier?: (
    archivePath: string,
    expectedReleaseEntries: readonly LocalReleaseExpectedArchiveEntry[],
  ) => void;
  readonly cleanupOwnedPath?: (path: string, relativePath: string) => void;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function relativePathIsSafe(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_000 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === ".." || segment === "")
  );
}

function reservedEntry(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name === "dist" ||
    name === LOCAL_RELEASE_LOCK ||
    name.startsWith(RELEASE_TRANSACTION_PREFIX) ||
    name.startsWith(".agent-plugkit-document-") ||
    name.startsWith(".agent-plugkit-lock-")
  );
}

function readRequiredFile(
  workspaceDirectory: string,
  relativePath: string,
  label: string,
): ReleaseSnapshotFile {
  const authorization = authorizeExistingDirectory(workspaceDirectory);
  const path = resolveAuthorizedPath(authorization, relativePath);
  if (!existsSync(path)) {
    throw new Error(`${label} 不存在，请先运行 npm run ci:local`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`${label} 不是普通文件`);
  }
  const bytes = readFileSync(path);
  return {
    kind: "file",
    sourceRelativePath: relativePath,
    releaseRelativePath: relativePath,
    mode: stat.mode & 0o777,
    bytes,
    revision: sha256(bytes),
  };
}

function readRequiredDirectory(
  workspaceDirectory: string,
  relativePath: string,
  label: string,
): ReleaseSnapshotDirectory {
  const authorization = authorizeExistingDirectory(workspaceDirectory);
  const path = resolveAuthorizedPath(authorization, relativePath);
  if (!existsSync(path)) {
    throw new Error(`${label} 不存在，请先运行 npm run ci:local`);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new Error(`${label} 不是普通目录`);
  }
  return {
    kind: "directory",
    sourceRelativePath: relativePath,
    releaseRelativePath: relativePath,
    mode: stat.mode & 0o777,
  };
}

function walkExpectedTree(
  workspaceDirectory: string,
  sourceRelativePath: string,
  releaseRelativePath = sourceRelativePath,
): ReleaseSnapshotEntry[] {
  const authorization = authorizeExistingDirectory(workspaceDirectory);
  const source = resolveAuthorizedPath(authorization, sourceRelativePath);
  if (!existsSync(source)) {
    throw new Error(`${sourceRelativePath} 不存在，请先运行 npm run ci:local`);
  }
  const rootStat = lstatSync(source);
  if (!rootStat.isDirectory()) {
    throw new Error(`${sourceRelativePath} 不是目录`);
  }
  const result: ReleaseSnapshotEntry[] = [
    {
      kind: "directory",
      sourceRelativePath,
      releaseRelativePath,
      mode: rootStat.mode & 0o777,
    },
  ];
  const visit = (sourcePath: string, sourcePrefix: string, targetPrefix: string) => {
    for (const entry of readdirSync(sourcePath, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      if (reservedEntry(entry.name)) continue;
      const sourceChild = posix.join(sourcePrefix, entry.name);
      const targetChild = posix.join(targetPrefix, entry.name);
      if (!relativePathIsSafe(sourceChild) || !relativePathIsSafe(targetChild)) {
        throw new Error(`release 路径不安全：${sourceChild}`);
      }
      const path = resolveAuthorizedPath(authorization, sourceChild);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`release 不接受符号链接：${sourceChild}`);
      }
      if (stat.isDirectory()) {
        result.push({
          kind: "directory",
          sourceRelativePath: sourceChild,
          releaseRelativePath: targetChild,
          mode: stat.mode & 0o777,
        });
        visit(path, sourceChild, targetChild);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`release 只接受普通文件或目录：${sourceChild}`);
      }
      const bytes = readFileSync(path);
      result.push({
        kind: "file",
        sourceRelativePath: sourceChild,
        releaseRelativePath: targetChild,
        mode: stat.mode & 0o777,
        bytes,
        revision: sha256(bytes),
      });
      if (result.length > MAX_RELEASE_ENTRIES) {
        throw new Error("release 内容超过安全条目上限");
      }
    }
  };
  visit(source, sourceRelativePath, releaseRelativePath);
  return result;
}

function listComponentLabels(config: {
  components: {
    skills?: unknown[];
    mcp?: unknown[];
    lsp?: unknown[];
    hooks?: unknown[];
  };
}): string[] {
  const labels: string[] = [];
  if (config.components.skills?.length) labels.push("Skill");
  if (config.components.mcp?.length) labels.push("MCP");
  if (config.components.lsp?.length) labels.push("LSP");
  if (config.components.hooks?.length) labels.push("Hook");
  return labels;
}

function releaseReadme(
  marketplaceName: string,
  pluginCount: number,
): string {
  return `# ${marketplaceName} 本地发布包

本目录由 \`agent-plugkit release-local\` 生成。

## 内容

- \`plugins/\`: 插件源文件以及生成后的 Agent Plugins / Claude Code / Codex manifest
- 插件根 \`plugin.json\` / \`mcp.json\`: Agent Plugins 1.0 可移植 manifest 与 MCP 配置
- 插件内 \`.lsp.json\`: Claude Code LSP server 配置（仅 LSP 插件）
- \`.github/plugin/marketplace.json\`: GitHub Copilot / VS Code marketplace manifest
- \`.cursor-plugin/marketplace.json\`: Cursor marketplace manifest
- \`.claude-plugin/marketplace.json\`: Claude Code marketplace manifest
- \`.agents/plugins/marketplace.json\`: Codex repo marketplace manifest
- \`marketplace.json\`: GitHub Copilot 优先查找路径使用的根目录兼容镜像（Codex 继续使用 \`.agents/plugins/marketplace.json\`）
- \`marketplace.yaml\`: marketplace 元数据
- \`release-manifest.json\`: 本次发布包的元信息

## 插件数量

${pluginCount}
`;
}

function generatedFile(
  releaseRelativePath: string,
  value: string,
): ReleaseSnapshotFile {
  const bytes = Buffer.from(value, "utf8");
  return {
    kind: "file",
    releaseRelativePath,
    mode: 0o644,
    bytes,
    revision: sha256(bytes),
  };
}

function directoryRevision(
  workspaceDirectory: string,
  relativePath: string,
): string | "missing" {
  const authorization = authorizeExistingDirectory(workspaceDirectory);
  const path = resolveAuthorizedPath(authorization, relativePath);
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new Error(`${relativePath} 不是普通目录`);
  }
  const digest = createHash("sha256");
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const relative = posix.join(prefix, entry.name);
      const child = resolveAuthorizedPath(authorization, relative);
      const childStat = lstatSync(child);
      if (childStat.isSymbolicLink()) {
        throw new Error(`${relativePath} 包含符号链接`);
      }
      if (childStat.isDirectory()) {
        digest.update(`d\0${relative}\0${childStat.mode & 0o777}\0`);
        visit(child, relative);
      } else if (childStat.isFile()) {
        digest.update(`f\0${relative}\0${childStat.mode & 0o777}\0`);
        digest.update(readFileSync(child));
      } else {
        throw new Error(`${relativePath} 包含非普通对象`);
      }
    }
  };
  digest.update(`root\0${stat.mode & 0o777}\0`);
  visit(path, relativePath);
  return digest.digest("hex");
}

function assertHistoricalGeneratedOutputs(workspaceDirectory: string): void {
  const plugins = loadAllPlugins(resolveRepoContext(workspaceDirectory));
  readRequiredFile(workspaceDirectory, "plugins/CATALOG.md", "plugins/CATALOG.md");
  for (const { name, config } of plugins) {
    const prefix = `plugins/${name}`;
    readRequiredFile(
      workspaceDirectory,
      `${prefix}/plugin.json`,
      `${name} Agent Plugins manifest`,
    );
    readRequiredFile(
      workspaceDirectory,
      `${prefix}/.claude-plugin/plugin.json`,
      `${name} Claude manifest`,
    );
    readRequiredFile(
      workspaceDirectory,
      `${prefix}/.codex-plugin/plugin.json`,
      `${name} Codex manifest`,
    );
    if (config.components.mcp?.length) {
      readRequiredFile(
        workspaceDirectory,
        `${prefix}/mcp.json`,
        `${name} Agent Plugins MCP 配置`,
      );
      readRequiredFile(
        workspaceDirectory,
        `${prefix}/.mcp.json`,
        `${name} MCP 配置`,
      );
    }
    if (config.components.lsp?.length) {
      readRequiredFile(
        workspaceDirectory,
        `${prefix}/.lsp.json`,
        `${name} LSP 配置`,
      );
    }
    if (config.components.hooks?.length) {
      readRequiredFile(
        workspaceDirectory,
        `${prefix}/hooks/hooks.json`,
        `${name} hooks 配置`,
      );
    }
  }
}

function sourceSnapshotEntries(workspaceDirectory: string): ReleaseSnapshotEntry[] {
  // Preserve the existing CLI release shape: both platform trees are copied in
  // full. The explicit reads retain the historical missing-file diagnostics.
  readRequiredFile(
    workspaceDirectory,
    ".github/plugin/marketplace.json",
    "GitHub Copilot marketplace manifest",
  );
  readRequiredFile(
    workspaceDirectory,
    ".cursor-plugin/marketplace.json",
    "Cursor marketplace manifest",
  );
  readRequiredFile(
    workspaceDirectory,
    ".claude-plugin/marketplace.json",
    "Claude marketplace manifest",
  );
  readRequiredFile(
    workspaceDirectory,
    ".agents/plugins/marketplace.json",
    "Codex marketplace manifest",
  );
  assertHistoricalGeneratedOutputs(workspaceDirectory);
  return [
    ...walkExpectedTree(workspaceDirectory, "plugins"),
    readRequiredDirectory(workspaceDirectory, ".github", ".github"),
    ...walkExpectedTree(workspaceDirectory, ".github/plugin"),
    ...walkExpectedTree(workspaceDirectory, ".cursor-plugin"),
    ...walkExpectedTree(workspaceDirectory, ".claude-plugin"),
    ...walkExpectedTree(workspaceDirectory, ".agents"),
    readRequiredFile(
      workspaceDirectory,
      "marketplace.json",
      "marketplace.json",
    ),
    readRequiredFile(
      workspaceDirectory,
      "marketplace.yaml",
      "marketplace.yaml",
    ),
  ];
}

function sameSourceSnapshot(plan: LocalReleasePlan): boolean {
  const current = sourceSnapshotEntries(plan.workspaceDirectory);
  if (current.length !== plan.sourceEntries.length) return false;
  return current.every((entry, index) => {
    const expected = plan.sourceEntries[index];
    if (
      expected === undefined ||
      entry.kind !== expected.kind ||
      entry.sourceRelativePath !== expected.sourceRelativePath ||
      entry.releaseRelativePath !== expected.releaseRelativePath ||
      entry.mode !== expected.mode
    ) {
      return false;
    }
    return entry.kind === "directory" ||
      (expected.kind === "file" && entry.revision === expected.revision);
  });
}

function issueBlocker(
  issue: WorkspaceOperationIssue,
  index: number,
): LocalReleaseBlocker {
  return {
    id: `validation-${index + 1}`,
    code: issue.code,
    objectLabel: issue.targetId ?? "Marketplace",
    summary: issue.summary,
    impact: issue.impact,
    nextAction: issue.nextAction,
  };
}

export async function inspectLocalReleasePreflight(
  workspaceDirectory: string,
  dependencies: LocalReleasePreflightDependencies = {},
): Promise<LocalReleasePreflightResult> {
  try {
    const authorization = authorizeExistingDirectory(workspaceDirectory);
    const context = resolveRepoContext(authorization.canonicalPath);
    const pluginCount = listPluginNames(context).length;
    const run = dependencies.runValidation ?? runWorkspaceOperation;
    const now = dependencies.now ?? (() => new Date());
    const common = {
      now,
      ...(dependencies.yieldToEventLoop === undefined
        ? {}
        : { yieldToEventLoop: dependencies.yieldToEventLoop }),
    };
    const source = await run(
      {
        id: randomUUID(),
        kind: "source-check",
        workspaceDirectory: authorization.canonicalPath,
        workspaceLabel: "当前 Marketplace",
        startedAt: now().toISOString(),
      },
      common,
    );
    const full = await run(
      {
        id: randomUUID(),
        kind: "full-validate",
        workspaceDirectory: authorization.canonicalPath,
        workspaceLabel: "当前 Marketplace",
        startedAt: now().toISOString(),
      },
      common,
    );
    if (
      source.outcome === "execution-failure" ||
      full.outcome === "execution-failure"
    ) {
      return {
        status: "unavailable",
        message:
          source.diagnostics.at(-1)?.message ??
          full.diagnostics.at(-1)?.message ??
          "无法完成本地 release 前置检查。",
      };
    }
    const blockers: LocalReleaseBlocker[] = [];
    const seen = new Set<string>();
    const seenCodes = new Set<string>();
    for (const issue of [...source.issues, ...full.issues]) {
      const key = `${issue.code}\0${issue.targetId ?? ""}\0${issue.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seenCodes.add(issue.code);
      blockers.push(issueBlocker(issue, blockers.length));
    }
    if (pluginCount === 0 && !seenCodes.has("NO_PLUGIN_TARGETS")) {
      blockers.push({
        id: "validation-no-plugins",
        code: "NO_PLUGIN_TARGETS",
        objectLabel: "Marketplace",
        summary: "当前 Marketplace 没有可发布的插件。",
        impact: "本地 release 不能形成有意义的插件目录和数量事实。",
        nextAction: "先创建或导入至少一个插件，再生成并验证。",
      });
    }
    const inventory = (dependencies.inspectArtifacts ??
      inspectWorkspaceArtifacts)(authorization.canonicalPath);
    if (inventory.status === "unavailable") {
      if (blockers.length > 0) {
        return { status: "blocked", pluginCount, blockers };
      }
      return { status: "unavailable", message: inventory.message };
    }
    for (const artifact of inventory.artifacts) {
      if (artifact.freshness === "fresh") continue;
      blockers.push({
        id: `artifact-${artifact.id}`,
        code:
          artifact.freshness === "missing"
            ? "RELEASE_ARTIFACT_MISSING"
            : "RELEASE_ARTIFACT_STALE",
        objectLabel: `${artifact.source.label} · ${artifact.relativePath}`,
        summary:
          artifact.freshness === "missing"
            ? "这项生成结果尚不存在。"
            : "这项生成结果与当前 canonical source 不一致。",
        impact: "本地 release 会包含缺失或过期的平台结果。",
        nextAction: "先运行“生成并验证”，再重新检查发布条件。",
      });
    }
    return blockers.length === 0
      ? { status: "ready", pluginCount }
      : { status: "blocked", pluginCount, blockers };
  } catch (error) {
    return {
      status: "unavailable",
      message:
        error instanceof Error
          ? `无法完成本地 release 前置检查：${error.message}`
          : "无法完成本地 release 前置检查。",
    };
  }
}

export function planLocalRelease(
  workspaceDirectory: string,
  dependencies: PlanLocalReleaseDependencies = {},
): LocalReleasePlan {
  const authorization = authorizeExistingDirectory(workspaceDirectory);
  const context = resolveRepoContext(authorization.canonicalPath);
  const marketplace = loadMarketplaceMetadata(context);
  const plugins = loadAllPlugins(context);
  const generatedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const safeName = marketplace.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const archiveName = `${safeName}-release-${stamp}.tar.gz`;
  const archiveRelativePath = `dist/${archiveName}`;
  const archivePath = resolveAuthorizedPath(authorization, archiveRelativePath);
  if (existsSync(archivePath)) {
    throw new Error(`发布包已存在，不会覆盖: ${archiveName}`);
  }
  const distPath = resolveAuthorizedPath(authorization, "dist");
  if (existsSync(distPath)) {
    const stat = lstatSync(distPath);
    if (!stat.isDirectory()) throw new Error("dist 不是普通目录");
  }
  const sourceEntries = sourceSnapshotEntries(authorization.canonicalPath);
  const manifest = {
    generatedAt,
    pluginCount: plugins.length,
    plugins: plugins.map(({ name, config }) => ({
      name,
      version: config.version,
      category: config.category || "general",
      components: listComponentLabels(config),
    })),
    artifacts: {
      plugins: "plugins/",
      githubCopilotMarketplace: ".github/plugin/marketplace.json",
      cursorMarketplace: ".cursor-plugin/marketplace.json",
      claudeMarketplace: ".claude-plugin/marketplace.json",
      codexMarketplace: ".agents/plugins/marketplace.json",
      marketplaceMirror: "marketplace.json",
      marketplaceMetadata: "marketplace.yaml",
    },
  };
  const releaseEntries = [
    ...sourceEntries,
    generatedFile("release-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`),
    generatedFile("README.md", releaseReadme(marketplace.name, plugins.length)),
  ].sort((left, right) =>
    left.releaseRelativePath.localeCompare(right.releaseRelativePath),
  );
  const totalBytes = releaseEntries.reduce(
    (total, entry) => total + (entry.kind === "file" ? entry.bytes.byteLength : 0),
    0,
  );
  if (releaseEntries.length > MAX_RELEASE_ENTRIES || totalBytes > MAX_RELEASE_BYTES) {
    throw new Error("release 内容超过安全大小上限");
  }
  const existingReleaseRevision = directoryRevision(
    authorization.canonicalPath,
    LOCAL_RELEASE_DIRECTORY,
  );
  return Object.freeze({
    kind: "local-release",
    workspaceDirectory: authorization.canonicalPath,
    marketplaceName: marketplace.name,
    generatedAt,
    pluginCount: plugins.length,
    archiveName,
    archiveRelativePath,
    releaseDirectoryRelativePath: LOCAL_RELEASE_DIRECTORY,
    manifestRelativePath: LOCAL_RELEASE_MANIFEST,
    releaseDirectoryExisted: existingReleaseRevision !== "missing",
    sourceEntries,
    releaseEntries,
    existingReleaseRevision,
  });
}

function defaultArchiveExecutor(request: LocalReleaseArchiveRequest): void {
  const result = spawnSync(
    "tar",
    ["-czf", request.temporaryArchivePath, "-C", request.distDirectory, "release"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    throw new Error(detail.length > 0 ? detail : "tar 返回非零状态");
  }
}

function defaultArchiveVerifier(
  archivePath: string,
  expectedReleaseEntries: readonly LocalReleaseExpectedArchiveEntry[],
): void {
  const listing = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error("无法读取刚创建的本地压缩包");
  const entries = String(listing.stdout ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""));
  const expected: Array<
    | { readonly relativePath: string; readonly kind: "directory" }
    | {
        readonly relativePath: string;
        readonly kind: "file";
        readonly revision: string;
        readonly byteLength: number;
      }
  > = [
    { relativePath: "release", kind: "directory" as const },
    ...expectedReleaseEntries.map((entry) =>
      entry.kind === "file"
        ? {
            relativePath: `release/${entry.relativePath}`,
            kind: entry.kind,
            revision: entry.revision,
            byteLength: entry.byteLength,
          }
        : {
            relativePath: `release/${entry.relativePath}`,
            kind: entry.kind,
          },
    ),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const actualNames = [...entries].sort((left, right) => left.localeCompare(right));
  if (
    entries.length !== expected.length ||
    actualNames.some((entry, index) => entry !== expected[index]?.relativePath)
  ) {
    throw new Error("本地压缩包内容与已提交 release 目录不一致");
  }
  const verbose = spawnSync("tar", ["-tvzf", archivePath], { encoding: "utf8" });
  if (verbose.status !== 0) throw new Error("无法核对本地压缩包对象类型");
  const verboseEntries = String(verbose.stdout ?? "").split(/\r?\n/).filter(Boolean);
  if (verboseEntries.length !== entries.length) {
    throw new Error("本地压缩包对象类型清单不完整");
  }
  const expectedByArchivePath = new Map(
    expected.map((entry) => [entry.relativePath, entry]),
  );
  for (const [index, entry] of entries.entries()) {
    const type = verboseEntries[index]?.at(0);
    const expectedEntry = expectedByArchivePath.get(entry);
    if (
      expectedEntry === undefined ||
      (expectedEntry.kind === "directory" && type !== "d") ||
      (expectedEntry.kind === "file" && type !== "-")
    ) {
      throw new Error(`本地压缩包包含非预期对象类型：${entry}`);
    }
  }
  const contents = spawnSync("tar", ["-xOzf", archivePath], {
    encoding: null,
    maxBuffer: MAX_RELEASE_BYTES + 1024 * 1024,
  });
  if (contents.status !== 0 || !Buffer.isBuffer(contents.stdout)) {
    throw new Error("无法核对本地压缩包文件内容");
  }
  let offset = 0;
  for (const entry of entries) {
    const expectedEntry = expectedByArchivePath.get(entry);
    if (expectedEntry?.kind !== "file") continue;
    const end = offset + expectedEntry.byteLength;
    if (
      end > contents.stdout.byteLength ||
      sha256(contents.stdout.subarray(offset, end)) !== expectedEntry.revision
    ) {
      throw new Error(`本地压缩包文件内容与 release plan 不一致：${entry}`);
    }
    offset = end;
  }
  if (offset !== contents.stdout.byteLength) {
    throw new Error("本地压缩包包含无法映射到 release plan 的文件内容");
  }
}

function assertCommittedReleaseTree(
  plan: LocalReleasePlan,
  authorization: ReturnType<typeof authorizeExistingDirectory>,
): void {
  const releasePath = resolveAuthorizedPath(
    authorization,
    plan.releaseDirectoryRelativePath,
  );
  const rootStat = lstatSync(releasePath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("已提交 release 不是普通目录");
  }
  const expected = new Map(
    plan.releaseEntries.map((entry) => [
      entry.releaseRelativePath,
      entry.kind === "directory"
        ? { kind: "directory" as const }
        : { kind: "file" as const, revision: entry.revision },
    ]),
  );
  const actual = new Map<
    string,
    { kind: "directory" } | { kind: "file"; revision: string }
  >();
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const relativePath = prefix.length === 0
        ? entry.name
        : posix.join(prefix, entry.name);
      if (!relativePathIsSafe(relativePath)) {
        throw new Error(`release 核对发现不安全路径：${relativePath}`);
      }
      const path = resolveAuthorizedPath(
        { canonicalPath: releasePath },
        relativePath,
      );
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`release 核对不接受符号链接：${relativePath}`);
      }
      if (stat.isDirectory()) {
        actual.set(relativePath, { kind: "directory" });
        visit(path, relativePath);
      } else if (stat.isFile()) {
        actual.set(relativePath, {
          kind: "file",
          revision: sha256(readFileSync(path)),
        });
      } else {
        throw new Error(`release 核对只接受普通文件或目录：${relativePath}`);
      }
    }
  };
  visit(releasePath, "");
  if (actual.size !== expected.size) {
    throw new Error("release 目录包含缺失或额外对象");
  }
  for (const [relativePath, expectedEntry] of expected) {
    const actualEntry = actual.get(relativePath);
    if (
      actualEntry === undefined ||
      actualEntry.kind !== expectedEntry.kind ||
      (expectedEntry.kind === "file" &&
        actualEntry.kind === "file" &&
        actualEntry.revision !== expectedEntry.revision)
    ) {
      throw new Error(`release 目录核对失败：${relativePath}`);
    }
  }
}

interface MutableTransactionState {
  releaseDirectory: LocalReleaseTransactionFacts["releaseDirectory"];
  archive: LocalReleaseTransactionFacts["archive"];
  readonly canonicalPaths: Set<string>;
  readonly createdParentPaths: Set<string>;
  readonly ownedPaths: Map<string, string>;
  cleanupComplete: boolean;
  lockDescriptor?: number;
}

function transactionFacts(state: MutableTransactionState): LocalReleaseTransactionFacts {
  const residuePaths = [...state.ownedPaths.entries()]
    .filter(([, path]) => existsSync(path))
    .map(([relativePath]) => relativePath)
    .sort();
  const canonicalPaths = [...state.canonicalPaths].sort();
  const createdParentPaths = [...state.createdParentPaths].sort();
  const changedPaths = [
    ...new Set([...canonicalPaths, ...createdParentPaths, ...residuePaths]),
  ].sort();
  const cleanupComplete = state.cleanupComplete && residuePaths.length === 0;
  return {
    releaseDirectory: state.releaseDirectory,
    archive: state.archive,
    changedPaths,
    canonicalPaths,
    createdParentPaths,
    residuePaths,
    diskChanged: changedPaths.length > 0,
    cleanupComplete,
  };
}

function cleanOwned(
  state: MutableTransactionState,
  dependencies: LocalReleaseCommitDependencies,
  relativePath: string,
): void {
  const path = state.ownedPaths.get(relativePath);
  if (path === undefined || !existsSync(path)) {
    state.ownedPaths.delete(relativePath);
    return;
  }
  try {
    if (dependencies.cleanupOwnedPath !== undefined) {
      dependencies.cleanupOwnedPath(path, relativePath);
    } else {
      rmSync(path, { recursive: true, force: true });
    }
    state.ownedPaths.delete(relativePath);
  } catch {
    state.cleanupComplete = false;
  }
}

function releaseLock(
  state: MutableTransactionState,
  dependencies: LocalReleaseCommitDependencies,
): void {
  if (state.lockDescriptor !== undefined) {
    try {
      closeSync(state.lockDescriptor);
    } catch {
      state.cleanupComplete = false;
    }
    state.lockDescriptor = undefined;
  }
  cleanOwned(state, dependencies, LOCAL_RELEASE_LOCK);
}

function failResult(
  plan: LocalReleasePlan,
  state: MutableTransactionState,
  dependencies: LocalReleaseCommitDependencies,
  phase: Extract<LocalReleaseCommitResult, { status: "failed" }>["phase"],
  error: unknown,
): LocalReleaseCommitResult {
  releaseLock(state, dependencies);
  return {
    status: "failed",
    phase,
    message: error instanceof Error ? error.message : String(error),
    pluginCount: plan.pluginCount,
    facts: transactionFacts(state),
  };
}

function cancelResult(
  plan: LocalReleasePlan,
  state: MutableTransactionState,
  dependencies: LocalReleaseCommitDependencies,
  phase: Extract<LocalReleaseCommitResult, { status: "canceled" }>["phase"],
): LocalReleaseCommitResult {
  releaseLock(state, dependencies);
  return {
    status: "canceled",
    phase,
    message:
      state.archive === "created"
        ? "本地 release 已在最终核对前取消；目录与压缩包已创建，但不声明本次 release 完整成功。"
        : state.releaseDirectory === "committed"
        ? "本地 release 已在安全边界取消；已提交目录保留，压缩包未声明完成。"
        : "本地 release 已在安全边界取消；现有 release 目录保持不变。",
    pluginCount: plan.pluginCount,
    facts: transactionFacts(state),
  };
}

function* localReleaseTransaction(
  plan: LocalReleasePlan,
  dependencies: LocalReleaseCommitDependencies,
): Generator<LocalReleaseBoundary, LocalReleaseCommitResult> {
  const state: MutableTransactionState = {
    releaseDirectory: "unchanged",
    archive: "not-created",
    canonicalPaths: new Set(),
    createdParentPaths: new Set(),
    ownedPaths: new Map(),
    cleanupComplete: true,
  };
  let failurePhase: Extract<
    LocalReleaseCommitResult,
    { status: "failed" }
  >["phase"] = "prepare";
  try {
    const authorization = authorizeExistingDirectory(plan.workspaceDirectory);
    const token = (dependencies.createToken ?? randomUUID)();
    if (!/^[0-9a-f-]{16,80}$/i.test(token)) {
      throw new Error("release transaction token is invalid");
    }
    const stagingRelative = `${RELEASE_TRANSACTION_PREFIX}${token}.staging`;
    const backupRelative = `${RELEASE_TRANSACTION_PREFIX}${token}.backup`;
    const temporaryArchiveRelative = `dist/.${plan.archiveName}.${token}.tmp`;
    const stagingPath = resolveAuthorizedPath(authorization, stagingRelative);
    const backupPath = resolveAuthorizedPath(authorization, backupRelative);
    const lockPath = resolveAuthorizedPath(authorization, LOCAL_RELEASE_LOCK);
    const distPath = resolveAuthorizedPath(authorization, "dist");
    const releasePath = resolveAuthorizedPath(
      authorization,
      plan.releaseDirectoryRelativePath,
    );
    const archivePath = resolveAuthorizedPath(
      authorization,
      plan.archiveRelativePath,
    );
    const temporaryArchivePath = resolveAuthorizedPath(
      authorization,
      temporaryArchiveRelative,
    );
    const abort = () => dependencies.signal?.aborted === true;
    const boundary = (value: LocalReleaseBoundary): LocalReleaseBoundary => {
      dependencies.onBoundary?.(value, transactionFacts(state));
      return value;
    };
    const sourceMatches = () =>
      sameSourceSnapshot(plan) &&
      directoryRevision(plan.workspaceDirectory, LOCAL_RELEASE_DIRECTORY) ===
        plan.existingReleaseRevision;
    const transactionCollision = () =>
      [
        [stagingRelative, stagingPath],
        [backupRelative, backupPath],
        [temporaryArchiveRelative, temporaryArchivePath],
      ].find(([, path]) => existsSync(path));
    if (!sourceMatches()) {
      return failResult(
        plan,
        state,
        dependencies,
        "prepare",
        new Error("release 预览后源内容或现有 release 目录已变化，请重新检查"),
      );
    }
    if (existsSync(archivePath)) {
      return failResult(
        plan,
        state,
        dependencies,
        "prepare",
        new Error(`发布包已存在，不会覆盖: ${plan.archiveName}`),
      );
    }
    const initialCollision = transactionCollision();
    if (initialCollision !== undefined) {
      return failResult(
        plan,
        state,
        dependencies,
        "prepare",
        new Error(`release 事务路径已存在，不会覆盖: ${initialCollision[0]}`),
      );
    }
    if (abort()) return cancelResult(plan, state, dependencies, "prepare");
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      return failResult(
        plan,
        state,
        dependencies,
        "prepare",
        new Error(
          error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST"
            ? "另一个本地 release 正在占用写入锁"
            : `无法建立本地 release 写入锁：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    state.lockDescriptor = descriptor;
    state.ownedPaths.set(LOCAL_RELEASE_LOCK, lockPath);
    writeFileSync(descriptor, `${JSON.stringify({ version: 1, token, processId: process.pid, startedAt: new Date().toISOString() })}\n`);
    fsyncSync(descriptor);
    const lockedCollision = transactionCollision();
    if (!sourceMatches() || existsSync(archivePath) || lockedCollision !== undefined) {
      return failResult(
        plan,
        state,
        dependencies,
        "prepare",
        new Error(
          lockedCollision === undefined
            ? "写入前 release 预览已失效或压缩包名称发生冲突，请重新检查"
            : `写入前 release 事务路径发生冲突，不会覆盖: ${lockedCollision[0]}`,
        ),
      );
    }

    yield boundary("prepare-start");
    if (abort()) return cancelResult(plan, state, dependencies, "prepare");
    try {
      mkdirSync(stagingPath, { mode: 0o755 });
      state.ownedPaths.set(stagingRelative, stagingPath);
      for (const entry of plan.releaseEntries) {
        dependencies.beforeStageEntry?.(entry.releaseRelativePath);
        const target = resolveAuthorizedPath(
          { canonicalPath: stagingPath },
          entry.releaseRelativePath,
        );
        if (entry.kind === "directory") {
          mkdirSync(target, { recursive: true, mode: entry.mode });
        } else {
          mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
          const fileDescriptor = openSync(target, "wx", entry.mode);
          try {
            writeFileSync(fileDescriptor, entry.bytes);
            fsyncSync(fileDescriptor);
          } finally {
            closeSync(fileDescriptor);
          }
        }
      }
    } catch (error) {
      cleanOwned(state, dependencies, stagingRelative);
      return failResult(plan, state, dependencies, "prepare", error);
    }
    yield boundary("prepare-complete");
    if (abort()) {
      cleanOwned(state, dependencies, stagingRelative);
      return cancelResult(plan, state, dependencies, "prepare");
    }
    if (!sourceMatches()) {
      cleanOwned(state, dependencies, stagingRelative);
      return failResult(
        plan,
        state,
        dependencies,
        "prepare",
        new Error("release 暂存期间源内容发生变化；现有 release 目录未替换"),
      );
    }

    failurePhase = "directory-commit";
    yield boundary("directory-commit-start");
    if (abort()) {
      cleanOwned(state, dependencies, stagingRelative);
      return cancelResult(plan, state, dependencies, "directory-commit");
    }
    let backupCreated = false;
    let installed = false;
    try {
      if (!existsSync(distPath)) {
        mkdirSync(distPath, { mode: 0o755 });
        state.createdParentPaths.add("dist");
      }
      if (existsSync(releasePath)) {
        renameSync(releasePath, backupPath);
        backupCreated = true;
        state.ownedPaths.set(backupRelative, backupPath);
      }
      dependencies.beforeInstallReleaseDirectory?.();
      renameSync(stagingPath, releasePath);
      installed = true;
      state.ownedPaths.delete(stagingRelative);
      state.releaseDirectory = "committed";
      state.canonicalPaths.add(plan.releaseDirectoryRelativePath);
      if (backupCreated) cleanOwned(state, dependencies, backupRelative);
      if (state.ownedPaths.has(backupRelative)) {
        return failResult(
          plan,
          state,
          dependencies,
          "directory-commit",
          new Error("新的 release 目录已提交，但旧目录备份未能清理"),
        );
      }
    } catch (error) {
      if (!installed && backupCreated && existsSync(backupPath)) {
        try {
          renameSync(backupPath, releasePath);
          state.ownedPaths.delete(backupRelative);
          backupCreated = false;
        } catch {
          state.releaseDirectory = "uncertain";
          state.canonicalPaths.add(plan.releaseDirectoryRelativePath);
          state.cleanupComplete = false;
        }
      }
      if (!installed) cleanOwned(state, dependencies, stagingRelative);
      if (
        state.createdParentPaths.has("dist") &&
        existsSync(distPath) &&
        !existsSync(releasePath)
      ) {
        try {
          rmdirSync(distPath);
          state.createdParentPaths.delete("dist");
        } catch {
          state.cleanupComplete = false;
        }
      }
      return failResult(plan, state, dependencies, "directory-commit", error);
    }
    yield boundary("directory-commit-complete");

    failurePhase = "archive";
    yield boundary("archive-start");
    if (abort()) return cancelResult(plan, state, dependencies, "archive");
    try {
      assertCommittedReleaseTree(plan, authorization);
    } catch (error) {
      return failResult(plan, state, dependencies, "archive", error);
    }
    if (existsSync(archivePath)) {
      return failResult(
        plan,
        state,
        dependencies,
        "archive",
        new Error(`发布包已存在，不会覆盖: ${plan.archiveName}`),
      );
    }
    state.ownedPaths.set(temporaryArchiveRelative, temporaryArchivePath);
    try {
      (dependencies.archiveExecutor ?? defaultArchiveExecutor)({
        distDirectory: distPath,
        temporaryArchivePath,
      });
    } catch (error) {
      cleanOwned(state, dependencies, temporaryArchiveRelative);
      return failResult(plan, state, dependencies, "archive", error);
    }
    yield boundary("archive-returned");
    if (abort()) {
      cleanOwned(state, dependencies, temporaryArchiveRelative);
      return cancelResult(plan, state, dependencies, "archive");
    }
    try {
      assertCommittedReleaseTree(plan, authorization);
      const tempStat = lstatSync(temporaryArchivePath);
      if (!tempStat.isFile() || tempStat.size === 0) {
        throw new Error("tar 没有创建可用的普通压缩文件");
      }
      if (existsSync(archivePath)) {
        throw new Error(`发布包已存在，不会覆盖: ${plan.archiveName}`);
      }
      dependencies.beforeArchiveCommit?.(plan.archiveRelativePath);
      linkSync(temporaryArchivePath, archivePath);
      state.archive = "created";
      state.canonicalPaths.add(plan.archiveRelativePath);
      cleanOwned(state, dependencies, temporaryArchiveRelative);
    } catch (error) {
      cleanOwned(state, dependencies, temporaryArchiveRelative);
      return failResult(plan, state, dependencies, "archive", error);
    }
    yield boundary("archive-complete");
    if (abort()) return cancelResult(plan, state, dependencies, "verify");

    failurePhase = "verify";
    yield boundary("verify-start");
    if (abort()) return cancelResult(plan, state, dependencies, "verify");
    try {
      assertCommittedReleaseTree(plan, authorization);
      (dependencies.archiveVerifier ?? defaultArchiveVerifier)(
        archivePath,
        plan.releaseEntries
          .map((entry): LocalReleaseExpectedArchiveEntry =>
            entry.kind === "file"
              ? {
                  relativePath: entry.releaseRelativePath,
                  kind: entry.kind,
                  revision: entry.revision,
                  byteLength: entry.bytes.byteLength,
                }
              : {
                  relativePath: entry.releaseRelativePath,
                  kind: entry.kind,
                },
          ),
      );
    } catch (error) {
      return failResult(plan, state, dependencies, "verify", error);
    }
    yield boundary("verify-complete");
    releaseLock(state, dependencies);
    const facts = transactionFacts(state);
    if (!facts.cleanupComplete) {
      return {
        status: "failed",
        phase: "verify",
        message: "本地 release 已创建，但事务痕迹未能完全清理",
        pluginCount: plan.pluginCount,
        facts,
      };
    }
    return {
      status: "success",
      phase: "verify",
      pluginCount: plan.pluginCount,
      facts,
    };
  } catch (error) {
    for (const relativePath of [...state.ownedPaths.keys()]) {
      if (relativePath !== LOCAL_RELEASE_LOCK) {
        cleanOwned(state, dependencies, relativePath);
      }
    }
    return failResult(plan, state, dependencies, failurePhase, error);
  }
}

export function commitLocalReleasePlan(
  plan: LocalReleasePlan,
  dependencies: LocalReleaseCommitDependencies = {},
): LocalReleaseCommitResult {
  const transaction = localReleaseTransaction(plan, dependencies);
  let step = transaction.next();
  while (!step.done) {
    step = transaction.next();
  }
  return step.value;
}

export async function commitLocalReleasePlanAsync(
  plan: LocalReleasePlan,
  dependencies: LocalReleaseCommitDependencies = {},
): Promise<LocalReleaseCommitResult> {
  const yieldToEventLoop =
    dependencies.yieldToEventLoop ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  await yieldToEventLoop();
  const transaction = localReleaseTransaction(plan, dependencies);
  let step = transaction.next();
  while (!step.done) {
    if (
      step.value === "prepare-start" ||
      step.value === "directory-commit-start" ||
      step.value === "archive-start" ||
      step.value === "archive-returned" ||
      step.value === "archive-complete" ||
      step.value === "verify-start"
    ) {
      await yieldToEventLoop();
    }
    step = transaction.next();
  }
  return step.value;
}
