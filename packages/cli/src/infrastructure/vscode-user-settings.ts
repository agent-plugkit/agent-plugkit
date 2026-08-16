import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import {
  applyEdits,
  createScanner,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  SyntaxKind,
  type FormattingOptions,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import type { ProcessRunner } from './process-runner.js';

export interface VscodeSettingsInspectionReady {
  readonly status: 'ready';
  readonly settingsPath: string;
}

export interface VscodeSettingsInspectionUnavailable {
  readonly status: 'unavailable';
  readonly message: string;
}

export interface VscodeSettingsInspectionInterrupted {
  readonly status: 'interrupted';
  readonly signal: NodeJS.Signals;
}

export type VscodeSettingsInspection =
  | VscodeSettingsInspectionReady
  | VscodeSettingsInspectionUnavailable
  | VscodeSettingsInspectionInterrupted;

export interface InspectVscodeUserSettingsOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly signal?: AbortSignal;
}

export interface VscodeSettingsUpdateRequest {
  readonly settingsPath: string;
  readonly source: string;
}

export type VscodeSettingsUpdateResult =
  | {
      readonly status: 'completed';
      readonly changed: boolean;
      readonly settingsPath: string;
    }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly settingsPath: string;
    };

export interface VscodeSettingsUpdateDependencies {
  readonly beforeRevisionCheck?: () => void;
  readonly beforeRecoveryRename?: () => void;
  readonly rename?: typeof renameSync;
}

interface MissingSnapshot {
  readonly kind: 'missing';
}

interface FileSnapshot {
  readonly kind: 'file';
  readonly bytes: Buffer;
  readonly revision: string;
  readonly mode: number;
}

type FileSnapshotState = MissingSnapshot | FileSnapshot;

class VscodeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VscodeSettingsError';
  }
}

const MANAGED_SETTINGS_KEYS = new Set([
  'chat.plugins.enabled',
  'chat.plugins.marketplaces',
]);
const PATH_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function fileRevision(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8Losslessly(bytes: Buffer): string {
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
    throw new VscodeSettingsError(
      'VS Code settings.json 不是合法 UTF-8，无法无损更新，没有覆盖原文件。',
    );
  }
  return decoded;
}

function readSnapshot(path: string): FileSnapshotState {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isMissingError(error)) {
      return { kind: 'missing' };
    }
    throw error;
  }

  if (!stat.isFile()) {
    throw new VscodeSettingsError(`VS Code settings.json 不是普通文件: ${path}`);
  }
  const bytes = readFileSync(path);
  return {
    kind: 'file',
    bytes,
    revision: fileRevision(bytes),
    mode: stat.mode & 0o777,
  };
}

function snapshotsMatch(expected: FileSnapshotState, actual: FileSnapshotState): boolean {
  if (expected.kind !== actual.kind) {
    return false;
  }
  if (expected.kind === 'missing' || actual.kind === 'missing') {
    return true;
  }
  return expected.revision === actual.revision && expected.mode === actual.mode;
}

function readDescriptorSnapshot(descriptor: number): FileSnapshot {
  const stat = fstatSync(descriptor);
  if (!stat.isFile()) {
    throw new VscodeSettingsError('VS Code settings.json 并发保护句柄不再是普通文件。');
  }
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (read === 0) {
      break;
    }
    offset += read;
  }
  if (offset !== bytes.length) {
    throw new VscodeSettingsError('无法完整读取 VS Code settings.json 并发保护句柄。');
  }
  return {
    kind: 'file',
    bytes,
    revision: fileRevision(bytes),
    mode: stat.mode & 0o777,
  };
}

function formattingOptions(text: string): FormattingOptions {
  const indentation = text.match(/(?:\r?\n)([ \t]+)"/u)?.[1];
  const usesTabs = indentation?.startsWith('\t') ?? false;
  return {
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    insertSpaces: !usesTabs,
    tabSize: usesTabs ? 1 : Math.max(1, indentation?.length ?? 2),
  };
}

function parseSettings(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0) {
    const reason = errors
      .map((error) => `${printParseErrorCode(error.error)}@${error.offset}`)
      .join(', ');
    throw new VscodeSettingsError(`VS Code settings.json 不是合法 JSONC (${reason})，没有覆盖原文件。`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VscodeSettingsError('VS Code settings.json 顶层必须是 JSONC 对象，没有覆盖原文件。');
  }
  assertNoDuplicateManagedSettingsKeys(text);
  return value as Record<string, unknown>;
}

function propertyName(node: Node): string | undefined {
  if (node.type !== 'property') {
    return undefined;
  }
  const key = node.children?.[0]?.value;
  return typeof key === 'string' ? key : undefined;
}

function assertNoDuplicateManagedSettingsKeys(text: string): void {
  const root = parseTree(text, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const seen = new Set<string>();
  for (const property of root?.children ?? []) {
    const key = propertyName(property);
    if (!key || !MANAGED_SETTINGS_KEYS.has(key)) {
      continue;
    }
    if (seen.has(key)) {
      throw new VscodeSettingsError(
        `VS Code settings.json 包含重复的 ${key}，没有覆盖原文件。`,
      );
    }
    seen.add(key);
  }
}

function assertManagedSettingsInvariant(text: string, source: string): void {
  const parsed = parseSettings(text);
  if (parsed['chat.plugins.enabled'] !== true) {
    throw new VscodeSettingsError(
      '候选 VS Code settings.json 未启用 chat.plugins.enabled，没有覆盖原文件。',
    );
  }
  const marketplaces = parsed['chat.plugins.marketplaces'];
  if (
    !Array.isArray(marketplaces) ||
    marketplaces.some((entry) => typeof entry !== 'string') ||
    !marketplaces.includes(source) ||
    new Set(marketplaces).size !== marketplaces.length
  ) {
    throw new VscodeSettingsError(
      '候选 VS Code settings.json 未满足 Marketplace 去重与来源注册约束，没有覆盖原文件。',
    );
  }
}

function jsoncCommentTokens(text: string): string[] {
  const scanner = createScanner(text, false);
  const comments: string[] = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      const offset = scanner.getTokenOffset();
      comments.push(text.slice(offset, offset + scanner.getTokenLength()));
    }
  }
  return comments;
}

function assertJsoncCommentsPreserved(originalText: string, updatedText: string): void {
  const originalComments = jsoncCommentTokens(originalText);
  const updatedComments = jsoncCommentTokens(updatedText);
  if (
    originalComments.length !== updatedComments.length ||
    originalComments.some((comment, index) => updatedComments[index] !== comment)
  ) {
    throw new VscodeSettingsError(
      '自动更新会删除、改写或重排 VS Code settings.json 中的 JSONC 注释，没有覆盖原文件。请先手工整理重复 Marketplace 项。',
    );
  }
}

function applyModification(
  text: string,
  path: (string | number)[],
  value: unknown,
  format: FormattingOptions,
  isArrayInsertion = false,
): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: format,
      ...(isArrayInsertion ? { isArrayInsertion: true } : {}),
    }),
  );
}

function buildUpdatedSettings(originalText: string, source: string): string {
  const parsed = parseSettings(originalText);
  const rawMarketplaces = parsed['chat.plugins.marketplaces'];
  if (
    rawMarketplaces !== undefined &&
    (!Array.isArray(rawMarketplaces) || rawMarketplaces.some((entry) => typeof entry !== 'string'))
  ) {
    throw new VscodeSettingsError(
      'chat.plugins.marketplaces 必须是字符串数组，没有覆盖 VS Code settings.json。',
    );
  }

  const format = formattingOptions(originalText);
  let updated = originalText;
  if (parsed['chat.plugins.enabled'] !== true) {
    updated = applyModification(updated, ['chat.plugins.enabled'], true, format);
  }

  if (rawMarketplaces === undefined) {
    updated = applyModification(updated, ['chat.plugins.marketplaces'], [source], format);
    return updated;
  }

  const marketplaces = rawMarketplaces as string[];
  const seen = new Set<string>();
  const duplicateIndexes: number[] = [];
  for (const [index, entry] of marketplaces.entries()) {
    if (seen.has(entry)) {
      duplicateIndexes.push(index);
    } else {
      seen.add(entry);
    }
  }
  for (const index of duplicateIndexes.sort((left, right) => right - left)) {
    updated = applyModification(updated, ['chat.plugins.marketplaces', index], undefined, format);
  }
  if (!seen.has(source)) {
    updated = applyModification(
      updated,
      ['chat.plugins.marketplaces', seen.size],
      source,
      format,
      true,
    );
  }
  return updated;
}

function bestEffortDirectoryFsync(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch {
    // The target file has already been atomically replaced. Some platforms do not fsync directories.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function unlinkWithPermissionRecovery(path: string): string | undefined {
  try {
    unlinkSync(path);
    return undefined;
  } catch (error) {
    if (isMissingError(error)) {
      return undefined;
    }
    const firstMessage = error instanceof Error ? error.message : String(error);
    const parent = dirname(path);
    let parentMode: number | undefined;
    try {
      parentMode = statSync(parent).mode & 0o7777;
      chmodSync(parent, parentMode | 0o300);
      unlinkSync(path);
      chmodSync(parent, parentMode);
      return undefined;
    } catch (recoveryError) {
      if (parentMode !== undefined) {
        try {
          chmodSync(parent, parentMode);
        } catch {
          // The combined cleanup error below exposes both the residual path and recovery need.
        }
      }
      const recoveryMessage = recoveryError instanceof Error
        ? recoveryError.message
        : String(recoveryError);
      return `${firstMessage}; 权限恢复清理失败: ${recoveryMessage}`;
    }
  }
}

function scrubAndCleanupTempFile(path: string, descriptor: number | undefined): string | undefined {
  const cleanupErrors: string[] = [];
  if (descriptor !== undefined) {
    try {
      const descriptorStat = fstatSync(descriptor);
      let pathStat;
      try {
        pathStat = lstatSync(path);
      } catch (error) {
        if (!isMissingError(error)) {
          throw error;
        }
      }
      if (
        pathStat &&
        pathStat.dev === descriptorStat.dev &&
        pathStat.ino === descriptorStat.ino
      ) {
        ftruncateSync(descriptor, 0);
        fsyncSync(descriptor);
      }
    } catch (error) {
      cleanupErrors.push(
        `候选内容清空失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(
        `候选句柄关闭失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const unlinkError = unlinkWithPermissionRecovery(path);
  if (unlinkError) {
    cleanupErrors.push(`临时文件删除失败: ${unlinkError}`);
  }
  return cleanupErrors.length > 0
    ? `${cleanupErrors.join('；')}。请手工删除 ${path}`
    : undefined;
}

function restoreSnapshotAtomically(
  settingsPath: string,
  snapshot: FileSnapshot,
  beforeRename?: () => void,
): void {
  const parent = dirname(settingsPath);
  const recoveryPath = join(
    parent,
    `.${basename(settingsPath)}.agent-plugkit-recovery-${process.pid}-${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  let pendingPath: string | undefined = recoveryPath;
  try {
    descriptor = openSync(recoveryPath, 'wx', snapshot.mode);
    writeFileSync(descriptor, snapshot.bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(recoveryPath, snapshot.mode);
    beforeRename?.();
    // Recovery is also an unconditional rename. A distinct inode installed after the last
    // observable check can be overwritten here; TD-001 records this accepted v1 limitation.
    renameSync(recoveryPath, settingsPath);
    pendingPath = undefined;
    bestEffortDirectoryFsync(parent);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (pendingPath) {
      const cleanupError = unlinkWithPermissionRecovery(pendingPath);
      if (cleanupError) {
        throw new VscodeSettingsError(
          `并发内容恢复失败且恢复临时文件清理失败: ${cleanupError}。请手工删除 ${pendingPath}`,
        );
      }
    }
  }
}

export function resolveVscodeUserSettingsPath(
  options: InspectVscodeUserSettingsOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const pathApi = platform === 'win32' ? win32 : { isAbsolute, join };
  const safeRoot = (value: string | undefined): string | undefined =>
    value && pathApi.isAbsolute(value) && !PATH_CONTROL_CHARACTERS.test(value)
      ? value
      : undefined;
  const safeHome = safeRoot(home);
  if (platform === 'darwin') {
    return safeHome
      ? pathApi.join(safeHome, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
      : undefined;
  }
  if (platform === 'linux') {
    const configRoot = safeRoot(env.XDG_CONFIG_HOME) ?? (safeHome ? pathApi.join(safeHome, '.config') : undefined);
    return configRoot
      ? pathApi.join(configRoot, 'Code', 'User', 'settings.json')
      : undefined;
  }
  if (platform === 'win32') {
    const configRoot = safeRoot(env.APPDATA) ?? (safeHome ? pathApi.join(safeHome, 'AppData', 'Roaming') : undefined);
    return configRoot
      ? pathApi.join(configRoot, 'Code', 'User', 'settings.json')
      : undefined;
  }
  return undefined;
}

export async function inspectVscodeUserSettings(
  processRunner: ProcessRunner,
  options: InspectVscodeUserSettingsOptions = {},
): Promise<VscodeSettingsInspection> {
  const settingsPath = resolveVscodeUserSettingsPath(options);
  if (!settingsPath) {
    return {
      status: 'unavailable',
      message: '无法定位当前操作系统的 VS Code 用户 settings.json。',
    };
  }
  if (existsSync(dirname(settingsPath))) {
    return { status: 'ready', settingsPath };
  }

  const probe = await processRunner.run({
    executable: 'code',
    args: ['--help'],
    captureOutput: true,
    signal: options.signal,
  });
  if (probe.status === 'interrupted') {
    return { status: 'interrupted', signal: probe.signal };
  }
  if (probe.status !== 'completed') {
    return {
      status: 'unavailable',
      message: '未检测到官方 VS Code 用户目录或可确认的 code CLI。',
    };
  }
  const banner = `${probe.stdout}\n${probe.stderr}`;
  if (/cursor/iu.test(banner) || !/visual studio code/iu.test(banner)) {
    return {
      status: 'unavailable',
      message: 'code CLI 未被确认是官方 Visual Studio Code；不会写入可能属于 Cursor 的配置。',
    };
  }
  return { status: 'ready', settingsPath };
}

export function updateVscodeMarketplaceSettings(
  request: VscodeSettingsUpdateRequest,
  dependencies: VscodeSettingsUpdateDependencies = {},
): VscodeSettingsUpdateResult {
  const settingsPath = request.settingsPath;
  let tempPath: string | undefined;
  let tempDescriptor: number | undefined;
  let guardDescriptor: number | undefined;
  let failure: unknown;
  let cleanupFailure: string | undefined;
  try {
    if (!isAbsolute(settingsPath) || PATH_CONTROL_CHARACTERS.test(settingsPath)) {
      throw new VscodeSettingsError(
        'VS Code settings.json 必须是无控制字符的绝对用户配置路径，没有写入任何文件。',
      );
    }
    const initial = readSnapshot(settingsPath);
    const originalText = initial.kind === 'file'
      ? decodeUtf8Losslessly(initial.bytes)
      : '{}\n';
    const updatedText = buildUpdatedSettings(originalText, request.source);
    assertJsoncCommentsPreserved(originalText, updatedText);
    assertManagedSettingsInvariant(updatedText, request.source);
    if (updatedText === originalText) {
      return { status: 'completed', changed: false, settingsPath };
    }

    const parent = dirname(settingsPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    tempPath = join(
      parent,
      `.${basename(settingsPath)}.agent-plugkit-${process.pid}-${randomUUID()}.tmp`,
    );
    const mode = initial.kind === 'file' ? initial.mode : 0o600;
    const candidateBytes = Buffer.from(updatedText, 'utf8');
    const candidateSnapshot: FileSnapshot = {
      kind: 'file',
      bytes: candidateBytes,
      revision: fileRevision(candidateBytes),
      mode,
    };
    tempDescriptor = openSync(tempPath, 'wx', mode);
    writeFileSync(tempDescriptor, candidateBytes);
    fsyncSync(tempDescriptor);
    chmodSync(tempPath, mode);

    dependencies.beforeRevisionCheck?.();
    const current = readSnapshot(settingsPath);
    if (!snapshotsMatch(initial, current)) {
      throw new VscodeSettingsError(
        'VS Code settings.json 在提交前发生并发变化，没有覆盖当前文件。',
      );
    }

    if (initial.kind === 'file') {
      guardDescriptor = openSync(settingsPath, 'r');
      const guarded = readDescriptorSnapshot(guardDescriptor);
      if (!snapshotsMatch(initial, guarded)) {
        throw new VscodeSettingsError(
          'VS Code settings.json 在提交保护建立时发生并发变化，没有覆盖当前文件。',
        );
      }
    }

    if (initial.kind === 'missing') {
      try {
        linkSync(tempPath, settingsPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
          throw new VscodeSettingsError(
            'VS Code settings.json 在原子创建时发生并发变化，没有覆盖当前文件。',
          );
        }
        throw error;
      }
      closeSync(tempDescriptor);
      tempDescriptor = undefined;
      const unlinkError = unlinkWithPermissionRecovery(tempPath);
      if (unlinkError) {
        throw new VscodeSettingsError(
          `VS Code settings.json 已原子创建，但临时链接清理失败: ${unlinkError}。请手工删除 ${tempPath}`,
        );
      }
      tempPath = undefined;
    } else {
      try {
        // Node's rename has no revision/CAS condition. The surrounding snapshots and guard
        // descriptor cover every conflict promised by REQ-004; the distinct-inode race accepted
        // as TD-001 remains an explicit v1 limitation.
        (dependencies.rename ?? renameSync)(tempPath, settingsPath);
        tempPath = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new VscodeSettingsError(`VS Code settings.json 原子替换失败: ${message}`);
      }

      const committed = readSnapshot(settingsPath);
      if (!snapshotsMatch(candidateSnapshot, committed)) {
        throw new VscodeSettingsError(
          'VS Code settings.json 在原子替换后发生并发变化；保留当前并发内容并停止。',
        );
      }
      const displaced = guardDescriptor === undefined
        ? initial
        : readDescriptorSnapshot(guardDescriptor);
      if (!snapshotsMatch(initial, displaced)) {
        restoreSnapshotAtomically(
          settingsPath,
          displaced,
          dependencies.beforeRecoveryRename,
        );
        throw new VscodeSettingsError(
          'VS Code settings.json 在 revision 检查与原子替换之间发生同 inode 并发变化；已按最佳努力恢复 guard 捕获的内容。恢复 rename 不具备 CAS，期间的新 inode 写入可能被覆盖（TD-001）。',
        );
      }
    }
    bestEffortDirectoryFsync(parent);
    return { status: 'completed', changed: true, settingsPath };
  } catch (error) {
    failure = error;
  } finally {
    if (guardDescriptor !== undefined) {
      closeSync(guardDescriptor);
    }
    if (tempPath) {
      cleanupFailure = scrubAndCleanupTempFile(tempPath, tempDescriptor);
      tempDescriptor = undefined;
    } else if (tempDescriptor !== undefined) {
      closeSync(tempDescriptor);
    }
  }
  return {
    status: 'failed',
    message: [
      failure instanceof Error ? failure.message : String(failure),
      cleanupFailure,
    ].filter(Boolean).join('；'),
    settingsPath,
  };
}
