import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  PLUGKIT_MAINTAIN_SKILL,
  PLUGKIT_PLUGIN_YAML,
  PLUGKIT_SETUP_SKILL,
} from '../generated/skill-content.js';
import {
  AuthorizedPathError,
  authorizeExistingDirectory,
  resolveAuthorizedPath,
  type AuthorizedRoot,
} from '../infrastructure/authorized-path.js';
import type {
  CreateWorkspaceRequest,
  ExecuteWorkspaceCreationResult,
  WorkspaceCreationChange,
  WorkspaceCreationConflict,
  WorkspaceCreationPlan,
} from './workspace-create-contract.js';

const CLI_PACKAGE = 'agent-plugkit';
const CLI_RUNNER = `npx ${CLI_PACKAGE}`;

const DEFAULT_SCRIPTS: Readonly<Record<string, string>> = {
  mp: CLI_RUNNER,
  'validate:plugins': `${CLI_RUNNER} validate --all`,
  'build:plugins': `${CLI_RUNNER} build --all`,
  'build:index': `${CLI_RUNNER} index`,
  'build:all': 'npm run build:plugins && npm run build:index',
  'ci:local': 'npm run build:all && npm run validate:plugins',
  'release:local': `npm run ci:local && ${CLI_RUNNER} release-local`,
};

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

interface DesiredFile {
  readonly relativePath: string;
  readonly content: string;
  readonly action: 'create' | 'update';
  readonly expectedState: string;
}

interface PlannedInternals {
  readonly authorization?: AuthorizedRoot;
  readonly desiredFiles: readonly DesiredFile[];
  readonly createPluginsDirectory: boolean;
  readonly plan: WorkspaceCreationPlan;
}

export interface WorkspaceCreationDependencies {
  readonly beforeApplyChange?: (
    relativePath: string,
    appliedCount: number,
  ) => void;
  readonly cleanupStaging?: (stagingRoot: string) => void;
}

function marketplaceYaml(name: string, organization: string): string {
  const title = toTitleCase(name);
  return `# Marketplace 元数据

name: ${yamlScalar(name)}
description: ${yamlScalar(`${title} 插件市场`)}
organization: ${yamlScalar(organization)}

categories:
  - id: tooling
    label: "工具"
    description: "开发工具和脚手架"
  - id: integration
    label: "集成"
    description: "第三方服务连接器"
  - id: quality
    label: "质量"
    description: "质量检查和审查工作流"
  - id: workflow
    label: "工作流"
    description: "自动化工作流"
  - id: general
    label: "通用"
    description: "其他插件"

platforms:
  - name: "Agent Plugins"
    manifest: "plugin.json"
  - name: "Claude Code"
    manifest: ".claude-plugin/plugin.json"
  - name: "Codex"
    manifest: ".codex-plugin/plugin.json"
`;
}

function yamlScalar(value: string): string {
  // JSON strings are valid YAML scalars and make line breaks, quotes and colons inert.
  return JSON.stringify(value);
}

function toTitleCase(kebab: string): string {
  return kebab
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function defaultReadme(name: string): string {
  return `# ${toTitleCase(name)}

这是一个由 \`${CLI_PACKAGE}\` 维护的 AI agent plugin marketplace 仓库。

\`plugin.yaml\` 是单一事实源；\`build\` 生成 Agent Plugins 1.0 portable 文件及 Claude Code / Codex 原生产物，\`index\` 生成 Copilot/VS Code、Cursor、Claude Code 与 Codex 的客户端索引。

## 常用流程

\`\`\`bash
npx ${CLI_PACKAGE} init my-plugin
npx ${CLI_PACKAGE} add skill plugkit audit
npx ${CLI_PACKAGE} validate --all
npx ${CLI_PACKAGE} build --all
npx ${CLI_PACKAGE} index
\`\`\`

\`release-local\` 只创建本地发布目录与压缩包，不会执行 Git push、远端 marketplace 注册或客户端安装。
`;
}

function parsePackageJsonContent(raw: string): PackageJson {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('package.json 必须包含 JSON 对象');
  }
  return parsed as PackageJson;
}

function packageContent(
  root: AuthorizedRoot,
  name: string,
): {
  readonly content: string;
  readonly action: 'create' | 'update';
  readonly changed: boolean;
  readonly expectedState: string;
} {
  const path = resolveAuthorizedPath(root, 'package.json');
  const exists = existsSync(path);
  const raw = exists ? readFileSync(path, 'utf8') : undefined;
  const existing: PackageJson =
    raw === undefined
      ? { name, version: '1.0.0', private: true }
      : parsePackageJsonContent(raw);
  if (
    existing.scripts !== undefined &&
    (existing.scripts === null ||
      typeof existing.scripts !== 'object' ||
      Array.isArray(existing.scripts))
  ) {
    throw new Error('package.json 的 scripts 必须是 JSON 对象');
  }
  const existingScripts = existing.scripts ?? {};
  const scripts = { ...existingScripts };
  let changed = !exists;
  for (const [scriptName, command] of Object.entries(DEFAULT_SCRIPTS)) {
    if (!(scriptName in scripts)) {
      scripts[scriptName] = command;
      changed = true;
    }
  }
  const next = { ...existing, scripts };
  return {
    content: `${JSON.stringify(next, null, 2)}\n`,
    action: exists ? 'update' : 'create',
    changed,
    expectedState:
      raw === undefined
        ? 'missing'
        : `file:${createHash('sha256').update(raw).digest('hex')}`,
  };
}

function fileState(root: AuthorizedRoot, relativePath: string): string {
  const path = resolveAuthorizedPath(root, relativePath);
  if (!existsSync(path)) return 'missing';
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new AuthorizedPathError(
      'UNSAFE_SYMLINK',
      '创建目标不能使用符号链接',
      relativePath,
    );
  }
  if (!stat.isFile()) return `non-file:${stat.mode}`;
  return `file:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function assertExistingParentsAreDirectories(
  root: AuthorizedRoot,
  relativePath: string,
): void {
  const parent = dirname(relativePath);
  if (parent === '.') return;
  let cursor = '';
  for (const segment of parent.split('/')) {
    cursor = cursor ? `${cursor}/${segment}` : segment;
    const path = resolveAuthorizedPath(root, cursor);
    if (!existsSync(path)) return;
    if (!lstatSync(path).isDirectory()) {
      throw new AuthorizedPathError(
        'UNSAFE_SYMLINK',
        `${cursor} 必须是文件夹`,
        cursor,
      );
    }
  }
}

function assertAuthorizedRootAvailable(root: AuthorizedRoot): void {
  const current = authorizeExistingDirectory(root.canonicalPath);
  if (current.canonicalPath !== root.canonicalPath) {
    throw new AuthorizedPathError(
      'PATH_UNAVAILABLE',
      '目标文件夹的授权位置已经变化',
      root.canonicalPath,
    );
  }
}

function fingerprint(
  request: CreateWorkspaceRequest,
  root: AuthorizedRoot,
  paths: readonly string[],
): string {
  assertAuthorizedRootAvailable(root);
  const states = paths
    .map((path) => `${path}:${fileState(root, path)}`)
    .sort()
    .join('\n');
  return createHash('sha256')
    .update(
      JSON.stringify({
        root: root.canonicalPath,
        name: request.name,
        organization: request.organization,
        includePlugkit: request.includePlugkit,
      }),
    )
    .update('\n')
    .update(states)
    .digest('hex');
}

function conflictFromError(error: unknown): WorkspaceCreationConflict {
  if (error instanceof AuthorizedPathError) {
    const unavailableCodes = new Set([
      'EMPTY_PATH',
      'PATH_NOT_FOUND',
      'PATH_UNAVAILABLE',
      'NOT_A_DIRECTORY',
    ]);
    return {
      code: unavailableCodes.has(error.code)
        ? 'PATH_UNAVAILABLE'
        : 'UNSAFE_PATH',
      title: unavailableCodes.has(error.code)
        ? '目标位置当前不可用'
        : '目标位置不安全',
      message: error.message,
      relativePath: error.path,
    };
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EIO']).has(error.code)
  ) {
    return {
      code: 'PATH_UNAVAILABLE',
      title: '目标位置当前不可用',
      message: '目标文件夹在检查期间发生变化或当前无法访问。',
    };
  }
  return {
    code: 'INVALID_PACKAGE_JSON',
    title: '无法保留现有 package.json',
    message: error instanceof Error ? error.message : String(error),
    relativePath: 'package.json',
  };
}

function blockedPlanInternals(
  request: CreateWorkspaceRequest,
  error: unknown,
): PlannedInternals {
  const conflict = conflictFromError(error);
  const targetPath = resolve(request.directory);
  return {
    desiredFiles: [],
    createPluginsDirectory: false,
    plan: {
      status: 'blocked',
      targetPath,
      marketplaceName: request.name,
      organization: request.organization,
      includePlugkit: request.includePlugkit,
      changes: [],
      conflicts: [conflict],
      preservationNote:
        '目标文件夹不可用，因此没有读取、创建或修改任何内容。',
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            directory: targetPath,
            name: request.name,
            organization: request.organization,
            includePlugkit: request.includePlugkit,
            blocked: conflict.code,
          }),
        )
        .digest('hex'),
    },
  };
}

function planInternalsUnsafe(request: CreateWorkspaceRequest): PlannedInternals {
  let authorization: AuthorizedRoot;
  try {
    authorization = authorizeExistingDirectory(request.directory);
  } catch (error) {
    return blockedPlanInternals(request, error);
  }

  const changes: WorkspaceCreationChange[] = [];
  const conflicts: WorkspaceCreationConflict[] = [];
  const desiredFiles: DesiredFile[] = [];
  let createPluginsDirectory = false;
  const trackedPaths = [
    'marketplace.yaml',
    'package.json',
    'README.md',
    'plugins',
  ];
  if (request.includePlugkit) {
    trackedPaths.push(
      'plugins/plugkit/plugin.yaml',
      'plugins/plugkit/skills/setup/SKILL.md',
      'plugins/plugkit/skills/maintain/SKILL.md',
    );
  }

  try {
    assertAuthorizedRootAvailable(authorization);
    const pluginsPath = resolveAuthorizedPath(authorization, 'plugins');
    if (existsSync(pluginsPath)) {
      const pluginsStat = lstatSync(pluginsPath);
      if (!pluginsStat.isDirectory()) {
        throw new AuthorizedPathError(
          'UNSAFE_SYMLINK',
          'plugins 必须是文件夹',
          'plugins',
        );
      }
      changes.push({
        relativePath: 'plugins',
        action: 'preserve',
        summary: '保留现有插件目录与其中的全部内容',
      });
    } else {
      createPluginsDirectory = true;
      changes.push({
        relativePath: 'plugins',
        action: 'create',
        summary: '创建插件目录',
      });
    }

    const marketplacePath = resolveAuthorizedPath(authorization, 'marketplace.yaml');
    if (existsSync(marketplacePath)) {
      fileState(authorization, 'marketplace.yaml');
      conflicts.push({
        code: 'MARKETPLACE_EXISTS',
        title: '这个文件夹已经是 Marketplace',
        message: 'marketplace.yaml 已存在；为避免覆盖，创建已停止。',
        relativePath: 'marketplace.yaml',
      });
      changes.push({
        relativePath: 'marketplace.yaml',
        action: 'preserve',
        summary: '保留已有 Marketplace 配置，不覆盖',
      });
    } else {
      desiredFiles.push({
        relativePath: 'marketplace.yaml',
        content: marketplaceYaml(request.name, request.organization),
        action: 'create',
        expectedState: 'missing',
      });
      changes.push({
        relativePath: 'marketplace.yaml',
        action: 'create',
        summary: '创建插件集合的主配置',
      });
    }

    const packagePlan = packageContent(authorization, request.name);
    if (packagePlan.changed) {
      desiredFiles.push({
        relativePath: 'package.json',
        content: packagePlan.content,
        action: packagePlan.action,
        expectedState: packagePlan.expectedState,
      });
      changes.push({
        relativePath: 'package.json',
        action: packagePlan.action,
        summary:
          packagePlan.action === 'create'
            ? '创建本地维护脚本'
            : '只补充缺失的维护脚本，保留现有键和值',
      });
    } else {
      changes.push({
        relativePath: 'package.json',
        action: 'preserve',
        summary: '现有维护脚本完整，保持原样',
      });
    }

    const readmePath = resolveAuthorizedPath(authorization, 'README.md');
    if (existsSync(readmePath)) {
      fileState(authorization, 'README.md');
      changes.push({
        relativePath: 'README.md',
        action: 'preserve',
        summary: '保留现有说明文档',
      });
    } else {
      desiredFiles.push({
        relativePath: 'README.md',
        content: defaultReadme(request.name),
        action: 'create',
        expectedState: 'missing',
      });
      changes.push({
        relativePath: 'README.md',
        action: 'create',
        summary: '创建本地使用说明',
      });
    }

    if (request.includePlugkit) {
      const plugkitFiles = [
        ['plugins/plugkit/plugin.yaml', PLUGKIT_PLUGIN_YAML, '插件维护入口'],
        [
          'plugins/plugkit/skills/setup/SKILL.md',
          PLUGKIT_SETUP_SKILL,
          '安装与设置指引',
        ],
        [
          'plugins/plugkit/skills/maintain/SKILL.md',
          PLUGKIT_MAINTAIN_SKILL,
          '日常维护指引',
        ],
      ] as const;
      for (const [relativePath, content, summary] of plugkitFiles) {
        assertExistingParentsAreDirectories(authorization, relativePath);
        const path = resolveAuthorizedPath(authorization, relativePath);
        if (existsSync(path)) {
          const state = fileState(authorization, relativePath);
          if (!state.startsWith('file:')) {
            throw new AuthorizedPathError(
              'UNSAFE_SYMLINK',
              `${relativePath} 必须是文件`,
              relativePath,
            );
          }
          changes.push({
            relativePath,
            action: 'preserve',
            summary: `保留已有${summary}`,
          });
        } else {
          desiredFiles.push({
            relativePath,
            content,
            action: 'create',
            expectedState: 'missing',
          });
          changes.push({ relativePath, action: 'create', summary });
        }
      }
    }
  } catch (error) {
    conflicts.push(conflictFromError(error));
  }

  let comparisonToken: string;
  try {
    comparisonToken = fingerprint(request, authorization, trackedPaths);
  } catch (error) {
    conflicts.push(conflictFromError(error));
    comparisonToken = createHash('sha256')
      .update(`${authorization.canonicalPath}:blocked`)
      .digest('hex');
  }

  const uniqueConflicts = conflicts.filter(
    (conflict, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.code === conflict.code &&
          candidate.relativePath === conflict.relativePath &&
          candidate.message === conflict.message,
      ) === index,
  );

  return {
    authorization,
    desiredFiles,
    createPluginsDirectory,
    plan: {
      status: uniqueConflicts.length === 0 ? 'ready' : 'blocked',
      targetPath: authorization.canonicalPath,
      marketplaceName: request.name,
      organization: request.organization,
      includePlugkit: request.includePlugkit,
      changes,
      conflicts: uniqueConflicts,
      preservationNote:
        '未列出的文件与文件夹保持原样；现有 README 和 plugkit 文件不会被覆盖。',
      fingerprint: comparisonToken,
    },
  };
}

function planInternals(request: CreateWorkspaceRequest): PlannedInternals {
  try {
    return planInternalsUnsafe(request);
  } catch (error) {
    return blockedPlanInternals(request, error);
  }
}

function ensureParentDirectories(
  root: AuthorizedRoot,
  relativePath: string,
  createdDirectories: string[],
): void {
  const parent = dirname(relativePath);
  if (parent === '.') return;
  let cursor = '';
  for (const segment of parent.split('/')) {
    cursor = cursor ? `${cursor}/${segment}` : segment;
    const path = resolveAuthorizedPath(root, cursor);
    if (!existsSync(path)) {
      mkdirSync(path);
      createdDirectories.push(path);
    } else if (!lstatSync(path).isDirectory()) {
      throw new Error(`${cursor} 不是文件夹`);
    }
  }
}

function restoreTransaction(
  createdFiles: readonly string[],
  backups: readonly { readonly target: string; readonly backup: string }[],
  createdDirectories: readonly string[],
): boolean {
  let complete = true;
  for (const path of [...createdFiles].reverse()) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      complete = false;
    }
  }
  for (const { target, backup } of [...backups].reverse()) {
    try {
      if (existsSync(target)) unlinkSync(target);
      renameSync(backup, target);
    } catch {
      complete = false;
    }
  }
  for (const path of [...createdDirectories].reverse()) {
    try {
      rmdirSync(path);
    } catch {
      complete = false;
    }
  }
  return complete;
}

class StaleWorkspaceCreationError extends Error {
  constructor() {
    super('目标文件夹在预览后发生了变化；请重新检查再创建。');
    this.name = 'StaleWorkspaceCreationError';
  }
}

export function planWorkspaceCreation(
  request: CreateWorkspaceRequest,
): WorkspaceCreationPlan {
  return planInternals(request).plan;
}

export function executeWorkspaceCreation(
  request: CreateWorkspaceRequest,
  expectedFingerprint: string,
  dependencies: WorkspaceCreationDependencies = {},
): ExecuteWorkspaceCreationResult {
  const current = planInternals(request);
  if (current.plan.status === 'blocked') {
    return { status: 'blocked', conflicts: current.plan.conflicts };
  }
  if (current.authorization === undefined) {
    return {
      status: 'blocked',
      conflicts: [
        {
          code: 'PATH_UNAVAILABLE',
          title: '目标位置当前不可用',
          message: '目标文件夹无法获得有效授权。',
        },
      ],
    };
  }
  const authorization = current.authorization;
  if (current.plan.fingerprint !== expectedFingerprint) {
    return {
      status: 'stale',
      message: '目标文件夹在预览后发生了变化；请重新检查再创建。',
    };
  }

  let stagingRoot: string;
  try {
    stagingRoot = mkdtempSync(
      join(authorization.canonicalPath, '.agent-plugkit-staging-'),
    );
  } catch (error) {
    return {
      status: 'failed',
      message:
        error instanceof Error
          ? `无法准备安全写入：${error.message}`
          : '无法准备安全写入',
      changedPaths: [],
      rollbackComplete: true,
    };
  }

  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  const backups: Array<{ target: string; backup: string }> = [];
  let outcome:
    | Extract<ExecuteWorkspaceCreationResult, { status: 'created' }>
    | Extract<ExecuteWorkspaceCreationResult, { status: 'stale' }>
    | Extract<ExecuteWorkspaceCreationResult, { status: 'failed' }>;
  try {
    if (current.createPluginsDirectory) {
      const pluginsPath = resolveAuthorizedPath(
        authorization,
        'plugins',
      );
      mkdirSync(pluginsPath);
      createdDirectories.push(pluginsPath);
    }

    for (const desired of current.desiredFiles) {
      const staged = join(stagingRoot, desired.relativePath);
      mkdirSync(dirname(staged), { recursive: true });
      writeFileSync(staged, desired.content);
    }

    for (const [index, desired] of current.desiredFiles.entries()) {
      dependencies.beforeApplyChange?.(desired.relativePath, index);
      if (
        fileState(authorization, desired.relativePath) !==
        desired.expectedState
      ) {
        throw new StaleWorkspaceCreationError();
      }
      const target = resolveAuthorizedPath(
        authorization,
        desired.relativePath,
      );
      ensureParentDirectories(
        authorization,
        desired.relativePath,
        createdDirectories,
      );
      const staged = join(stagingRoot, desired.relativePath);
      if (desired.action === 'create') {
        try {
          linkSync(staged, target);
          createdFiles.push(target);
          unlinkSync(staged);
        } catch (error) {
          if (
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'EEXIST'
          ) {
            throw new StaleWorkspaceCreationError();
          }
          throw error;
        }
      } else {
        const backup = join(stagingRoot, '.backup', desired.relativePath);
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(target, backup, constants.COPYFILE_EXCL);
        if (
          fileState(authorization, desired.relativePath) !==
          desired.expectedState
        ) {
          throw new StaleWorkspaceCreationError();
        }
        renameSync(staged, target);
        backups.push({ target, backup });
      }
    }

    const written = [
      ...(current.createPluginsDirectory ? ['plugins'] : []),
      ...current.desiredFiles.map((file) => file.relativePath),
    ];
    const preserved = current.plan.changes
      .filter((change) => change.action === 'preserve')
      .map((change) => change.relativePath);
    outcome = {
      status: 'created',
      targetPath: authorization.canonicalPath,
      written,
      preserved,
    };
  } catch (error) {
    const rollbackComplete = restoreTransaction(
      createdFiles,
      backups,
      createdDirectories,
    );
    const possiblyChangedPaths = [
      ...createdFiles,
      ...backups.map(({ target }) => target),
      ...createdDirectories,
    ]
      .map((path) => relative(authorization.canonicalPath, path))
      .filter((path, index, all) => all.indexOf(path) === index);
    outcome =
      error instanceof StaleWorkspaceCreationError && rollbackComplete
        ? {
            status: 'stale',
            message: error.message,
          }
        : {
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
            changedPaths: rollbackComplete ? [] : possiblyChangedPaths,
            rollbackComplete,
          };
  }

  try {
    (dependencies.cleanupStaging ??
      ((path: string) => rmSync(path, { recursive: true, force: true })))(
      stagingRoot,
    );
  } catch (error) {
    const stagingPath = relative(
      authorization.canonicalPath,
      stagingRoot,
    );
    if (outcome.status === 'created') {
      return {
        status: 'failed',
        message:
          'Marketplace 已写入，但安全写入的临时目录未能清理；请勿重复创建。',
        changedPaths: [...outcome.written, stagingPath],
        rollbackComplete: false,
      };
    }
    if (outcome.status === 'stale') {
      return {
        status: 'failed',
        message: `${outcome.message}；临时目录清理也未完成：${
          error instanceof Error ? error.message : String(error)
        }`,
        changedPaths: [stagingPath],
        rollbackComplete: false,
      };
    }
    return {
      ...outcome,
      message: `${outcome.message}；临时目录清理也未完成：${
        error instanceof Error ? error.message : String(error)
      }`,
      changedPaths: outcome.changedPaths.includes(stagingPath)
        ? outcome.changedPaths
        : [...outcome.changedPaths, stagingPath],
      rollbackComplete: false,
    };
  }

  return outcome;
}

export function normalizeWorkspaceCreationRequest(
  directory: string,
  name: string | undefined,
  organization: string | undefined,
  includePlugkit: boolean,
): CreateWorkspaceRequest {
  const marketplaceName = name?.trim() || basename(directory);
  return {
    directory,
    name: marketplaceName,
    organization: organization?.trim() || toTitleCase(marketplaceName),
    includePlugkit,
  };
}
