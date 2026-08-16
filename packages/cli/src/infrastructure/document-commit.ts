import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  AuthorizedPathError,
  authorizeExistingDirectory,
  resolveAuthorizedPath,
  type AuthorizedRoot,
} from './authorized-path.js';

/**
 * These names are reserved transaction traces inside an authorized workspace.
 * They are not product state. A valid lock records the only staging token that
 * may be reclaimed after its owner has exited.
 */
export const WORKSPACE_WRITE_LOCK = '.agent-plugkit-write.lock';
export const DOCUMENT_STAGING_PREFIX = '.agent-plugkit-document-';
const LOCK_RECLAIM_PREFIX = '.agent-plugkit-lock-reclaim-';
const LOCK_PREPARE_PREFIX = '.agent-plugkit-lock-prepare-';

const activeLockTokens = new Set<string>();
const activePrepareTokens = new Set<string>();

export interface AtomicDocumentCommitRequest {
  readonly directory: string;
  readonly relativePath: string;
  readonly expectedRevision: string;
  readonly nextBytes: Uint8Array;
}

export interface AtomicDocumentCreateFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

/**
 * A component declaration can require a new canonical scaffold (currently a
 * Skill document or Hook script). The document and those exclusive-create
 * files share the same workspace lock and staging root. Existing user files
 * are never replaced by this operation.
 */
export interface AtomicDocumentAndFilesCommitRequest
  extends AtomicDocumentCommitRequest {
  readonly createFiles: readonly AtomicDocumentCreateFile[];
}

export interface AtomicDocumentAndFilesCommitDependencies
  extends AtomicDocumentCommitDependencies {
  readonly beforeCreateFile?: (stagedPath: string, targetPath: string) => void;
  readonly createFile?: (stagedPath: string, targetPath: string) => void;
  readonly rollbackFile?: (targetPath: string) => void;
  readonly rollbackDocument?: (backupPath: string, targetPath: string) => void;
}

export interface AtomicDocumentAndFilesTransactionFacts {
  readonly canonical:
    | "unchanged"
    | "committed"
    | "restored"
    | "uncertain";
  readonly scaffolds:
    | "none"
    | "committed"
    | "rolled-back"
    | "residual";
  readonly cleanupComplete: boolean;
}

export type AtomicDocumentAndFilesCommitResult = AtomicDocumentCommitResult & {
  readonly transaction: AtomicDocumentAndFilesTransactionFacts;
};

/**
 * `diskChanged` reports a canonical document replacement or transaction
 * residue left by this call. Successfully reclaimed prior transaction traces
 * and transient no-clobber links do not turn it on.
 */
export type AtomicDocumentCommitResult =
  | {
      readonly status: 'committed';
      readonly revision: string;
      readonly diskChanged: true;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: 'verified';
      readonly revision: string;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: 'conflict';
      readonly currentRevision: string;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: 'busy';
      readonly message: string;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly diskChanged: boolean;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: boolean;
    };

export interface AtomicDocumentCommitDependencies {
  readonly createToken?: () => string;
  readonly now?: () => Date;
  readonly isProcessAlive?: (processId: number) => boolean;
  readonly afterReclaimLink?: (
    lockPath: string,
    quarantinePath: string,
  ) => void;
  readonly beforeLockSync?: (lockPath: string) => void;
  readonly afterLock?: () => void;
  readonly beforeStageWrite?: (stagedPath: string) => void;
  readonly syncStagedFile?: (stagedPath: string) => void;
  readonly afterStageWrite?: (stagedPath: string) => void;
  readonly beforeRevisionRecheck?: (targetPath: string) => void;
  readonly replaceDocument?: (stagedPath: string, targetPath: string) => void;
  readonly syncParentDirectory?: (directory: string) => void;
  readonly afterReplace?: (targetPath: string) => void;
  readonly cleanupStaging?: (stagingRoot: string) => void;
  readonly cleanupLock?: (lockPath: string, token: string) => void;
}

export type AtomicArtifactMutation =
  | {
      readonly relativePath: string;
      readonly action: "write";
      readonly bytes: Uint8Array;
      readonly mode?: number;
    }
  | {
      readonly relativePath: string;
      readonly action: "delete";
    };

export interface AtomicArtifactExpectation {
  readonly relativePath: string;
  readonly revision: string | "missing";
}

export interface AtomicArtifactGroupCommitRequest {
  readonly directory: string;
  readonly expectations: readonly AtomicArtifactExpectation[];
  readonly mutations: readonly AtomicArtifactMutation[];
}

export interface AtomicArtifactGroupCommitDependencies
  extends Pick<
    AtomicDocumentCommitDependencies,
    "createToken" | "now" | "isProcessAlive" | "beforeLockSync" | "afterReclaimLink"
  > {
  readonly beforeMutation?: (relativePath: string) => void;
  readonly replaceArtifact?: (stagedPath: string, targetPath: string) => void;
  readonly beforeRollback?: (relativePath: string) => void;
  readonly removeCreatedDirectory?: (
    path: string,
    relativePath: string,
  ) => void;
  readonly cleanupStaging?: (stagingRoot: string) => void;
  readonly cleanupLock?: (lockPath: string, token: string) => void;
}

export type AtomicArtifactGroupCommitResult =
  | {
      readonly status: "committed" | "verified";
      readonly changedPaths: readonly string[];
      readonly diskChanged: boolean;
      readonly rolledBack: false;
      readonly cleanupComplete: true;
    }
  | {
      readonly status: "conflict" | "busy";
      readonly message: string;
      readonly changedPaths: readonly [];
      readonly diskChanged: false;
      readonly rolledBack: false;
      readonly cleanupComplete: true;
    }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly changedPaths: readonly string[];
      readonly diskChanged: boolean;
      readonly rolledBack: boolean;
      readonly cleanupComplete: boolean;
    };

interface WorkspaceLockRecord {
  readonly version: 1;
  readonly token: string;
  readonly processId: number;
  readonly startedAt: string;
}

type LockAcquisition =
  | {
      readonly status: 'acquired';
      readonly path: string;
      readonly token: string;
    }
  | {
      readonly status: 'busy';
    }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly diskChanged: boolean;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: boolean;
    };

export function documentRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function failureMessage(error: unknown): string {
  if (error instanceof AuthorizedPathError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function readRegularFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error('提交目标不是普通文件');
  return readFileSync(path);
}

function defaultProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

function parseLockRecord(raw: string): WorkspaceLockRecord | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 4 ||
      record.version !== 1 ||
      typeof record.token !== 'string' ||
      !/^[0-9a-f-]{16,80}$/i.test(record.token) ||
      !Number.isInteger(record.processId) ||
      (record.processId as number) <= 0 ||
      typeof record.startedAt !== 'string' ||
      Number.isNaN(Date.parse(record.startedAt))
    ) {
      return undefined;
    }
    return {
      version: 1,
      token: record.token,
      processId: record.processId as number,
      startedAt: record.startedAt,
    };
  } catch {
    return undefined;
  }
}

function recordCanBeReclaimed(
  record: WorkspaceLockRecord,
  isProcessAlive: (processId: number) => boolean,
): boolean {
  if (
    activeLockTokens.has(record.token) ||
    activePrepareTokens.has(record.token)
  ) {
    return false;
  }
  // A live PID always keeps ownership. Elapsed time cannot distinguish a
  // genuinely long transaction from PID reuse, so it must never weaken the
  // exclusive-write guarantee.
  return !isProcessAlive(record.processId);
}

function shouldReclaimLock(
  lockPath: string,
  isProcessAlive: (processId: number) => boolean,
): { readonly reclaim: boolean; readonly token?: string } {
  const record = parseLockRecord(readFileSync(lockPath, 'utf8'));
  if (record === undefined) {
    // An unrecognized reserved-path occupant is not proven to be ours.
    // Fail closed rather than deleting a possibly user-owned file.
    return { reclaim: false };
  }
  return {
    reclaim: recordCanBeReclaimed(record, isProcessAlive),
    token: record.token,
  };
}

function reclaimAbandonedLock(
  directory: string,
  lockPath: string,
  lockToken: string | undefined,
  reclaimToken: string,
  afterReclaimLink?: (lockPath: string, quarantinePath: string) => void,
): Extract<LockAcquisition, { status: 'failed' }> | undefined {
  const residualPaths: string[] = [];
  let staleStagingRelative: string | undefined;
  let staleStagingPath: string | undefined;
  let stalePrepareRelative: string | undefined;
  let stalePreparePath: string | undefined;
  const quarantineRelative = `${LOCK_RECLAIM_PREFIX}${reclaimToken}`;
  const quarantinePath = resolveAuthorizedPath(directory, quarantineRelative);
  let quarantineLinked = false;
  let canonicalLockRemoved = false;
  let diskChanged = false;
  try {
    // link(2) gives us a no-clobber quarantine claim. Unlike rename(2), it
    // cannot overwrite an unknown same-name occupant.
    linkSync(lockPath, quarantinePath);
    quarantineLinked = true;
    diskChanged = true;
    afterReclaimLink?.(lockPath, quarantinePath);
    const quarantinedRecord = parseLockRecord(
      readFileSync(quarantinePath, 'utf8'),
    );
    const currentRecord = parseLockRecord(readFileSync(lockPath, 'utf8'));
    const lockStat = statSync(lockPath);
    const quarantineStat = statSync(quarantinePath);
    if (
      lockToken === undefined ||
      quarantinedRecord?.token !== lockToken ||
      currentRecord?.token !== lockToken ||
      lockStat.dev !== quarantineStat.dev ||
      lockStat.ino !== quarantineStat.ino
    ) {
      throw new Error('旧写入锁在隔离期间发生变化，未移除 canonical 锁');
    }
    releaseWorkspaceLock(lockPath, lockToken);
    canonicalLockRemoved = true;

    if (lockToken !== undefined) {
      staleStagingRelative = `${DOCUMENT_STAGING_PREFIX}${lockToken}`;
      staleStagingPath = resolveAuthorizedPath(
        directory,
        staleStagingRelative,
      );
      if (existsSync(staleStagingPath)) {
        try {
          rmSync(staleStagingPath, { recursive: true, force: true });
          diskChanged = true;
        } catch (error) {
          return {
            status: 'failed',
            message: `无法清理上次异常退出的临时目录：${failureMessage(error)}`,
            diskChanged,
            changedPaths: [
              WORKSPACE_WRITE_LOCK,
              staleStagingRelative,
              quarantineRelative,
            ],
            cleanupComplete: false,
          };
        }
      }
      stalePrepareRelative = `${LOCK_PREPARE_PREFIX}${lockToken}`;
      stalePreparePath = resolveAuthorizedPath(
        directory,
        stalePrepareRelative,
      );
      if (existsSync(stalePreparePath)) {
        const prepareRecord = parseLockRecord(
          readFileSync(stalePreparePath, 'utf8'),
        );
        const prepareStat = statSync(stalePreparePath);
        const quarantineStatAfterRelease = statSync(quarantinePath);
        if (
          prepareRecord?.token !== lockToken ||
          prepareStat.dev !== quarantineStatAfterRelease.dev ||
          prepareStat.ino !== quarantineStatAfterRelease.ino
        ) {
          return {
            status: 'failed',
            message:
              '旧写入锁已经移除，但同 token 的锁准备文件无法证明属于该事务。',
            diskChanged: true,
            changedPaths: [
              WORKSPACE_WRITE_LOCK,
              stalePrepareRelative,
              quarantineRelative,
            ],
            cleanupComplete: false,
          };
        }
        try {
          unlinkSync(stalePreparePath);
          diskChanged = true;
        } catch (error) {
          return {
            status: 'failed',
            message: `无法清理上次异常退出的锁准备文件：${failureMessage(error)}`,
            diskChanged: true,
            changedPaths: [
              WORKSPACE_WRITE_LOCK,
              stalePrepareRelative,
              quarantineRelative,
            ],
            cleanupComplete: false,
          };
        }
      }
    }
    try {
      unlinkSync(quarantinePath);
      quarantineLinked = false;
    } catch (error) {
      residualPaths.push(quarantineRelative);
      return {
        status: 'failed',
        message: `旧写入锁已隔离，但清理失败：${failureMessage(error)}`,
        diskChanged: true,
        changedPaths: residualPaths,
        cleanupComplete: false,
      };
    }
    return undefined;
  } catch (error) {
    if (
      quarantineLinked &&
      !canonicalLockRemoved &&
      existsSync(quarantinePath)
    ) {
      try {
        unlinkSync(quarantinePath);
        quarantineLinked = false;
      } catch {
        residualPaths.push(quarantineRelative);
      }
    }
    if (
      staleStagingRelative !== undefined &&
      staleStagingPath !== undefined &&
      existsSync(staleStagingPath)
    ) {
      residualPaths.push(staleStagingRelative);
    }
    if (
      stalePrepareRelative !== undefined &&
      stalePreparePath !== undefined &&
      existsSync(stalePreparePath)
    ) {
      residualPaths.push(stalePrepareRelative);
    }
    if (quarantineLinked && existsSync(quarantinePath)) {
      residualPaths.push(quarantineRelative);
    }
    if (canonicalLockRemoved) {
      residualPaths.unshift(WORKSPACE_WRITE_LOCK);
    }
    const rolledBackLink =
      !canonicalLockRemoved &&
      !quarantineLinked &&
      residualPaths.length === 0;
    return {
      status: 'failed',
      message: `无法安全回收上次异常退出的写入锁：${failureMessage(error)}`,
      diskChanged: rolledBackLink ? false : diskChanged,
      changedPaths: residualPaths,
      cleanupComplete: residualPaths.length === 0,
    };
  }
}

class TraceRecoveryError extends Error {
  readonly diskChanged: boolean;
  readonly changedPaths: readonly string[];
  readonly cleanupComplete: boolean;

  constructor(
    message: string,
    facts: {
      readonly diskChanged: boolean;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: boolean;
    },
  ) {
    super(message);
    this.name = 'TraceRecoveryError';
    this.diskChanged = facts.diskChanged;
    this.changedPaths = facts.changedPaths;
    this.cleanupComplete = facts.cleanupComplete;
  }
}

function prepareTokenFromEntry(entry: string): string | undefined {
  if (!entry.startsWith(LOCK_PREPARE_PREFIX)) return undefined;
  const token = entry.slice(LOCK_PREPARE_PREFIX.length);
  return /^[0-9a-f-]{16,80}$/i.test(token) ? token : undefined;
}

function reclaimOrphanPrepare(
  directory: string,
  entry: string,
  record: WorkspaceLockRecord,
  reclaimToken: string,
  isProcessAlive: (processId: number) => boolean,
): boolean {
  const preparePath = resolveAuthorizedPath(directory, entry);
  const quarantineRelative =
    `${LOCK_RECLAIM_PREFIX}${reclaimToken}-${record.token}`;
  const quarantinePath = resolveAuthorizedPath(
    directory,
    quarantineRelative,
  );
  let quarantineLinked = false;
  let prepareRemoved = false;
  try {
    linkSync(preparePath, quarantinePath);
    quarantineLinked = true;
    const currentRecord = parseLockRecord(readFileSync(preparePath, 'utf8'));
    const quarantineRecord = parseLockRecord(
      readFileSync(quarantinePath, 'utf8'),
    );
    const prepareStat = statSync(preparePath);
    const quarantineStat = statSync(quarantinePath);
    if (
      currentRecord?.token !== record.token ||
      quarantineRecord?.token !== record.token ||
      currentRecord.processId !== record.processId ||
      currentRecord.startedAt !== record.startedAt ||
      prepareStat.dev !== quarantineStat.dev ||
      prepareStat.ino !== quarantineStat.ino ||
      !recordCanBeReclaimed(currentRecord, isProcessAlive)
    ) {
      unlinkSync(quarantinePath);
      quarantineLinked = false;
      return false;
    }
    unlinkSync(preparePath);
    prepareRemoved = true;
    unlinkSync(quarantinePath);
    quarantineLinked = false;
    return true;
  } catch (error) {
    if (quarantineLinked && !prepareRemoved && existsSync(quarantinePath)) {
      try {
        unlinkSync(quarantinePath);
        quarantineLinked = false;
      } catch {
        // Report the exact residual below.
      }
    }
    if (prepareRemoved || quarantineLinked) {
      throw new TraceRecoveryError(
        `锁准备文件恢复没有完整完成：${failureMessage(error)}`,
        {
          diskChanged: true,
          changedPaths: [
            ...(prepareRemoved ? [entry] : []),
            ...(quarantineLinked ? [quarantineRelative] : []),
          ],
          cleanupComplete: !quarantineLinked,
        },
      );
    }
    // An unproven or no-clobber collision is left untouched. It does not own
    // the canonical lock and therefore must not block this document commit.
    return false;
  }
}

function cleanupAbandonedPrepareFiles(
  directory: string,
  reclaimToken: string,
  isProcessAlive: (processId: number) => boolean,
): void {
  for (const entry of readdirSync(directory)) {
    const token = prepareTokenFromEntry(entry);
    if (token === undefined || activePrepareTokens.has(token)) continue;
    const path = resolveAuthorizedPath(directory, entry);
    let record: WorkspaceLockRecord | undefined;
    try {
      if (!lstatSync(path).isFile()) continue;
      record = parseLockRecord(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (
      record === undefined ||
      record.token !== token ||
      !recordCanBeReclaimed(record, isProcessAlive)
    ) {
      continue;
    }
    reclaimOrphanPrepare(
      directory,
      entry,
      record,
      reclaimToken,
      isProcessAlive,
    );
  }
}

function createLockFile(
  directory: string,
  lockPath: string,
  record: WorkspaceLockRecord,
  beforeLockSync?: (lockPath: string) => void,
): LockAcquisition {
  const prepareRelative = `${LOCK_PREPARE_PREFIX}${record.token}`;
  const preparePath = resolveAuthorizedPath(directory, prepareRelative);
  let descriptor: number | undefined;
  let prepareCreated = false;
  let lockLinked = false;
  let closeFailed = false;
  activePrepareTokens.add(record.token);
  try {
    descriptor = openSync(preparePath, 'wx', 0o600);
    prepareCreated = true;
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    beforeLockSync?.(preparePath);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(preparePath, lockPath);
    lockLinked = true;
    unlinkSync(preparePath);
    prepareCreated = false;
    activeLockTokens.add(record.token);
    return { status: 'acquired', path: lockPath, token: record.token };
  } catch (error) {
    if (
      lockLinked === false &&
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      if (!prepareCreated) {
        return {
          status: 'failed',
          message:
            '锁准备文件名已被占用，无法证明该路径属于本次事务。',
          diskChanged: false,
          changedPaths: [],
          cleanupComplete: true,
        };
      }
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          closeFailed = true;
        }
        descriptor = undefined;
      }
      if (prepareCreated) {
        try {
          unlinkSync(preparePath);
          prepareCreated = false;
        } catch {
          return {
            status: 'failed',
            message: '写入锁发生竞争，且本次锁准备文件未能清理。',
            diskChanged: true,
            changedPaths: [prepareRelative],
            cleanupComplete: false,
          };
        }
      }
      return closeFailed
        ? {
            status: 'failed',
            message: '写入锁发生竞争，且锁准备文件描述符未能确认关闭。',
            diskChanged: false,
            changedPaths: [],
            cleanupComplete: false,
          }
        : { status: 'busy' };
    }
    const cleanupErrors: string[] = [];
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        closeFailed = true;
        cleanupErrors.push(`关闭锁文件失败：${failureMessage(closeError)}`);
      }
    }
    if (lockLinked) {
      try {
        releaseWorkspaceLock(lockPath, record.token);
        lockLinked = false;
      } catch (releaseError) {
        cleanupErrors.push(`移除本次写入锁失败：${failureMessage(releaseError)}`);
      }
    }
    if (prepareCreated && existsSync(preparePath)) {
      try {
        unlinkSync(preparePath);
        prepareCreated = false;
      } catch (unlinkError) {
        cleanupErrors.push(`移除锁准备文件失败：${failureMessage(unlinkError)}`);
      }
    }
    const lockRemains = lockLinked && existsSync(lockPath);
    const prepareRemains = prepareCreated && existsSync(preparePath);
    return {
      status: 'failed',
      message: [
        `无法建立安全写入锁：${failureMessage(error)}`,
        ...cleanupErrors,
      ].join('；'),
      diskChanged: lockRemains || prepareRemains,
      changedPaths: [
        ...(lockRemains ? [WORKSPACE_WRITE_LOCK] : []),
        ...(prepareRemains ? [prepareRelative] : []),
      ],
      cleanupComplete: !closeFailed && !lockRemains && !prepareRemains,
    };
  } finally {
    activePrepareTokens.delete(record.token);
  }
}

function acquireWorkspaceLock(
  directory: string,
  token: string,
  now: Date,
  isProcessAlive: (processId: number) => boolean,
  beforeLockSync?: (lockPath: string) => void,
  afterReclaimLink?: (lockPath: string, quarantinePath: string) => void,
): LockAcquisition {
  const lockPath = resolveAuthorizedPath(directory, WORKSPACE_WRITE_LOCK);
  let acquisition = createLockFile(
    directory,
    lockPath,
    {
      version: 1,
      token,
      processId: process.pid,
      startedAt: now.toISOString(),
    },
    beforeLockSync,
  );
  if (acquisition.status !== 'busy') return acquisition;

  let abandoned;
  try {
    abandoned = shouldReclaimLock(lockPath, isProcessAlive);
  } catch (error) {
    return {
      status: 'failed',
      message: `无法检查当前写入锁：${failureMessage(error)}`,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  if (!abandoned.reclaim) return acquisition;
  const reclaimFailure = reclaimAbandonedLock(
    directory,
    lockPath,
    abandoned.token,
    token,
    afterReclaimLink,
  );
  if (reclaimFailure !== undefined) return reclaimFailure;

  acquisition = createLockFile(
    directory,
    lockPath,
    {
      version: 1,
      token,
      processId: process.pid,
      startedAt: now.toISOString(),
    },
    beforeLockSync,
  );
  return acquisition;
}

function releaseWorkspaceLock(lockPath: string, token: string): void {
  const record = parseLockRecord(readFileSync(lockPath, 'utf8'));
  if (record?.token !== token) {
    throw new Error('写入锁的所有权已经变化，未移除该锁');
  }
  unlinkSync(lockPath);
}

function syncFile(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Commits one already-authorized document with a workspace-wide exclusive
 * lock. Domain ownership and patching stay with the caller. Atomicity means
 * readers see either the old or new target after rename; durability is only
 * reported as committed after both the staged file and its parent directory
 * have been fsynced.
 */
export function commitAuthorizedDocument(
  request: AtomicDocumentCommitRequest,
  dependencies: AtomicDocumentCommitDependencies = {},
): AtomicDocumentCommitResult {
  let authorization;
  try {
    authorization = authorizeExistingDirectory(request.directory);
  } catch (error) {
    return {
      status: 'failed',
      message: `无法获得写入授权：${failureMessage(error)}`,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }

  const token = (dependencies.createToken ?? randomUUID)();
  const lock = acquireWorkspaceLock(
    authorization.canonicalPath,
    token,
    (dependencies.now ?? (() => new Date()))(),
    dependencies.isProcessAlive ?? defaultProcessAlive,
    dependencies.beforeLockSync,
    dependencies.afterReclaimLink,
  );
  if (lock.status === 'failed') return lock;
  if (lock.status === 'busy') {
    return {
      status: 'busy',
      message: '这个 Marketplace 正在执行另一项写入；请等待完成后重试。',
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }

  const stagingRelative = `${DOCUMENT_STAGING_PREFIX}${token}`;
  let stagingRoot: string | undefined;
  let stagingCreated = false;
  let replaced = false;
  let outcome:
    | Extract<AtomicDocumentCommitResult, { status: 'committed' }>
    | Extract<AtomicDocumentCommitResult, { status: 'verified' }>
    | Extract<AtomicDocumentCommitResult, { status: 'conflict' }>
    | Extract<AtomicDocumentCommitResult, { status: 'failed' }>;

  try {
    dependencies.afterLock?.();
    cleanupAbandonedPrepareFiles(
      authorization.canonicalPath,
      token,
      dependencies.isProcessAlive ?? defaultProcessAlive,
    );
    const targetPath = resolveAuthorizedPath(
      authorization,
      request.relativePath,
    );
    const initialBytes = readRegularFile(targetPath);
    const currentRevision = documentRevision(initialBytes);
    if (currentRevision !== request.expectedRevision) {
      outcome = {
        status: 'conflict',
        currentRevision,
        diskChanged: false,
        changedPaths: [],
        cleanupComplete: true,
      };
    } else if (Buffer.from(request.nextBytes).equals(initialBytes)) {
      dependencies.beforeRevisionRecheck?.(targetPath);
      const precommitRevision = documentRevision(readRegularFile(targetPath));
      outcome =
        precommitRevision === request.expectedRevision
          ? {
              status: 'verified',
              revision: precommitRevision,
              diskChanged: false,
              changedPaths: [],
              cleanupComplete: true,
            }
          : {
              status: 'conflict',
              currentRevision: precommitRevision,
              diskChanged: false,
              changedPaths: [],
              cleanupComplete: true,
            };
    } else {
      stagingRoot = resolveAuthorizedPath(
        authorization,
        stagingRelative,
      );
      mkdirSync(stagingRoot, { mode: 0o700 });
      stagingCreated = true;
      const stagedPath = join(stagingRoot, 'document.next');
      dependencies.beforeStageWrite?.(stagedPath);
      writeFileSync(stagedPath, request.nextBytes, { mode: 0o600 });
      chmodSync(stagedPath, lstatSync(targetPath).mode & 0o777);
      (dependencies.syncStagedFile ?? syncFile)(stagedPath);
      dependencies.afterStageWrite?.(stagedPath);

      dependencies.beforeRevisionRecheck?.(targetPath);
      const precommitRevision = documentRevision(readRegularFile(targetPath));
      if (precommitRevision !== request.expectedRevision) {
        outcome = {
          status: 'conflict',
          currentRevision: precommitRevision,
          diskChanged: false,
          changedPaths: [],
          cleanupComplete: true,
        };
      } else {
        (dependencies.replaceDocument ?? renameSync)(stagedPath, targetPath);
        replaced = true;
        (dependencies.syncParentDirectory ??
          ((directory: string) => syncFile(directory)))(
          authorization.canonicalPath,
        );
        dependencies.afterReplace?.(targetPath);
        outcome = {
          status: 'committed',
          revision: documentRevision(request.nextBytes),
          diskChanged: true,
          changedPaths: [request.relativePath],
          cleanupComplete: true,
        };
      }
    }
  } catch (error) {
    outcome =
      error instanceof TraceRecoveryError
        ? {
            status: 'failed',
            message: error.message,
            diskChanged: error.diskChanged,
            changedPaths: error.changedPaths,
            cleanupComplete: error.cleanupComplete,
          }
        : {
            status: 'failed',
            message: `安全写入没有完整完成：${failureMessage(error)}`,
            diskChanged: replaced,
            changedPaths: replaced ? [request.relativePath] : [],
            cleanupComplete: true,
          };
  }

  const cleanupFailures: string[] = [];
  const residualPaths = new Set<string>(outcome.changedPaths);
  if (stagingRoot !== undefined && stagingCreated) {
    try {
      (dependencies.cleanupStaging ??
        ((path: string) => rmSync(path, { recursive: true, force: true })))(
        stagingRoot,
      );
    } catch (error) {
      cleanupFailures.push(`临时目录清理失败：${failureMessage(error)}`);
      residualPaths.add(stagingRelative);
    }
  }
  try {
    (dependencies.cleanupLock ?? releaseWorkspaceLock)(lock.path, token);
  } catch (error) {
    cleanupFailures.push(`写入锁清理失败：${failureMessage(error)}`);
    if (existsSync(lock.path)) residualPaths.add(WORKSPACE_WRITE_LOCK);
  } finally {
    activeLockTokens.delete(token);
  }

  if (cleanupFailures.length > 0) {
    const baseMessage =
      outcome.status === 'failed'
        ? outcome.message
        : outcome.status === 'conflict'
          ? '源文件 revision 已变化，没有替换 canonical 文件'
          : outcome.status === 'verified'
            ? 'canonical 文件 revision 已验证且无需替换'
            : 'canonical 文件已原子替换并完成耐久同步';
    return {
      status: 'failed',
      message: `${baseMessage}；${cleanupFailures.join('；')}`,
      diskChanged: replaced || residualPaths.size > 0,
      changedPaths: [...residualPaths],
      cleanupComplete: false,
    };
  }

  return outcome;
}

function validateCreateFiles(
  documentRelativePath: string,
  files: readonly AtomicDocumentCreateFile[],
): string | undefined {
  const seen = new Set<string>();
  for (const file of files) {
    if (
      file.relativePath.length === 0 ||
      file.relativePath === documentRelativePath ||
      file.relativePath === WORKSPACE_WRITE_LOCK ||
      file.relativePath.startsWith(DOCUMENT_STAGING_PREFIX) ||
      file.relativePath.startsWith(LOCK_PREPARE_PREFIX) ||
      file.relativePath.startsWith(LOCK_RECLAIM_PREFIX)
    ) {
      return `新增文件目标无效：${file.relativePath}`;
    }
    if (seen.has(file.relativePath)) {
      return `新增文件目标重复：${file.relativePath}`;
    }
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      return `新增文件权限无效：${file.relativePath}`;
    }
    seen.add(file.relativePath);
  }
  return undefined;
}

function createAuthorizedParents(
  authorization: AuthorizedRoot,
  targetPath: string,
  createdDirectories: string[],
): void {
  const parentRelative = relative(
    authorization.canonicalPath,
    dirname(targetPath),
  );
  if (parentRelative === "") return;
  let cursor = "";
  for (const segment of parentRelative.split(sep)) {
    cursor = cursor.length === 0 ? segment : join(cursor, segment);
    const path = resolveAuthorizedPath(authorization, cursor);
    if (existsSync(path)) {
      if (!lstatSync(path).isDirectory()) {
        throw new Error(`新增文件的父级不是目录：${cursor}`);
      }
      continue;
    }
    mkdirSync(path, { mode: 0o700 });
    createdDirectories.push(cursor);
  }
}

/**
 * Commits a canonical document plus exclusive-create scaffold files under one
 * existing workspace-wide lock. It deliberately does not support update or
 * deletion of auxiliary files: those objects remain user-owned unless a
 * separate, explicit object-level Trash action is confirmed.
 */
export function commitAuthorizedDocumentAndFiles(
  request: AtomicDocumentAndFilesCommitRequest,
  dependencies: AtomicDocumentAndFilesCommitDependencies = {},
): AtomicDocumentAndFilesCommitResult {
  if (request.createFiles.length === 0) {
    const result = commitAuthorizedDocument(request, dependencies);
    return {
      ...result,
      transaction: {
        canonical:
          result.status === "committed"
            ? "committed"
            : result.status === "failed" && result.diskChanged
              ? "uncertain"
              : "unchanged",
        scaffolds: "none",
        cleanupComplete: result.cleanupComplete,
      },
    };
  }
  const invalidFiles = validateCreateFiles(
    request.relativePath,
    request.createFiles,
  );
  if (invalidFiles !== undefined) {
    return {
      status: "failed",
      message: invalidFiles,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
      transaction: {
        canonical: "unchanged",
        scaffolds: "none",
        cleanupComplete: true,
      },
    };
  }

  let authorization: AuthorizedRoot;
  try {
    authorization = authorizeExistingDirectory(request.directory);
  } catch (error) {
    return {
      status: "failed",
      message: `无法获得写入授权：${failureMessage(error)}`,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
      transaction: {
        canonical: "unchanged",
        scaffolds: "none",
        cleanupComplete: true,
      },
    };
  }

  const token = (dependencies.createToken ?? randomUUID)();
  const lock = acquireWorkspaceLock(
    authorization.canonicalPath,
    token,
    (dependencies.now ?? (() => new Date()))(),
    dependencies.isProcessAlive ?? defaultProcessAlive,
    dependencies.beforeLockSync,
    dependencies.afterReclaimLink,
  );
  if (lock.status === "failed") {
    return {
      ...lock,
      transaction: {
        canonical: "unchanged",
        scaffolds: "none",
        cleanupComplete: lock.cleanupComplete,
      },
    };
  }
  if (lock.status === "busy") {
    return {
      status: "busy",
      message: "这个 Marketplace 正在执行另一项写入；请等待完成后重试。",
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
      transaction: {
        canonical: "unchanged",
        scaffolds: "none",
        cleanupComplete: true,
      },
    };
  }

  const stagingRelative = `${DOCUMENT_STAGING_PREFIX}${token}`;
  let stagingRoot: string | undefined;
  let stagingCreated = false;
  let targetPath: string | undefined;
  let backupPath: string | undefined;
  let documentReplaced = false;
  const createdFiles: Array<{ relativePath: string; path: string }> = [];
  const createdDirectories: string[] = [];
  let outcome: AtomicDocumentCommitResult;
  let transactionCanonical: AtomicDocumentAndFilesTransactionFacts["canonical"] =
    "unchanged";
  let transactionScaffolds: AtomicDocumentAndFilesTransactionFacts["scaffolds"] =
    "none";

  try {
    dependencies.afterLock?.();
    cleanupAbandonedPrepareFiles(
      authorization.canonicalPath,
      token,
      dependencies.isProcessAlive ?? defaultProcessAlive,
    );
    targetPath = resolveAuthorizedPath(authorization, request.relativePath);
    const initialBytes = readRegularFile(targetPath);
    const initialMode = lstatSync(targetPath).mode & 0o777;
    const currentRevision = documentRevision(initialBytes);
    if (currentRevision !== request.expectedRevision) {
      outcome = {
        status: "conflict",
        currentRevision,
        diskChanged: false,
        changedPaths: [],
        cleanupComplete: true,
      };
    } else {
      const targets = request.createFiles.map((file) => ({
        file,
        path: resolveAuthorizedPath(authorization, file.relativePath),
      }));
      const occupied = targets.find(({ path }) => existsSync(path));
      if (occupied !== undefined) {
        throw new Error(
          `新增文件已经存在，未覆盖：${occupied.file.relativePath}`,
        );
      }

      stagingRoot = resolveAuthorizedPath(authorization, stagingRelative);
      mkdirSync(stagingRoot, { mode: 0o700 });
      stagingCreated = true;
      const nextPath = join(stagingRoot, "document.next");
      backupPath = join(stagingRoot, "document.previous");
      dependencies.beforeStageWrite?.(nextPath);
      writeFileSync(nextPath, request.nextBytes, { flag: "wx", mode: 0o600 });
      chmodSync(nextPath, initialMode);
      (dependencies.syncStagedFile ?? syncFile)(nextPath);
      writeFileSync(backupPath, initialBytes, { flag: "wx", mode: 0o600 });
      chmodSync(backupPath, initialMode);
      (dependencies.syncStagedFile ?? syncFile)(backupPath);

      const stagedFiles = targets.map(({ file, path }, index) => {
        const stagedPath = join(stagingRoot!, `create-${index}`);
        writeFileSync(stagedPath, file.bytes, { flag: "wx", mode: 0o600 });
        chmodSync(stagedPath, file.mode);
        (dependencies.syncStagedFile ?? syncFile)(stagedPath);
        return { file, path, stagedPath };
      });
      dependencies.afterStageWrite?.(nextPath);

      dependencies.beforeRevisionRecheck?.(targetPath);
      const precommitRevision = documentRevision(readRegularFile(targetPath));
      if (precommitRevision !== request.expectedRevision) {
        outcome = {
          status: "conflict",
          currentRevision: precommitRevision,
          diskChanged: false,
          changedPaths: [],
          cleanupComplete: true,
        };
      } else {
        for (const entry of stagedFiles) {
          const resolvedAgain = resolveAuthorizedPath(
            authorization,
            entry.file.relativePath,
          );
          if (resolvedAgain !== entry.path || existsSync(resolvedAgain)) {
            throw new Error(
              `新增文件在提交前发生变化，未覆盖：${entry.file.relativePath}`,
            );
          }
        }
        for (const entry of stagedFiles) {
          createAuthorizedParents(
            authorization,
            entry.path,
            createdDirectories,
          );
          dependencies.beforeCreateFile?.(entry.stagedPath, entry.path);
          (dependencies.createFile ??
            ((source: string, target: string) =>
              copyFileSync(source, target, fsConstants.COPYFILE_EXCL)))(
            entry.stagedPath,
            entry.path,
          );
          chmodSync(entry.path, entry.file.mode);
          (dependencies.syncStagedFile ?? syncFile)(entry.path);
          createdFiles.push({
            relativePath: entry.file.relativePath,
            path: entry.path,
          });
        }
        (dependencies.replaceDocument ?? renameSync)(nextPath, targetPath);
        documentReplaced = true;
        const syncDirectory =
          dependencies.syncParentDirectory ??
          ((directory: string) => syncFile(directory));
        const parents = new Set<string>([
          authorization.canonicalPath,
          dirname(targetPath),
          ...createdFiles.map((entry) => dirname(entry.path)),
        ]);
        for (const parent of parents) syncDirectory(parent);
        dependencies.afterReplace?.(targetPath);
        transactionCanonical = "committed";
        transactionScaffolds = "committed";
        outcome = {
          status: "committed",
          revision: documentRevision(request.nextBytes),
          diskChanged: true,
          changedPaths: [
            request.relativePath,
            ...createdFiles.map((entry) => entry.relativePath),
          ],
          cleanupComplete: true,
        };
      }
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    const documentWasReplaced = documentReplaced;
    let documentRestored = false;
    if (
      documentReplaced &&
      backupPath !== undefined &&
      targetPath !== undefined
    ) {
      try {
        (dependencies.rollbackDocument ?? renameSync)(backupPath, targetPath);
        documentReplaced = false;
        documentRestored = true;
      } catch (rollbackError) {
        rollbackFailures.push(
          `恢复插件声明失败：${failureMessage(rollbackError)}`,
        );
      }
    }
    for (const entry of [...createdFiles].reverse()) {
      if (!existsSync(entry.path)) continue;
      try {
        (dependencies.rollbackFile ?? unlinkSync)(entry.path);
      } catch (rollbackError) {
        rollbackFailures.push(
          `回滚新增文件失败（${entry.relativePath}）：${failureMessage(rollbackError)}`,
        );
      }
    }
    for (const directoryRelative of [...createdDirectories].reverse()) {
      const path = resolveAuthorizedPath(authorization, directoryRelative);
      if (!existsSync(path)) continue;
      try {
        rmdirSync(path);
      } catch (rollbackError) {
        rollbackFailures.push(
          `回滚新增目录失败（${directoryRelative}）：${failureMessage(rollbackError)}`,
        );
      }
    }
    if (documentRestored && targetPath !== undefined) {
      try {
        const syncDirectory =
          dependencies.syncParentDirectory ??
          ((directory: string) => syncFile(directory));
        syncDirectory(dirname(targetPath));
        syncDirectory(authorization.canonicalPath);
      } catch (rollbackSyncError) {
        rollbackFailures.push(
          `恢复后的声明未能确认耐久同步：${failureMessage(rollbackSyncError)}`,
        );
      }
    }
    const residual = [
      ...(documentReplaced ? [request.relativePath] : []),
      ...createdFiles
        .filter((entry) => existsSync(entry.path))
        .map((entry) => entry.relativePath),
    ];
    transactionCanonical = documentWasReplaced
      ? documentRestored && rollbackFailures.length === 0
        ? "restored"
        : "uncertain"
      : "unchanged";
    transactionScaffolds =
      createdFiles.length === 0
        ? "none"
        : residual.some((path) =>
              createdFiles.some((entry) => entry.relativePath === path),
            )
          ? "residual"
          : "rolled-back";
    if (
      transactionCanonical === "uncertain" &&
      !residual.includes(request.relativePath)
    ) {
      residual.unshift(request.relativePath);
    }
    outcome = {
      status: "failed",
      message: [
        `组件变更没有完整提交：${failureMessage(error)}`,
        ...rollbackFailures,
      ].join("；"),
      diskChanged: residual.length > 0,
      changedPaths: residual,
      cleanupComplete: rollbackFailures.length === 0,
    };
  }

  const cleanupFailures: string[] = [];
  const residualPaths = new Set(outcome.changedPaths);
  if (stagingRoot !== undefined && stagingCreated) {
    try {
      (dependencies.cleanupStaging ??
        ((path: string) => rmSync(path, { recursive: true, force: true })))(
        stagingRoot,
      );
    } catch (error) {
      cleanupFailures.push(`临时目录清理失败：${failureMessage(error)}`);
      residualPaths.add(stagingRelative);
    }
  }
  try {
    (dependencies.cleanupLock ?? releaseWorkspaceLock)(lock.path, token);
  } catch (error) {
    cleanupFailures.push(`写入锁清理失败：${failureMessage(error)}`);
    if (existsSync(lock.path)) residualPaths.add(WORKSPACE_WRITE_LOCK);
  } finally {
    activeLockTokens.delete(token);
  }
  if (cleanupFailures.length > 0) {
    return {
      status: "failed",
      message: `${
        outcome.status === "failed"
          ? outcome.message
          : outcome.status === "conflict"
            ? "源文件 revision 已变化，没有提交组件变更"
            : "组件声明和必要文件已提交"
      }；${cleanupFailures.join("；")}`,
      diskChanged: outcome.diskChanged || residualPaths.size > 0,
      changedPaths: [...residualPaths],
      cleanupComplete: false,
      transaction: {
        canonical: transactionCanonical,
        scaffolds: transactionScaffolds,
        cleanupComplete: false,
      },
    };
  }
  return {
    ...outcome,
    transaction: {
      canonical: transactionCanonical,
      scaffolds: transactionScaffolds,
      cleanupComplete: outcome.cleanupComplete,
    },
  };
}

function validArtifactRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== "." &&
    relativePath !== ".." &&
    !isAbsolute(relativePath) &&
    relativePath !== WORKSPACE_WRITE_LOCK &&
    !relativePath.startsWith(DOCUMENT_STAGING_PREFIX) &&
    !relativePath.startsWith(LOCK_PREPARE_PREFIX) &&
    !relativePath.startsWith(LOCK_RECLAIM_PREFIX)
  );
}

function artifactRevisionAt(
  authorization: AuthorizedRoot,
  relativePath: string,
): string | "missing" {
  const path = resolveAuthorizedPath(authorization, relativePath);
  if (!existsSync(path)) return "missing";
  return documentRevision(readRegularFile(path));
}

/**
 * Commits one generated-artifact consistency group under the same
 * workspace-wide lock used by canonical document writes. All bytes and
 * deletions are staged before the first canonical mutation. A failure rolls
 * already-applied members back from private backups; callers must treat any
 * cleanup uncertainty as failure rather than declaring the group successful.
 */
export function commitAuthorizedArtifactGroup(
  request: AtomicArtifactGroupCommitRequest,
  dependencies: AtomicArtifactGroupCommitDependencies = {},
): AtomicArtifactGroupCommitResult {
  const paths = [
    ...request.expectations.map((item) => item.relativePath),
    ...request.mutations.map((item) => item.relativePath),
  ];
  if (
    request.mutations.length === 0 ||
    paths.some((path) => !validArtifactRelativePath(path)) ||
    new Set(request.mutations.map((item) => item.relativePath)).size !==
      request.mutations.length ||
    new Set(request.expectations.map((item) => item.relativePath)).size !==
      request.expectations.length
  ) {
    return {
      status: "failed",
      message: "生成物提交计划包含空、重复、保留或越界目标。",
      changedPaths: [],
      diskChanged: false,
      rolledBack: false,
      cleanupComplete: true,
    };
  }

  let authorization: AuthorizedRoot;
  try {
    authorization = authorizeExistingDirectory(request.directory);
    for (const path of paths) resolveAuthorizedPath(authorization, path);
  } catch (error) {
    return {
      status: "failed",
      message: `无法获得生成物写入授权：${failureMessage(error)}`,
      changedPaths: [],
      diskChanged: false,
      rolledBack: false,
      cleanupComplete: true,
    };
  }

  const token = (dependencies.createToken ?? randomUUID)();
  const lock = acquireWorkspaceLock(
    authorization.canonicalPath,
    token,
    (dependencies.now ?? (() => new Date()))(),
    dependencies.isProcessAlive ?? defaultProcessAlive,
    dependencies.beforeLockSync,
    dependencies.afterReclaimLink,
  );
  if (lock.status === "failed") {
    return { ...lock, rolledBack: false };
  }
  if (lock.status === "busy") {
    return {
      status: "busy",
      message: "这个 Marketplace 正在执行另一项写入；生成物没有在后台排队。",
      changedPaths: [],
      diskChanged: false,
      rolledBack: false,
      cleanupComplete: true,
    };
  }

  const stagingRelative = `${DOCUMENT_STAGING_PREFIX}${token}`;
  const stagingRoot = resolveAuthorizedPath(authorization, stagingRelative);
  const staged = new Map<string, string>();
  const backups = new Map<string, string>();
  const createdDirectories: string[] = [];
  const applied: string[] = [];
  const finalizationFailures: string[] = [];
  let stagingCreated = false;
  let rollbackAttempted = false;
  let rollbackConfirmed = false;
  let outcome: AtomicArtifactGroupCommitResult;

  try {
    cleanupAbandonedPrepareFiles(
      authorization.canonicalPath,
      token,
      dependencies.isProcessAlive ?? defaultProcessAlive,
    );
    for (const expectation of request.expectations) {
      if (
        artifactRevisionAt(authorization, expectation.relativePath) !==
        expectation.revision
      ) {
        outcome = {
          status: "conflict",
          message:
            "生成计划建立后 canonical source 或目标生成物已变化；没有提交旧快照。",
          changedPaths: [],
          diskChanged: false,
          rolledBack: false,
          cleanupComplete: true,
        };
        throw new ArtifactGroupOutcome(outcome);
      }
    }

    const unchanged = request.mutations.every((mutation) => {
      const target = resolveAuthorizedPath(
        authorization,
        mutation.relativePath,
      );
      if (mutation.action === "delete") return !existsSync(target);
      return (
        existsSync(target) &&
        lstatSync(target).isFile() &&
        Buffer.from(mutation.bytes).equals(readFileSync(target))
      );
    });
    if (unchanged) {
      outcome = {
        status: "verified",
        changedPaths: [],
        diskChanged: false,
        rolledBack: false,
        cleanupComplete: true,
      };
      throw new ArtifactGroupOutcome(outcome);
    }

    mkdirSync(stagingRoot, { mode: 0o700 });
    stagingCreated = true;
    request.mutations.forEach((mutation, index) => {
      if (mutation.action !== "write") return;
      const path = join(stagingRoot, `next-${index}`);
      writeFileSync(path, mutation.bytes, { mode: mutation.mode ?? 0o600 });
      syncFile(path);
      staged.set(mutation.relativePath, path);
    });

    request.mutations.forEach((mutation, index) => {
      const target = resolveAuthorizedPath(
        authorization,
        mutation.relativePath,
      );
      if (existsSync(target)) {
        if (!lstatSync(target).isFile()) {
          throw new Error(`生成物目标不是普通文件：${mutation.relativePath}`);
        }
        const backup = join(stagingRoot, `before-${index}`);
        copyFileSync(target, backup);
        chmodSync(backup, lstatSync(target).mode & 0o777);
        syncFile(backup);
        backups.set(mutation.relativePath, backup);
      }
    });

    for (const mutation of request.mutations) {
      const target = resolveAuthorizedPath(
        authorization,
        mutation.relativePath,
      );
      if (mutation.action === "delete" && !existsSync(target)) {
        continue;
      }
      dependencies.beforeMutation?.(mutation.relativePath);
      const backup = backups.get(mutation.relativePath);
      if (backup !== undefined && existsSync(target)) {
        unlinkSync(target);
        applied.push(mutation.relativePath);
      }
      if (mutation.action === "write") {
        createAuthorizedParents(authorization, target, createdDirectories);
        (dependencies.replaceArtifact ?? renameSync)(
          staged.get(mutation.relativePath)!,
          target,
        );
        if (!applied.includes(mutation.relativePath)) {
          applied.push(mutation.relativePath);
        }
        chmodSync(target, mutation.mode ?? 0o644);
      }
      syncFile(dirname(target));
    }

    outcome = {
      status: "committed",
      changedPaths: [...applied],
      diskChanged: applied.length > 0,
      rolledBack: false,
      cleanupComplete: true,
    };
  } catch (error) {
    if (error instanceof ArtifactGroupOutcome) {
      outcome = error.outcome;
    } else {
      rollbackAttempted = true;
      const rollbackFailures: string[] = [];
      for (const relativePath of [...applied].reverse()) {
        const target = resolveAuthorizedPath(authorization, relativePath);
        const backup = backups.get(relativePath);
        try {
          dependencies.beforeRollback?.(relativePath);
          if (existsSync(target)) unlinkSync(target);
          if (backup !== undefined && existsSync(backup)) {
            renameSync(backup, target);
          }
          syncFile(dirname(target));
        } catch (rollbackError) {
          rollbackFailures.push(
            `${relativePath}: ${failureMessage(rollbackError)}`,
          );
        }
      }
      for (const relativeDirectory of [...createdDirectories].reverse()) {
        const path = resolveAuthorizedPath(authorization, relativeDirectory);
        try {
          if (existsSync(path) && readdirSync(path).length === 0) {
            (dependencies.removeCreatedDirectory ??
              ((targetPath: string) => rmdirSync(targetPath)))(
              path,
              relativeDirectory,
            );
          }
        } catch (cleanupError) {
          finalizationFailures.push(
            `${relativeDirectory}: ${failureMessage(cleanupError)}`,
          );
        }
      }
      rollbackConfirmed = rollbackFailures.length === 0;
      outcome = {
        status: "failed",
        message: [
          `生成物一致性组没有完整提交：${failureMessage(error)}`,
          ...rollbackFailures,
        ].join("；"),
        changedPaths: [],
        diskChanged: false,
        rolledBack: false,
        cleanupComplete: true,
      };
    }
  }

  if (stagingCreated) {
    try {
      (dependencies.cleanupStaging ??
        ((path: string) => rmSync(path, { recursive: true, force: true })))(
        stagingRoot,
      );
    } catch (error) {
      finalizationFailures.push(
        `临时目录清理失败：${failureMessage(error)}`,
      );
    }
  }
  try {
    (dependencies.cleanupLock ?? releaseWorkspaceLock)(lock.path, token);
  } catch (error) {
    finalizationFailures.push(
      `写入锁清理失败：${failureMessage(error)}`,
    );
  } finally {
    activeLockTokens.delete(token);
  }

  const expectationByPath = new Map(
    request.expectations.map((item) => [item.relativePath, item.revision]),
  );
  const canonicalResiduals = [...new Set(applied)].filter(
    (relativePath) => {
      const expected = expectationByPath.get(relativePath);
      if (expected === undefined) return true;
      try {
        return artifactRevisionAt(authorization, relativePath) !== expected;
      } catch {
        return true;
      }
    },
  );
  const transactionResiduals = [
    ...(rollbackAttempted
      ? createdDirectories.filter((relativePath) =>
          existsSync(resolveAuthorizedPath(authorization, relativePath)),
        )
      : []),
    ...(existsSync(stagingRoot) ? [stagingRelative] : []),
    ...(existsSync(lock.path) ? [WORKSPACE_WRITE_LOCK] : []),
  ];
  if (
    transactionResiduals.length > 0 &&
    finalizationFailures.length === 0
  ) {
    finalizationFailures.push("生成物事务仍有未清理的本机残留");
  }
  const reportedCanonicalPaths =
    outcome.status === "committed"
      ? [...new Set(applied)]
      : canonicalResiduals;
  const changedPaths = [
    ...reportedCanonicalPaths,
    ...transactionResiduals.filter(
      (path) => !reportedCanonicalPaths.includes(path),
    ),
  ];
  const cleanupComplete = transactionResiduals.length === 0;

  if (
    outcome.status === "failed" ||
    finalizationFailures.length > 0 ||
    !cleanupComplete
  ) {
    return {
      status: "failed",
      message: [
        outcome.status === "failed"
          ? outcome.message
          : "生成物 canonical 变更已结束",
        ...finalizationFailures,
      ].join("；"),
      changedPaths,
      diskChanged: changedPaths.length > 0,
      rolledBack:
        outcome.status === "failed" &&
        applied.length > 0 &&
        rollbackConfirmed &&
        canonicalResiduals.length === 0,
      cleanupComplete,
    };
  }
  if (outcome.status === "committed") {
    return {
      status: "committed",
      changedPaths: reportedCanonicalPaths,
      diskChanged: reportedCanonicalPaths.length > 0,
      rolledBack: false,
      cleanupComplete: true,
    };
  }
  return outcome;
}

class ArtifactGroupOutcome extends Error {
  readonly outcome: AtomicArtifactGroupCommitResult;

  constructor(outcome: AtomicArtifactGroupCommitResult) {
    super(outcome.status);
    this.name = "ArtifactGroupOutcome";
    this.outcome = outcome;
  }
}
