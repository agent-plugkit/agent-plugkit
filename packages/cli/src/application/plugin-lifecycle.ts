import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  AuthorizedPathError,
  authorizeExistingDirectory,
  resolveAuthorizedPath,
  type AuthorizedRoot,
} from '../infrastructure/authorized-path.js';
import { frontmatterString, parseFrontmatter } from '../utils/frontmatter.js';
import { parsePluginYamlSource } from './plugin-source.js';
import type {
  ExecutePluginTransactionResult,
  InspectSkillImportSourceResult,
  ImportedSkillDirectory,
  ImportedSkillFile,
  ImportSkillRequest,
  PlanPluginCreationResult,
  PlanPluginTrashRequest,
  PlanPluginTrashResult,
  PlanSkillImportResult,
  PluginCreationPlan,
  PluginLifecyclePlan,
  PluginLifecycleProblem,
  PluginLifecycleWarning,
  PluginTransactionFailure,
  PluginTransactionHooks,
  PluginTrashComponentFact,
  PluginTrashGeneratedFact,
  PluginTrashPlan,
  PluginWriteSummary,
  SkillImportDerivation,
  SkillImportInspection,
  SkillImportPlan,
  VerifyPluginTrashPlanResult,
} from './plugin-lifecycle-contract.js';
import {
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
} from './plugin-lifecycle-contract.js';
import {
  COMPONENT_TYPES,
  createInitialPluginConfig,
  createPluginScaffold,
  dumpPluginYaml,
  isComponentType,
  isPluginName,
  skillEntry,
  type ComponentType,
  type PluginScaffoldFile,
} from './plugin-scaffold.js';

const MAX_DESCRIPTION = 500;
const SKIP_ENTRIES = new Set(['.DS_Store', '.git', 'node_modules']);
const PLACEHOLDER_DESCRIPTION = 'TODO: 填写插件描述';
const TRANSACTION_LOCK = '.agent-plugkit-plugin-lifecycle.lock';
const STAGING_PREFIX = '.agent-plugkit-plugin-staging-';

interface WorkspaceTarget {
  readonly authorization: AuthorizedRoot;
  readonly pluginsCanonicalPath: string;
  readonly targetRelativePath: string;
  readonly targetCanonicalPath: string;
}

interface ScannedEntry {
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly kind: 'directory' | 'file';
  readonly bytes?: Buffer;
  readonly mode: number;
}

interface SourceScan {
  readonly authorization: AuthorizedRoot;
  readonly entries: readonly ScannedEntry[];
  readonly fileCount: number;
  readonly totalBytes: number;
}

interface LocatedSkillSource {
  readonly selectedRootAuthorization: AuthorizedRoot;
  readonly skillAuthorization: AuthorizedRoot;
}

interface TransactionFile {
  readonly relativePath: string;
  readonly bytes: Buffer;
  readonly mode: number;
  readonly digest: string;
}

interface TransactionDirectory {
  readonly relativePath: string;
  readonly mode: number;
}

interface CreatedTargetFile extends TransactionFile {
  readonly canonicalPath: string;
}

interface DirectoryIdentity {
  readonly canonicalPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

class DirectoryIdentityChangedError extends Error {
  constructor(readonly scope: 'plugins' | 'staging' | 'target') {
    super(`${scope} directory identity changed during plugin transaction`);
    this.name = 'DirectoryIdentityChangedError';
  }
}

function captureDirectoryIdentity(
  path: string,
  scope: DirectoryIdentityChangedError['scope'],
): DirectoryIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DirectoryIdentityChangedError(scope);
  }
  return { canonicalPath: path, dev: stat.dev, ino: stat.ino };
}

function matchesDirectoryIdentity(identity: DirectoryIdentity): boolean {
  try {
    const stat = lstatSync(identity.canonicalPath, { bigint: true });
    return (
      !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino
    );
  } catch {
    return false;
  }
}

function assertDirectoryIdentity(
  identity: DirectoryIdentity,
  scope: DirectoryIdentityChangedError['scope'],
): void {
  if (!matchesDirectoryIdentity(identity)) {
    throw new DirectoryIdentityChangedError(scope);
  }
}

function problem(
  code: PluginLifecycleProblem['code'],
  message: string,
  relativePath?: string,
): PluginLifecycleProblem {
  return {
    code,
    message,
    ...(relativePath === undefined ? {} : { relativePath }),
  };
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function codepointLength(text: string): number {
  return Array.from(text).length;
}

function truncateToCodepoints(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function componentLabels(type: ComponentType): readonly string[] {
  switch (type) {
    case 'skill':
      return ['Skill'];
    case 'mcp':
      return ['Skill', 'MCP'];
    case 'lsp':
      return ['Skill', 'LSP'];
    case 'hook':
      return ['Hook'];
  }
}

function summarizeFiles(
  pluginName: string,
  type: ComponentType,
  files: readonly Pick<TransactionFile, 'relativePath' | 'bytes'>[],
): PluginWriteSummary {
  return {
    pluginName,
    directoryName: pluginName,
    componentType: type,
    componentLabels: componentLabels(type),
    relativePaths: files.map((file) => `plugins/${pluginName}/${file.relativePath}`),
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes.byteLength, 0),
  };
}

function resolveWorkspaceTarget(
  workspaceDirectory: string,
  pluginName: string,
): WorkspaceTarget | PluginLifecycleProblem {
  let authorization: AuthorizedRoot;
  try {
    authorization = authorizeExistingDirectory(workspaceDirectory);
  } catch (error) {
    return problem(
      'WORKSPACE_UNAVAILABLE',
      error instanceof AuthorizedPathError
        ? error.message
        : 'Marketplace 文件夹当前不可访问',
    );
  }

  let pluginsCanonicalPath: string;
  try {
    pluginsCanonicalPath = resolveAuthorizedPath(authorization, 'plugins');
    if (!existsSync(pluginsCanonicalPath) || !lstatSync(pluginsCanonicalPath).isDirectory()) {
      return problem(
        'PLUGINS_DIRECTORY_UNAVAILABLE',
        'Marketplace 的 plugins 文件夹不存在或不可用',
        'plugins',
      );
    }
  } catch (error) {
    return problem(
      'PLUGINS_DIRECTORY_UNAVAILABLE',
      error instanceof AuthorizedPathError
        ? error.message
        : 'Marketplace 的 plugins 文件夹当前不可访问',
      'plugins',
    );
  }

  const targetRelativePath = `plugins/${pluginName}`;
  let targetCanonicalPath: string;
  try {
    targetCanonicalPath = resolveAuthorizedPath(authorization, targetRelativePath);
  } catch (error) {
    return problem(
      'WORKSPACE_UNAVAILABLE',
      error instanceof AuthorizedPathError
        ? error.message
        : '插件目标当前不可访问',
      targetRelativePath,
    );
  }

  if (existsSync(targetCanonicalPath)) {
    return problem(
      'TARGET_CONFLICT',
      `插件目录已存在: plugins/${pluginName}`,
      targetRelativePath,
    );
  }

  return {
    authorization,
    pluginsCanonicalPath,
    targetRelativePath,
    targetCanonicalPath,
  };
}

function invalidName(name: string): PluginLifecycleProblem {
  return problem(
    'INVALID_NAME',
    `插件名 必须使用 kebab-case 小写名称: ${name}`,
  );
}

export function planPluginCreation(
  workspaceDirectory: string,
  name: string,
  type: string,
): PlanPluginCreationResult {
  if (!isPluginName(name)) {
    return { status: 'invalid', problem: invalidName(name) };
  }
  if (!isComponentType(type)) {
    return {
      status: 'invalid',
      problem: problem(
        'INVALID_COMPONENT_TYPE',
        `组件类型非法: ${type}. 可选值: ${COMPONENT_TYPES.join(', ')}`,
      ),
    };
  }

  const target = resolveWorkspaceTarget(workspaceDirectory, name);
  if ('code' in target) {
    return {
      status: target.code === 'TARGET_CONFLICT' ? 'blocked' : 'invalid',
      problem: target,
    };
  }

  const files = createPluginScaffold(name, type);
  const fingerprint = digestJson({
    kind: 'create',
    workspace: target.authorization.canonicalPath,
    target: target.targetRelativePath,
    type,
    files: files.map((file) => ({
      relativePath: file.relativePath,
      mode: file.mode,
      digest: digestBytes(file.bytes),
    })),
  });
  const plan: PluginCreationPlan = {
    kind: 'create',
    request: {
      workspaceDirectory: target.authorization.canonicalPath,
      name,
      type,
    },
    workspaceCanonicalPath: target.authorization.canonicalPath,
    targetRelativePath: target.targetRelativePath,
    targetCanonicalPath: target.targetCanonicalPath,
    fingerprint,
    files,
    summary: summarizeFiles(name, type, files),
  };
  return { status: 'planned', plan };
}

function authorizeSelectedSource(
  sourceDirectory: string,
): AuthorizedRoot | PluginLifecycleProblem {
  let authorization: AuthorizedRoot;
  try {
    authorization = authorizeExistingDirectory(sourceDirectory);
  } catch (error) {
    if (error instanceof AuthorizedPathError) {
      if (error.code === 'PATH_NOT_FOUND') {
        return problem('SOURCE_NOT_FOUND', `源路径不存在: ${resolve(sourceDirectory)}`);
      }
      if (error.code === 'NOT_A_DIRECTORY') {
        return problem(
          'SOURCE_NOT_DIRECTORY',
          `源路径不是目录: ${resolve(sourceDirectory)}. 请指向包含 SKILL.md 的 skill 目录`,
        );
      }
      if (error.code === 'UNSAFE_SYMLINK') {
        return problem(
          'SOURCE_UNSAFE_ENTRY',
          `源目录包含符号链接，导入不支持: ${resolve(sourceDirectory)}`,
        );
      }
      return problem('SOURCE_UNAVAILABLE', `源路径当前不可访问: ${resolve(sourceDirectory)}`);
    }
    return problem('SOURCE_UNAVAILABLE', `源路径当前不可访问: ${resolve(sourceDirectory)}`);
  }

  return authorization;
}

function unsafeSourceEntry(path: string, relativePath?: string): PluginLifecycleProblem {
  return problem(
    'SOURCE_UNSAFE_ENTRY',
    `源目录包含符号链接，导入不支持: ${path}`,
    relativePath,
  );
}

/**
 * Locates one supported Skill using only the selected root and the direct
 * `skills/<name>/SKILL.md` structure. Unrelated wrapper contents are never
 * traversed or cached. Every path segment actually used for selection is
 * lstat-checked before the selected Skill becomes its own authorization root.
 */
function locateSkillSource(
  sourceDirectory: string,
): LocatedSkillSource | PluginLifecycleProblem {
  const selectedRootAuthorization = authorizeSelectedSource(sourceDirectory);
  if ('code' in selectedRootAuthorization) return selectedRootAuthorization;
  const selectedRoot = selectedRootAuthorization.canonicalPath;

  const directSkill = join(selectedRoot, 'SKILL.md');
  if (existsSync(directSkill)) {
    const stat = lstatSync(directSkill);
    if (stat.isSymbolicLink()) return unsafeSourceEntry(directSkill, 'SKILL.md');
    if (!stat.isFile()) {
      return problem(
        'SOURCE_UNSAFE_ENTRY',
        `源目录包含不受支持的非普通文件: ${directSkill}`,
        'SKILL.md',
      );
    }
    return {
      selectedRootAuthorization,
      skillAuthorization: selectedRootAuthorization,
    };
  }

  const skillsRoot = join(selectedRoot, 'skills');
  if (!existsSync(skillsRoot)) {
    return problem(
      'SOURCE_SHAPE_UNSUPPORTED',
      `源目录中未找到 SKILL.md: ${selectedRoot}. 支持的源形态: 含 SKILL.md 的 skill 目录，或含 skills/ 的插件目录`,
    );
  }
  const skillsRootStat = lstatSync(skillsRoot);
  if (skillsRootStat.isSymbolicLink()) return unsafeSourceEntry(skillsRoot, 'skills');
  if (!skillsRootStat.isDirectory()) {
    return problem(
      'SOURCE_SHAPE_UNSUPPORTED',
      `源插件目录的 skills/ 下没有 skill: ${selectedRoot}`,
    );
  }

  const candidates: string[] = [];
  for (const child of readdirSync(skillsRoot, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const childPath = join(skillsRoot, child.name);
    const childRelative = `skills/${child.name}`;
    const childStat = lstatSync(childPath);
    if (childStat.isSymbolicLink()) {
      return unsafeSourceEntry(childPath, childRelative);
    }
    if (!childStat.isDirectory()) continue;
    const skillMdPath = join(childPath, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;
    const skillMdStat = lstatSync(skillMdPath);
    if (skillMdStat.isSymbolicLink()) {
      return unsafeSourceEntry(skillMdPath, `${childRelative}/SKILL.md`);
    }
    if (!skillMdStat.isFile()) {
      return problem(
        'SOURCE_UNSAFE_ENTRY',
        `源目录包含不受支持的非普通文件: ${skillMdPath}`,
        `${childRelative}/SKILL.md`,
      );
    }
    candidates.push(child.name);
  }

  if (candidates.length === 0) {
    return problem(
      'SOURCE_SHAPE_UNSUPPORTED',
      `源插件目录的 skills/ 下没有 skill: ${selectedRoot}`,
    );
  }
  if (candidates.length > 1) {
    return problem(
      'SOURCE_MULTIPLE_SKILLS',
      `源插件目录包含多个 skill: ${candidates.join(', ')}. 请直接指向具体的 skill 子目录`,
    );
  }
  const skillPath = join(skillsRoot, candidates[0] as string);
  try {
    return {
      selectedRootAuthorization,
      skillAuthorization: authorizeExistingDirectory(skillPath),
    };
  } catch {
    return problem(
      'SOURCE_CHANGED',
      `源 Skill 在检查期间发生变化: skills/${candidates[0]}`,
    );
  }
}

function sourceLimitProblem(fileCount: number, totalBytes: number): PluginLifecycleProblem {
  const mb = (totalBytes / (1024 * 1024)).toFixed(1);
  const maxMb = SKILL_IMPORT_MAX_BYTES / (1024 * 1024);
  return problem(
    'SOURCE_LIMIT_EXCEEDED',
    `源目录过大: ${fileCount} 个文件 / ${mb} MB，超过上限 ${SKILL_IMPORT_MAX_FILES} 个文件 / ${maxMb} MB. 请指向更精确的 skill 目录`,
  );
}

/** Scans only the selected Skill tree; skipped entries preserve the CLI contract. */
function scanSkillSource(
  authorization: AuthorizedRoot,
): SourceScan | PluginLifecycleProblem {

  const entries: ScannedEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (current: string): PluginLifecycleProblem | undefined => {
    let children;
    try {
      children = readdirSync(current, { withFileTypes: true });
    } catch {
      return problem('SOURCE_UNAVAILABLE', `源目录当前不可读取: ${current}`);
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      // Compatibility boundary: these entries have never been imported or
      // counted. They are skipped before lstat/traversal, even when huge.
      if (SKIP_ENTRIES.has(child.name)) continue;
      const childPath = join(current, child.name);
      const childRelative = toPosixPath(relative(authorization.canonicalPath, childPath));
      let stat;
      try {
        stat = lstatSync(childPath);
      } catch {
        return problem('SOURCE_CHANGED', `源内容在检查期间发生变化: ${childRelative}`, childRelative);
      }
      if (stat.isSymbolicLink()) {
        return problem(
          'SOURCE_UNSAFE_ENTRY',
          `源目录包含符号链接，导入不支持: ${childPath}`,
          childRelative,
        );
      }
      if (stat.isDirectory()) {
        entries.push({
          canonicalPath: childPath,
          relativePath: childRelative,
          kind: 'directory',
          mode: stat.mode & 0o777,
        });
        const nestedProblem = walk(childPath);
        if (nestedProblem !== undefined) return nestedProblem;
        continue;
      }
      if (!stat.isFile()) {
        return problem(
          'SOURCE_UNSAFE_ENTRY',
          `源目录包含不受支持的非普通文件: ${childPath}`,
          childRelative,
        );
      }
      const nextFileCount = fileCount + 1;
      const statTotalBytes = totalBytes + stat.size;
      if (
        nextFileCount > SKILL_IMPORT_MAX_FILES ||
        statTotalBytes > SKILL_IMPORT_MAX_BYTES
      ) {
        return sourceLimitProblem(nextFileCount, statTotalBytes);
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(childPath);
      } catch {
        return problem('SOURCE_CHANGED', `源文件在检查期间发生变化: ${childRelative}`, childRelative);
      }
      const after = lstatSync(childPath);
      if (!after.isFile() || after.size !== bytes.byteLength || after.mtimeMs !== stat.mtimeMs) {
        return problem('SOURCE_CHANGED', `源文件在检查期间发生变化: ${childRelative}`, childRelative);
      }
      const exactTotalBytes = totalBytes + bytes.byteLength;
      if (nextFileCount > SKILL_IMPORT_MAX_FILES || exactTotalBytes > SKILL_IMPORT_MAX_BYTES) {
        return sourceLimitProblem(nextFileCount, exactTotalBytes);
      }
      fileCount = nextFileCount;
      totalBytes = exactTotalBytes;
      entries.push({
        canonicalPath: childPath,
        relativePath: childRelative,
        kind: 'file',
        bytes,
        mode: stat.mode & 0o777,
      });
    }
    return undefined;
  };

  const scanProblem = walk(authorization.canonicalPath);
  return scanProblem ?? { authorization, entries, fileCount, totalBytes };
}

function parseSourceFrontmatter(
  skillMd: ImportedSkillFile,
):
  | {
      readonly name?: string;
      readonly description?: string;
      readonly argumentHint?: string;
      readonly warnings: readonly PluginLifecycleWarning[];
    }
  | PluginLifecycleProblem {
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(skillMd.bytes);
  } catch {
    return problem(
      'SOURCE_INVALID_FRONTMATTER',
      `SKILL.md 不是有效的 UTF-8 文本: ${skillMd.sourceCanonicalPath}`,
      'SKILL.md',
    );
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) {
    switch (parsed.failure.kind) {
      case 'unterminated':
        return problem(
          'SOURCE_INVALID_FRONTMATTER',
          `SKILL.md frontmatter 未正确闭合: ${skillMd.sourceCanonicalPath}. 缺少结束的 --- 分隔符`,
          'SKILL.md',
        );
      case 'invalid-yaml':
        return problem(
          'SOURCE_INVALID_FRONTMATTER',
          `SKILL.md frontmatter 解析失败: ${skillMd.sourceCanonicalPath}: ${parsed.failure.message}`,
          'SKILL.md',
        );
      case 'not-object':
        return problem(
          'SOURCE_INVALID_FRONTMATTER',
          `SKILL.md frontmatter 不是对象: ${skillMd.sourceCanonicalPath}`,
          'SKILL.md',
        );
    }
  }
  return {
    name: frontmatterString(parsed.data, 'name'),
    description: frontmatterString(parsed.data, 'description'),
    argumentHint: frontmatterString(parsed.data, 'argument-hint'),
    warnings: parsed.present
      ? []
      : [
          {
            code: 'MISSING_FRONTMATTER',
            message: '源 SKILL.md 缺少 frontmatter，将按目录名推导插件名',
          },
        ],
  };
}

function validateImportOverrides(
  request: Pick<ImportSkillRequest, 'name' | 'description' | 'author'>,
):
  | {
      readonly description?: string;
      readonly author?: string;
    }
  | PluginLifecycleProblem {
  if (request.name !== undefined && !isPluginName(request.name)) {
    return invalidName(request.name);
  }
  let description: string | undefined;
  if (request.description !== undefined) {
    description = request.description.trim();
    if (description.length === 0) {
      return problem('INVALID_DESCRIPTION', '--description 不能为空');
    }
    const length = codepointLength(description);
    if (length > MAX_DESCRIPTION) {
      return problem(
        'INVALID_DESCRIPTION',
        `--description 超过 ${MAX_DESCRIPTION} 个字符: ${length}`,
      );
    }
  }
  let author: string | undefined;
  if (request.author !== undefined) {
    author = request.author.trim();
    if (author.length === 0) {
      return problem('INVALID_AUTHOR', '--author 不能为空');
    }
  }
  return { description, author };
}

function importedFilesForSkill(scan: SourceScan): readonly ImportedSkillFile[] {
  return scan.entries
    .filter(
      (entry): entry is ScannedEntry & { readonly kind: 'file'; readonly bytes: Buffer } =>
        entry.kind === 'file',
    )
    .map((entry) => {
      return {
        sourceCanonicalPath: entry.canonicalPath,
        relativePath: entry.relativePath,
        bytes: entry.bytes,
        mode: entry.mode,
        digest: digestBytes(entry.bytes),
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function importedDirectoriesForSkill(
  scan: SourceScan,
): readonly ImportedSkillDirectory[] {
  return scan.entries
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => ({
      relativePath: entry.relativePath,
      mode: entry.mode,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

type SkillImportOverrides = Pick<
  ImportSkillRequest,
  'name' | 'description' | 'author'
>;

function deriveSkillImport(
  inspection: Omit<SkillImportInspection, 'suggestion'>,
  request: SkillImportOverrides,
): SkillImportDerivation | PluginLifecycleProblem {
  const overrides = validateImportOverrides(request);
  if ('code' in overrides) return overrides;
  const warnings: PluginLifecycleWarning[] = [
    ...inspection.frontmatter.warnings,
  ];
  const rawName =
    request.name ??
    inspection.frontmatter.name ??
    inspection.sourceSkillDirectoryName;
  const pluginName = request.name ?? normalizeName(rawName);
  if (pluginName.length === 0) {
    return problem(
      'INVALID_NAME',
      `无法从源推导插件名: ${rawName}. 请显式传入 [name] 参数`,
    );
  }
  if (!isPluginName(pluginName)) return invalidName(pluginName);
  if (request.name === undefined && pluginName !== rawName) {
    warnings.push({
      code: 'NORMALIZED_NAME',
      message: `插件名已规范化: ${rawName} → ${pluginName}`,
    });
  }
  if (
    inspection.frontmatter.name !== undefined &&
    inspection.frontmatter.name !== pluginName
  ) {
    warnings.push({
      code: 'CANONICAL_NAME_DIFFERENCE',
      message: `SKILL.md frontmatter 中的 name (${inspection.frontmatter.name}) 与插件名 (${pluginName}) 不一致，导入不会改写 SKILL.md`,
    });
  }

  let description: string;
  if (overrides.description !== undefined) {
    description = overrides.description;
  } else if (inspection.frontmatter.description !== undefined) {
    const normalized = normalizeWhitespace(inspection.frontmatter.description);
    if (codepointLength(normalized) > MAX_DESCRIPTION) {
      description = truncateToCodepoints(normalized, MAX_DESCRIPTION);
      warnings.push({
        code: 'TRUNCATED_DESCRIPTION',
        message: '描述超过 500 字符，已截断写入 plugin.yaml；SKILL.md 原文未改动',
      });
    } else {
      description = normalized;
    }
  } else {
    description = PLACEHOLDER_DESCRIPTION;
    warnings.push({
      code: 'MISSING_DESCRIPTION',
      message: '源 SKILL.md 缺少 description，已写入占位描述',
    });
  }

  const canonicalName = inspection.frontmatter.name;
  return {
    sourceDisplayName: inspection.sourceDisplayName,
    sourceSkillDirectoryName: inspection.sourceSkillDirectoryName,
    directoryName: pluginName,
    ...(canonicalName === undefined ? {} : { canonicalName }),
    ...(canonicalName !== undefined && canonicalName !== pluginName
      ? {
          nameRepairIssue: {
            state: 'needs-review' as const,
            summary: `目录名 (${pluginName}) 与 SKILL.md name (${canonicalName}) 不一致`,
            nextAction:
              '导入会保留两者；请稍后审阅名称差异，不会自动重命名目录或改写 SKILL.md。',
          },
        }
      : {}),
    ...(canonicalName === undefined ? {} : { frontmatterName: canonicalName }),
    ...(inspection.frontmatter.description === undefined
      ? {}
      : { frontmatterDescription: inspection.frontmatter.description }),
    ...(inspection.frontmatter.argumentHint === undefined
      ? {}
      : { argumentHint: inspection.frontmatter.argumentHint }),
    pluginName,
    description,
    ...(overrides.author === undefined ? {} : { author: overrides.author }),
    warnings,
    budget: {
      fileCount: inspection.importedFiles.length,
      totalBytes: inspection.importedFiles.reduce(
        (total, file) => total + file.bytes.byteLength,
        0,
      ),
      maxFiles: SKILL_IMPORT_MAX_FILES,
      maxBytes: SKILL_IMPORT_MAX_BYTES,
    },
  };
}

export function inspectSkillImportSource(
  sourceDirectory: string,
): InspectSkillImportSourceResult {
  const located = locateSkillSource(sourceDirectory);
  if ('code' in located) return { status: 'invalid', problem: located };
  const source = scanSkillSource(located.skillAuthorization);
  if ('code' in source) return { status: 'invalid', problem: source };
  const importedDirectories = importedDirectoriesForSkill(source);
  const importedFiles = importedFilesForSkill(source);
  const skillMd = importedFiles.find((file) => file.relativePath === 'SKILL.md');
  if (skillMd === undefined) {
    return {
      status: 'invalid',
      problem: problem(
        'SOURCE_SHAPE_UNSUPPORTED',
        `源目录中未找到 SKILL.md: ${source.authorization.canonicalPath}`,
      ),
    };
  }
  const frontmatter = parseSourceFrontmatter(skillMd);
  if ('code' in frontmatter) return { status: 'invalid', problem: frontmatter };
  const fingerprint = digestJson({
    sourceRoot: located.selectedRootAuthorization.canonicalPath,
    sourceSkill: source.authorization.canonicalPath,
    files: importedFiles.map(({ relativePath, mode, digest }) => ({
      relativePath,
      mode,
      digest,
    })),
    directories: importedDirectories.map(({ relativePath, mode }) => ({
      relativePath,
      mode,
    })),
  });
  const base: Omit<SkillImportInspection, 'suggestion'> = {
    sourceRootCanonicalPath: located.selectedRootAuthorization.canonicalPath,
    sourceSkillCanonicalPath: source.authorization.canonicalPath,
    fingerprint,
    importedDirectories,
    importedFiles,
    sourceDisplayName: basename(located.selectedRootAuthorization.canonicalPath),
    sourceSkillDirectoryName: basename(source.authorization.canonicalPath),
    frontmatter,
  };
  const suggestion = deriveSkillImport(base, {});
  if ('code' in suggestion) return { status: 'invalid', problem: suggestion };
  return {
    status: 'inspected',
    inspection: { ...base, suggestion },
  };
}

export function planSkillImportFromInspection(
  request: ImportSkillRequest,
  inspection: SkillImportInspection,
): PlanSkillImportResult {
  const selectedSource = authorizeSelectedSource(request.sourceDirectory);
  if ('code' in selectedSource) return { status: 'invalid', problem: selectedSource };
  if (selectedSource.canonicalPath !== inspection.sourceRootCanonicalPath) {
    return {
      status: 'invalid',
      problem: problem(
        'SOURCE_CHANGED',
        '导入源已改变；请重新选择本地 Skill',
      ),
    };
  }
  const derivation = deriveSkillImport(inspection, request);
  if ('code' in derivation) return { status: 'invalid', problem: derivation };
  const pluginName = derivation.pluginName;
  const target = resolveWorkspaceTarget(request.workspaceDirectory, pluginName);
  if ('code' in target) {
    return {
      status: target.code === 'TARGET_CONFLICT' ? 'blocked' : 'invalid',
      problem: target,
    };
  }

  const config = createInitialPluginConfig(pluginName, 'skill');
  config.description = derivation.description;
  if (derivation.author !== undefined) config.author.name = derivation.author;
  config.components.skills = [
    skillEntry(
      pluginName,
      derivation.description,
      inspection.frontmatter.argumentHint,
    ),
  ];
  const pluginFile: PluginScaffoldFile = {
    relativePath: 'plugin.yaml',
    bytes: Buffer.from(dumpPluginYaml(config), 'utf8'),
    mode: 0o644,
  };
  const destinationFiles: TransactionFile[] = [
    { ...pluginFile, digest: digestBytes(pluginFile.bytes) },
    ...inspection.importedFiles.map((file) => ({
      relativePath: `skills/${pluginName}/${file.relativePath}`,
      bytes: file.bytes,
      mode: file.mode,
      digest: file.digest,
    })),
  ];
  const normalizedRequest: ImportSkillRequest = {
    workspaceDirectory: target.authorization.canonicalPath,
    sourceDirectory: inspection.sourceRootCanonicalPath,
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.description === undefined
      ? {}
      : { description: derivation.description }),
    ...(derivation.author === undefined ? {} : { author: derivation.author }),
  };
  const fingerprint = digestJson({
    kind: 'import-skill',
    sourceFingerprint: inspection.fingerprint,
    workspace: target.authorization.canonicalPath,
    target: target.targetRelativePath,
    request: normalizedRequest,
    files: destinationFiles.map(({ relativePath, mode, digest }) => ({
      relativePath,
      mode,
      digest,
    })),
    directories: inspection.importedDirectories.map(({ relativePath, mode }) => ({
      relativePath,
      mode,
    })),
  });
  const fileSummary = summarizeFiles(pluginName, 'skill', destinationFiles);
  const summary: PluginWriteSummary = {
    ...fileSummary,
    relativePaths: [
      ...fileSummary.relativePaths,
      ...inspection.importedDirectories.map(
        (directory) =>
          `plugins/${pluginName}/skills/${pluginName}/${directory.relativePath}`,
      ),
    ].sort(),
  };
  const plan: SkillImportPlan = {
    kind: 'import-skill',
    request: normalizedRequest,
    workspaceCanonicalPath: target.authorization.canonicalPath,
    sourceRootCanonicalPath: inspection.sourceRootCanonicalPath,
    sourceSkillCanonicalPath: inspection.sourceSkillCanonicalPath,
    targetRelativePath: target.targetRelativePath,
    targetCanonicalPath: target.targetCanonicalPath,
    fingerprint,
    importedDirectories: inspection.importedDirectories,
    importedFiles: inspection.importedFiles,
    pluginFile,
    derivation,
    summary,
  };
  return { status: 'planned', plan };
}

export function planSkillImport(
  request: ImportSkillRequest,
): PlanSkillImportResult {
  const inspected = inspectSkillImportSource(request.sourceDirectory);
  if (inspected.status === 'invalid') return inspected;
  return planSkillImportFromInspection(request, inspected.inspection);
}

interface TrashScanEntry {
  readonly relativePath: string;
  readonly kind: 'directory' | 'file' | 'symlink' | 'other';
  readonly mode: number;
  readonly size: number;
  readonly digest?: string;
  readonly linkTarget?: string;
}

interface TrashScan {
  readonly entries: readonly TrashScanEntry[];
  readonly regularFileCount: number;
  readonly totalRegularFileBytes: number;
}

function isSafePluginDirectoryName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

function hashRegularFile(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(path, 'r');
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function scanPluginTrashTarget(
  targetCanonicalPath: string,
): TrashScan | PluginLifecycleProblem {
  let targetIdentity: DirectoryIdentity;
  try {
    targetIdentity = captureDirectoryIdentity(targetCanonicalPath, 'target');
  } catch {
    return problem('PLUGIN_CHANGED', '插件目录在预览期间发生变化');
  }
  const entries: TrashScanEntry[] = [];
  let regularFileCount = 0;
  let totalRegularFileBytes = 0;

  const walk = (
    current: string,
    parentRelative: string,
  ): PluginLifecycleProblem | undefined => {
    try {
      assertDirectoryIdentity(targetIdentity, 'target');
    } catch {
      return problem('PLUGIN_CHANGED', '插件目录在预览期间发生变化');
    }
    let children;
    try {
      children = readdirSync(current, { withFileTypes: true });
    } catch {
      return problem('PLUGIN_CHANGED', '插件内容当前不可读取');
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      try {
        assertDirectoryIdentity(targetIdentity, 'target');
      } catch {
        return problem('PLUGIN_CHANGED', '插件目录在预览期间发生变化');
      }
      const childPath = join(current, child.name);
      const childRelative =
        parentRelative.length === 0
          ? child.name
          : `${parentRelative}/${child.name}`;
      let stat;
      try {
        stat = lstatSync(childPath);
      } catch {
        return problem('PLUGIN_CHANGED', `插件内容发生变化: ${childRelative}`);
      }
      if (stat.isSymbolicLink()) {
        let linkTarget: string;
        try {
          linkTarget = readlinkSync(childPath);
        } catch {
          return problem('PLUGIN_CHANGED', `插件内容发生变化: ${childRelative}`);
        }
        entries.push({
          relativePath: childRelative,
          kind: 'symlink',
          mode: stat.mode & 0o777,
          size: stat.size,
          linkTarget,
        });
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({
          relativePath: childRelative,
          kind: 'directory',
          mode: stat.mode & 0o777,
          size: 0,
        });
        const issue = walk(childPath, childRelative);
        if (issue !== undefined) return issue;
        continue;
      }
      if (stat.isFile()) {
        let digest: string;
        try {
          digest = hashRegularFile(childPath);
          const after = lstatSync(childPath);
          if (
            !after.isFile() ||
            after.isSymbolicLink() ||
            after.dev !== stat.dev ||
            after.ino !== stat.ino ||
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs
          ) {
            return problem('PLUGIN_CHANGED', `插件内容发生变化: ${childRelative}`);
          }
        } catch {
          return problem('PLUGIN_CHANGED', `插件内容发生变化: ${childRelative}`);
        }
        regularFileCount += 1;
        totalRegularFileBytes += stat.size;
        entries.push({
          relativePath: childRelative,
          kind: 'file',
          mode: stat.mode & 0o777,
          size: stat.size,
          digest,
        });
        continue;
      }
      entries.push({
        relativePath: childRelative,
        kind: 'other',
        mode: stat.mode & 0o777,
        size: stat.size,
      });
    }
    return undefined;
  };

  const issue = walk(targetCanonicalPath, '');
  if (issue !== undefined) return issue;
  try {
    assertDirectoryIdentity(targetIdentity, 'target');
  } catch {
    return problem('PLUGIN_CHANGED', '插件目录在预览期间发生变化');
  }
  return { entries, regularFileCount, totalRegularFileBytes };
}

function trashComponents(
  pluginYamlPath: string,
  scan: TrashScan,
): {
  readonly canonicalName?: string;
  readonly components: readonly PluginTrashComponentFact[];
} {
  const pluginYaml = scan.entries.find(
    (entry) => entry.kind === 'file' && entry.relativePath === 'plugin.yaml',
  );
  if (pluginYaml === undefined || pluginYaml.size > 5 * 1024 * 1024) {
    return { components: [] };
  }
  try {
    const bytes = readFileSync(pluginYamlPath);
    if (digestBytes(bytes) !== pluginYaml.digest) return { components: [] };
    const parsed = parsePluginYamlSource(bytes.toString('utf8'));
    if (parsed.status !== 'valid') return { components: [] };
    const components: PluginTrashComponentFact[] = [
      ...(parsed.value.components.skills ?? []).map((entry) => ({
        kind: 'Skill' as const,
        name: entry.name,
      })),
      ...(parsed.value.components.mcp ?? []).map((entry) => ({
        kind: 'MCP' as const,
        name: entry.name,
      })),
      ...(parsed.value.components.hooks ?? []).map((entry) => ({
        kind: 'Hook' as const,
        name: `${entry.event}${entry.pattern ? ` · ${entry.pattern}` : ''}`,
      })),
      ...(parsed.value.components.lsp ?? []).map((entry) => ({
        kind: 'LSP' as const,
        name: entry.name,
      })),
    ];
    return { canonicalName: parsed.value.name, components };
  } catch {
    return { components: [] };
  }
}

const PLUGIN_GENERATED_SCOPE = [
  { label: 'Claude Code manifest', relativePath: '.claude-plugin' },
  { label: 'Codex manifest', relativePath: '.codex-plugin' },
  { label: 'MCP config', relativePath: '.mcp.json' },
  { label: 'LSP config', relativePath: '.lsp.json' },
  { label: 'Hook config', relativePath: 'hooks/hooks.json' },
] as const;

function trashGeneratedFacts(scan: TrashScan): readonly PluginTrashGeneratedFact[] {
  return PLUGIN_GENERATED_SCOPE.filter(({ relativePath }) =>
    scan.entries.some(
      (entry) =>
        entry.relativePath === relativePath ||
        entry.relativePath.startsWith(`${relativePath}/`),
    ),
  );
}

export function planPluginTrash(
  request: PlanPluginTrashRequest,
): PlanPluginTrashResult {
  if (!isSafePluginDirectoryName(request.directoryName)) {
    return {
      status: 'invalid',
      problem: problem('INVALID_NAME', '插件目录标识无效'),
    };
  }
  let workspaceAuthorization: AuthorizedRoot;
  let targetCanonicalPath: string;
  try {
    workspaceAuthorization = authorizeExistingDirectory(request.workspaceDirectory);
    const pluginsPath = resolveAuthorizedPath(workspaceAuthorization, 'plugins');
    const pluginsAuthorization = authorizeExistingDirectory(pluginsPath);
    targetCanonicalPath = resolveAuthorizedPath(
      pluginsAuthorization,
      request.directoryName,
    );
    if (!existsSync(targetCanonicalPath)) {
      return {
        status: 'invalid',
        problem: problem(
          'PLUGIN_NOT_FOUND',
          `插件目录不存在: plugins/${request.directoryName}`,
          `plugins/${request.directoryName}`,
        ),
      };
    }
    const stat = lstatSync(targetCanonicalPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        status: 'invalid',
        problem: problem('PLUGIN_CHANGED', '插件对象不是可安全移动的目录'),
      };
    }
  } catch (error) {
    return {
      status: 'invalid',
      problem: problem(
        'WORKSPACE_UNAVAILABLE',
        error instanceof AuthorizedPathError
          ? error.message
          : 'Marketplace 文件夹当前不可访问',
      ),
    };
  }

  const scan = scanPluginTrashTarget(targetCanonicalPath);
  if ('code' in scan) return { status: 'invalid', problem: scan };
  const identity = trashComponents(join(targetCanonicalPath, 'plugin.yaml'), scan);
  const hasDifference =
    identity.canonicalName !== undefined &&
    identity.canonicalName !== request.directoryName;
  const sortedPaths = scan.entries
    .map((entry) => `plugins/${request.directoryName}/${entry.relativePath}`)
    .sort();
  const visiblePaths = sortedPaths.slice(0, 200);
  const fingerprint = digestJson({
    workspace: workspaceAuthorization.canonicalPath,
    directoryName: request.directoryName,
    entries: scan.entries.map((entry) => ({
      relativePath: entry.relativePath,
      kind: entry.kind,
      mode: entry.mode,
      size: entry.size,
      digest: entry.digest,
      linkTarget: entry.linkTarget,
    })),
  });
  const plan: PluginTrashPlan = {
    kind: 'trash-plugin',
    request: {
      workspaceDirectory: workspaceAuthorization.canonicalPath,
      directoryName: request.directoryName,
    },
    workspaceCanonicalPath: workspaceAuthorization.canonicalPath,
    targetRelativePath: `plugins/${request.directoryName}`,
    targetCanonicalPath,
    fingerprint,
    plugin: {
      directoryName: request.directoryName,
      ...(identity.canonicalName === undefined
        ? {}
        : { canonicalName: identity.canonicalName }),
      displayName: identity.canonicalName ?? request.directoryName,
      hasCanonicalDirectoryDifference: hasDifference,
      ...(hasDifference
        ? {
            nameRepairIssue: {
              state: 'needs-review' as const,
              summary: `目录名 (${request.directoryName}) 与 plugin.yaml name (${identity.canonicalName}) 不一致`,
              nextAction:
                '移到废纸篓不会自动重命名目录或改写 plugin.yaml；取消后可先审阅此差异。',
            },
          }
        : {}),
    },
    components: identity.components,
    generated: trashGeneratedFacts(scan),
    scope: {
      entryCount: scan.entries.length,
      regularFileCount: scan.regularFileCount,
      totalRegularFileBytes: scan.totalRegularFileBytes,
      relativePaths: visiblePaths,
      additionalEntryCount: sortedPaths.length - visiblePaths.length,
    },
    workspaceGeneratedNotice: {
      status: 'not-moved-becomes-stale',
      labels: ['Marketplace index', 'CATALOG'],
      message:
        'Marketplace 级 index 与 CATALOG 不会在本次操作中修改；移除成功后它们会显示为待重新生成。',
    },
  };
  return { status: 'planned', plan };
}

export function verifyPluginTrashPlan(
  plan: PluginTrashPlan,
): VerifyPluginTrashPlanResult {
  const current = planPluginTrash(plan.request);
  if (current.status !== 'planned') {
    return { status: 'invalid', problem: current.problem };
  }
  if (current.plan.fingerprint !== plan.fingerprint) {
    return {
      status: 'stale',
      problem: problem(
        'PLUGIN_CHANGED',
        '插件内容在预览后发生变化；请重新预览影响范围',
      ),
    };
  }
  return { status: 'verified', plan: current.plan };
}

function transactionFiles(plan: PluginLifecyclePlan): readonly TransactionFile[] {
  if (plan.kind === 'create') {
    return plan.files.map((file) => ({
      relativePath: file.relativePath,
      bytes: file.bytes,
      mode: file.mode,
      digest: digestBytes(file.bytes),
    }));
  }
  return [
    {
      relativePath: plan.pluginFile.relativePath,
      bytes: plan.pluginFile.bytes,
      mode: plan.pluginFile.mode,
      digest: digestBytes(plan.pluginFile.bytes),
    },
    ...plan.importedFiles.map((file) => ({
      relativePath: `skills/${plan.derivation.pluginName}/${file.relativePath}`,
      bytes: file.bytes,
      mode: file.mode,
      digest: file.digest,
    })),
  ];
}

function transactionDirectories(
  plan: PluginLifecyclePlan,
): readonly TransactionDirectory[] {
  if (plan.kind === 'create') return [];
  return plan.importedDirectories.map((directory) => ({
    relativePath: `skills/${plan.derivation.pluginName}/${directory.relativePath}`,
    mode: directory.mode,
  }));
}

function byPathDepthThenName<T extends { readonly relativePath: string }>(
  left: T,
  right: T,
): number {
  const depth = left.relativePath.split('/').length - right.relativePath.split('/').length;
  return depth === 0
    ? left.relativePath.localeCompare(right.relativePath)
    : depth;
}

function replan(plan: PluginLifecyclePlan): PlanPluginCreationResult | PlanSkillImportResult {
  return plan.kind === 'create'
    ? planPluginCreation(
        plan.request.workspaceDirectory,
        plan.request.name,
        plan.request.type,
      )
    : planSkillImport(plan.request);
}

function failure(
  status: PluginTransactionFailure['status'],
  issue: PluginLifecycleProblem,
  changedPaths: readonly string[] = [],
  rollbackComplete = true,
  cleanupComplete = true,
): PluginTransactionFailure {
  return {
    status,
    problem: issue,
    changedPaths,
    rollbackComplete,
    cleanupComplete,
  };
}

function relativeChangedPath(plan: PluginLifecyclePlan, child = ''): string {
  return child.length === 0
    ? plan.targetRelativePath
    : `${plan.targetRelativePath}/${child}`;
}

function ensureParentDirectories(
  targetAuthorization: AuthorizedRoot,
  relativePath: string,
  createdDirectories: string[],
  createdDirectorySet: Set<string>,
  assertRoots: () => void,
): void {
  const parent = dirname(relativePath);
  if (parent === '.' || parent.length === 0) return;
  const segments = parent.split(sep);
  let cursor = '';
  for (const segment of segments) {
    cursor = cursor.length === 0 ? segment : join(cursor, segment);
    if (createdDirectorySet.has(cursor)) continue;
    assertRoots();
    const candidate = resolveAuthorizedPath(targetAuthorization, cursor);
    assertRoots();
    mkdirSync(candidate, { mode: 0o755 });
    createdDirectorySet.add(cursor);
    createdDirectories.push(candidate);
  }
}

function safeDigest(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return digestBytes(readFileSync(path));
  } catch {
    return undefined;
  }
}

function removeOwnedLock(
  lockPath: string,
  token: string,
  pluginsIdentity: DirectoryIdentity,
): boolean {
  try {
    assertDirectoryIdentity(pluginsIdentity, 'plugins');
    if (!existsSync(lockPath)) return true;
    assertDirectoryIdentity(pluginsIdentity, 'plugins');
    if (readFileSync(lockPath, 'utf8') !== token) return false;
    assertDirectoryIdentity(pluginsIdentity, 'plugins');
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function cleanupOwnedStaging(
  stagingIdentity: DirectoryIdentity | undefined,
  pluginsIdentity: DirectoryIdentity,
): boolean {
  if (stagingIdentity === undefined) return true;
  try {
    assertDirectoryIdentity(pluginsIdentity, 'plugins');
    assertDirectoryIdentity(stagingIdentity, 'staging');
    rmSync(stagingIdentity.canonicalPath, { recursive: true, force: true });
    assertDirectoryIdentity(pluginsIdentity, 'plugins');
    return !existsSync(stagingIdentity.canonicalPath);
  } catch {
    return false;
  }
}

export function executePluginTransaction(
  plan: PluginLifecyclePlan,
  hooks: PluginTransactionHooks = {},
): ExecutePluginTransactionResult {
  const files = transactionFiles(plan);
  const directories = [...transactionDirectories(plan)].sort(byPathDepthThenName);
  const token = randomUUID();
  const pluginsRelative = 'plugins';
  let workspaceAuthorization: AuthorizedRoot;
  let pluginsPath: string;
  let pluginsAuthorization: AuthorizedRoot;
  let pluginsIdentity: DirectoryIdentity;
  try {
    workspaceAuthorization = authorizeExistingDirectory(plan.workspaceCanonicalPath);
    pluginsPath = resolveAuthorizedPath(workspaceAuthorization, pluginsRelative);
    if (!lstatSync(pluginsPath).isDirectory()) {
      return failure(
        'failed',
        problem('PLUGINS_DIRECTORY_UNAVAILABLE', 'Marketplace 的 plugins 文件夹当前不可用'),
      );
    }
    pluginsAuthorization = authorizeExistingDirectory(pluginsPath);
    pluginsIdentity = captureDirectoryIdentity(pluginsPath, 'plugins');
  } catch (error) {
    return failure(
      'failed',
      problem(
        'WORKSPACE_UNAVAILABLE',
        error instanceof Error ? error.message : 'Marketplace 文件夹当前不可用',
      ),
    );
  }

  const targetLeaf = plan.targetRelativePath.slice(`${pluginsRelative}/`.length);
  if (
    targetLeaf.length === 0 ||
    targetLeaf.includes('/') ||
    targetLeaf.includes('\\')
  ) {
    return failure(
      'failed',
      problem('PLAN_STALE', '插件目标不再符合已授权的目录范围'),
    );
  }
  const targetPath = resolveAuthorizedPath(pluginsAuthorization, targetLeaf);
  if (targetPath !== plan.targetCanonicalPath) {
    return failure(
      'stale',
      problem('PLAN_STALE', '插件目标在预览后发生变化；请重新预览'),
    );
  }

  const lockPath = resolveAuthorizedPath(pluginsAuthorization, TRANSACTION_LOCK);
  let lockOwned = false;
  try {
    assertDirectoryIdentity(pluginsIdentity, 'plugins');
    const fd = openSync(lockPath, 'wx', 0o600);
    try {
      writeFileSync(fd, token, 'utf8');
    } finally {
      closeSync(fd);
    }
    lockOwned = true;
    assertDirectoryIdentity(pluginsIdentity, 'plugins');
  } catch {
    return failure(
      'blocked',
      problem(
        'TRANSACTION_BUSY',
        '另一个插件创建或导入操作正在提交；请稍后重试',
      ),
    );
  }

  let stagingRoot: string | undefined;
  let stagingIdentity: DirectoryIdentity | undefined;
  let stagingAuthorization: AuthorizedRoot | undefined;
  let targetRootCreated = false;
  let targetIdentity: DirectoryIdentity | undefined;
  let targetAuthorization: AuthorizedRoot | undefined;
  const createdFiles: CreatedTargetFile[] = [];
  const createdDirectories: string[] = [];
  const createdDirectorySet = new Set<string>();
  const changedPaths = new Set<string>();

  const finishCleanup = (): boolean => {
    const stagingClean = cleanupOwnedStaging(stagingIdentity, pluginsIdentity);
    const lockClean =
      !lockOwned || removeOwnedLock(lockPath, token, pluginsIdentity);
    if (lockClean) lockOwned = false;
    return stagingClean && lockClean;
  };

  const assertPluginRoot = (): void => {
    assertDirectoryIdentity(pluginsIdentity, 'plugins');
  };

  const assertStagingRoots = (): void => {
    assertPluginRoot();
    if (stagingIdentity === undefined) {
      throw new DirectoryIdentityChangedError('staging');
    }
    assertDirectoryIdentity(stagingIdentity, 'staging');
  };

  const assertTargetRoots = (): void => {
    assertPluginRoot();
    if (targetIdentity === undefined) {
      throw new DirectoryIdentityChangedError('target');
    }
    assertDirectoryIdentity(targetIdentity, 'target');
  };

  const rollback = (): { rollbackComplete: boolean; changed: readonly string[] } => {
    let rollbackComplete = true;
    for (const file of [...createdFiles].reverse()) {
      try {
        assertTargetRoots();
      } catch {
        rollbackComplete = false;
        break;
      }
      if (safeDigest(file.canonicalPath) !== file.digest) {
        rollbackComplete = false;
        continue;
      }
      try {
        unlinkSync(file.canonicalPath);
        changedPaths.delete(relativeChangedPath(plan, file.relativePath));
      } catch {
        rollbackComplete = false;
      }
    }
    for (const directory of [...createdDirectories].reverse()) {
      try {
        assertTargetRoots();
        rmdirSync(directory);
        changedPaths.delete(
          relativeChangedPath(
            plan,
            toPosixPath(relative(plan.targetCanonicalPath, directory)),
          ),
        );
      } catch {
        // A non-empty directory may contain externally added content. It is
        // deliberately left in place rather than recursively removed.
        rollbackComplete = false;
      }
    }
    if (targetRootCreated) {
      try {
        assertTargetRoots();
        rmdirSync(targetPath);
        changedPaths.delete(plan.targetRelativePath);
      } catch {
        // Only an empty root created by this transaction may be removed.
        rollbackComplete = false;
      }
    }
    return { rollbackComplete, changed: [...changedPaths].sort() };
  };

  try {
    const beforeStage = replan(plan);
    if (beforeStage.status !== 'planned') {
      const cleanupComplete = finishCleanup();
      return failure(
        beforeStage.status === 'blocked' ? 'blocked' : 'stale',
        beforeStage.problem,
        [],
        true,
        cleanupComplete,
      );
    }
    if (beforeStage.plan.fingerprint !== plan.fingerprint) {
      const cleanupComplete = finishCleanup();
      return failure(
        'stale',
        problem('PLAN_STALE', '创建或导入预览已过期；请重新检查后再确认'),
        [],
        true,
        cleanupComplete,
      );
    }

    assertPluginRoot();
    stagingRoot = resolveAuthorizedPath(
      pluginsAuthorization,
      `${STAGING_PREFIX}${token}`,
    );
    assertPluginRoot();
    mkdirSync(stagingRoot, { mode: 0o700 });
    stagingIdentity = captureDirectoryIdentity(stagingRoot, 'staging');
    stagingAuthorization = authorizeExistingDirectory(stagingRoot);
    for (const directory of directories) {
      assertStagingRoots();
      const stagedDirectory = resolveAuthorizedPath(
        stagingAuthorization,
        directory.relativePath,
      );
      assertStagingRoots();
      mkdirSync(stagedDirectory, { recursive: true, mode: directory.mode });
      assertStagingRoots();
      chmodSync(stagedDirectory, directory.mode);
    }
    for (const file of files) {
      assertStagingRoots();
      const stagedPath = resolveAuthorizedPath(stagingAuthorization, file.relativePath);
      assertStagingRoots();
      mkdirSync(dirname(stagedPath), { recursive: true, mode: 0o700 });
      assertStagingRoots();
      writeFileSync(stagedPath, file.bytes, { flag: 'wx', mode: file.mode });
      assertStagingRoots();
      if (safeDigest(stagedPath) !== file.digest) {
        throw new Error(`staging byte verification failed: ${file.relativePath}`);
      }
    }

    hooks.afterStaging?.(plan);

    // Import sources and target absence are checked again after the complete
    // staging tree exists and immediately before target reservation.
    const beforeCommit = replan(plan);
    if (
      beforeCommit.status !== 'planned' ||
      beforeCommit.plan.fingerprint !== plan.fingerprint
    ) {
      const cleanupComplete = finishCleanup();
      const issue =
        beforeCommit.status === 'planned'
          ? problem('SOURCE_CHANGED', '导入源或目标在预览后发生变化；请重新预览')
          : beforeCommit.problem;
      return failure(
        beforeCommit.status === 'blocked' ? 'blocked' : 'stale',
        issue,
        [],
        true,
        cleanupComplete,
      );
    }

    hooks.beforeTargetReservation?.(plan);
    assertPluginRoot();
    mkdirSync(targetPath, { mode: 0o755 });
    targetRootCreated = true;
    changedPaths.add(plan.targetRelativePath);
    targetIdentity = captureDirectoryIdentity(targetPath, 'target');
    targetAuthorization = authorizeExistingDirectory(targetPath);

    for (const directory of directories) {
      ensureParentDirectories(
        targetAuthorization,
        directory.relativePath,
        createdDirectories,
        createdDirectorySet,
        assertTargetRoots,
      );
      if (createdDirectorySet.has(directory.relativePath)) {
        assertTargetRoots();
        chmodSync(
          resolveAuthorizedPath(targetAuthorization, directory.relativePath),
          directory.mode,
        );
        continue;
      }
      assertTargetRoots();
      const targetDirectory = resolveAuthorizedPath(
        targetAuthorization,
        directory.relativePath,
      );
      assertTargetRoots();
      mkdirSync(targetDirectory, { mode: directory.mode });
      createdDirectorySet.add(directory.relativePath);
      createdDirectories.push(targetDirectory);
      changedPaths.add(relativeChangedPath(plan, directory.relativePath));
    }

    for (const file of files) {
      ensureParentDirectories(
        targetAuthorization,
        file.relativePath,
        createdDirectories,
        createdDirectorySet,
        assertTargetRoots,
      );
      assertStagingRoots();
      const stagedPath = resolveAuthorizedPath(
        stagingAuthorization,
        file.relativePath,
      );
      assertTargetRoots();
      const targetPath = resolveAuthorizedPath(targetAuthorization, file.relativePath);
      assertStagingRoots();
      assertTargetRoots();
      copyFileSync(stagedPath, targetPath, fsConstants.COPYFILE_EXCL);
      createdFiles.push({ ...file, canonicalPath: targetPath });
      changedPaths.add(relativeChangedPath(plan, file.relativePath));
      assertTargetRoots();
      chmodSync(targetPath, file.mode);
      assertTargetRoots();
      if (safeDigest(targetPath) !== file.digest) {
        throw new Error(`target byte verification failed: ${file.relativePath}`);
      }
      hooks.afterTargetFileCreated?.(file.relativePath, createdFiles.length);
      assertTargetRoots();
    }

    assertTargetRoots();
    const cleanupComplete = finishCleanup();
    if (!cleanupComplete) {
      return failure(
        'failed',
        problem(
          'TRANSACTION_FAILED',
          '插件已写入，但事务临时痕迹未能完全清理',
        ),
        [...changedPaths].sort(),
        false,
        false,
      );
    }
    return {
      status: 'created',
      pluginName: plan.summary.pluginName,
      written: files
        .map((file) => relativeChangedPath(plan, file.relativePath))
        .concat(
          directories.map((directory) =>
            relativeChangedPath(plan, directory.relativePath),
          ),
        )
        .sort(),
      cleanupComplete: true,
    };
  } catch (error) {
    const rolledBack = rollback();
    const cleanupComplete = finishCleanup();
    const identityChanged = error instanceof DirectoryIdentityChangedError;
    let targetConflict = false;
    if (!targetRootCreated && !identityChanged) {
      try {
        assertPluginRoot();
        targetConflict = existsSync(targetPath);
      } catch {
        targetConflict = false;
      }
    }
    return failure(
      identityChanged ? 'stale' : targetConflict ? 'blocked' : 'failed',
      identityChanged
        ? problem(
            'PLAN_STALE',
            '插件目录身份在提交期间发生变化；已停止操作，请重新检查 workspace',
          )
        : targetConflict
        ? problem(
            'TARGET_CONFLICT',
            `插件目录已存在: ${plan.targetRelativePath}`,
            plan.targetRelativePath,
          )
        : problem(
            'TRANSACTION_FAILED',
            error instanceof Error ? error.message : '插件事务提交失败',
          ),
      rolledBack.changed,
      rolledBack.rollbackComplete,
      cleanupComplete,
    );
  } finally {
    if (lockOwned) removeOwnedLock(lockPath, token, pluginsIdentity);
  }
}
