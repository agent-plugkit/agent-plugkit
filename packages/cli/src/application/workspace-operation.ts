import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AuthorizedPathError,
  authorizeExistingDirectory,
  resolveAuthorizedPath,
} from "../infrastructure/authorized-path.js";
import {
  scanWorkspaceHealth,
} from "./workspace-health.js";
import type {
  ScanWorkspaceHealthResult,
  WorkspaceHealthIssue,
  WorkspaceValidationDiagnostic,
} from "./workspace-health-contract.js";
import type {
  WorkspaceOperationDiagnostic,
  WorkspaceOperationIssue,
  WorkspaceOperationKind,
  WorkspaceOperationRecord,
  WorkspaceOperationStage,
  WorkspaceOperationTarget,
} from "./workspace-operation-contract.js";

export type WorkspaceOperationLeaseMode = "read" | "write";

export interface WorkspaceOperationLease {
  readonly mode: WorkspaceOperationLeaseMode;
  readonly ownerId: string;
  release(): void;
}

interface PendingLease {
  readonly mode: WorkspaceOperationLeaseMode;
  readonly ownerId: string;
  readonly resolve: (lease: WorkspaceOperationLease) => void;
}

interface WorkspaceLeaseState {
  readonly readers: Set<string>;
  writer?: string;
  readonly queue: PendingLease[];
}

export interface WorkspaceOperationCoordinationFact {
  readonly activeReaders: number;
  readonly activeWriter?: string;
  readonly queuedReaders: number;
  readonly queuedWriters: number;
}

/**
 * Operation-scoped coordination only. Existing editor revision/write guards
 * remain the authority for their document commits. Long-running build and release
 * operations acquire the write side without redefining those guards.
 */
export class WorkspaceOperationCoordinator {
  readonly #states = new Map<string, WorkspaceLeaseState>();

  acquire(
    workspaceId: string,
    mode: WorkspaceOperationLeaseMode,
    ownerId: string,
  ): Promise<WorkspaceOperationLease> {
    const state = this.#state(workspaceId);
    if (this.#canGrant(state, mode)) {
      return Promise.resolve(this.#grant(workspaceId, state, mode, ownerId));
    }
    return new Promise((resolve) => {
      state.queue.push({ mode, ownerId, resolve });
    });
  }

  tryAcquire(
    workspaceId: string,
    mode: WorkspaceOperationLeaseMode,
    ownerId: string,
  ): WorkspaceOperationLease | undefined {
    const state = this.#state(workspaceId);
    if (!this.#canGrant(state, mode)) {
      if (
        state.writer === undefined &&
        state.readers.size === 0 &&
        state.queue.length === 0
      ) {
        this.#states.delete(workspaceId);
      }
      return undefined;
    }
    return this.#grant(workspaceId, state, mode, ownerId);
  }

  describe(workspaceId: string): WorkspaceOperationCoordinationFact {
    const state = this.#states.get(workspaceId);
    return {
      activeReaders: state?.readers.size ?? 0,
      ...(state?.writer === undefined ? {} : { activeWriter: state.writer }),
      queuedReaders:
        state?.queue.filter((request) => request.mode === "read").length ?? 0,
      queuedWriters:
        state?.queue.filter((request) => request.mode === "write").length ?? 0,
    };
  }

  #state(workspaceId: string): WorkspaceLeaseState {
    const current = this.#states.get(workspaceId);
    if (current !== undefined) return current;
    const created: WorkspaceLeaseState = {
      readers: new Set(),
      queue: [],
    };
    this.#states.set(workspaceId, created);
    return created;
  }

  #canGrant(
    state: WorkspaceLeaseState,
    mode: WorkspaceOperationLeaseMode,
  ): boolean {
    if (mode === "write") {
      return state.writer === undefined && state.readers.size === 0;
    }
    return (
      state.writer === undefined &&
      !state.queue.some((request) => request.mode === "write")
    );
  }

  #grant(
    workspaceId: string,
    state: WorkspaceLeaseState,
    mode: WorkspaceOperationLeaseMode,
    ownerId: string,
  ): WorkspaceOperationLease {
    if (mode === "write") state.writer = ownerId;
    else state.readers.add(ownerId);
    let released = false;
    return Object.freeze({
      mode,
      ownerId,
      release: () => {
        if (released) return;
        released = true;
        if (mode === "write" && state.writer === ownerId) {
          state.writer = undefined;
        } else {
          state.readers.delete(ownerId);
        }
        this.#drain(workspaceId, state);
      },
    });
  }

  #drain(workspaceId: string, state: WorkspaceLeaseState): void {
    if (state.writer !== undefined || state.readers.size > 0) return;
    const first = state.queue.shift();
    if (first === undefined) {
      this.#states.delete(workspaceId);
      return;
    }
    if (first.mode === "write") {
      first.resolve(
        this.#grant(workspaceId, state, first.mode, first.ownerId),
      );
      return;
    }
    const reads = [first];
    while (state.queue[0]?.mode === "read") {
      reads.push(state.queue.shift()!);
    }
    for (const request of reads) {
      request.resolve(
        this.#grant(workspaceId, state, request.mode, request.ownerId),
      );
    }
  }
}

export interface RunWorkspaceOperationInput {
  readonly id: string;
  readonly kind: WorkspaceOperationKind;
  readonly workspaceDirectory: string;
  readonly workspaceLabel: string;
  readonly startedAt?: string;
}

export interface RunWorkspaceOperationDependencies {
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly onUpdate?: (record: WorkspaceOperationRecord) => void;
  readonly yieldToEventLoop?: () => Promise<void>;
  readonly beforeGeneratedRead?: (path: string) => void;
  readonly scan?: typeof scanWorkspaceHealth;
}

function iso(now: () => Date): string {
  return now().toISOString();
}

function duration(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

export function workspaceOperationIdForPath(canonicalPath: string): string {
  return `workspace:${createHash("sha256")
    .update(canonicalPath)
    .digest("hex")
    .slice(0, 32)}`;
}

function stage(
  id: string,
  label: string,
  targetIds: readonly string[],
): WorkspaceOperationStage {
  return {
    id,
    label,
    status: "pending",
    completedTargetIds: [],
    pendingTargetIds: [...targetIds],
  };
}

function sanitizeDiagnostic(
  text: string,
  workspaceDirectory: string,
): string {
  return text
    .replaceAll(workspaceDirectory, "[WORKSPACE]")
    .replace(
      /(?:^|\s)(?:\/(?:Users|Volumes|private|tmp|var|opt|Applications)\/[^\s:]+)/g,
      (match) => `${match.startsWith(" ") ? " " : ""}[LOCAL_PATH]`,
    )
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*)\s*=\s*[^\s]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|Bearer\s+\S+)/gi,
      "[REDACTED]",
    )
    .slice(0, 20_000);
}

function cloneRecord(
  record: WorkspaceOperationRecord,
): WorkspaceOperationRecord {
  return structuredClone(record);
}

function healthIssueForDiagnostic(
  scan: Extract<ScanWorkspaceHealthResult, { status: "scanned" }>,
  diagnostic: WorkspaceValidationDiagnostic,
): WorkspaceHealthIssue | undefined {
  const plugin = scan.snapshot.plugins.find(
    (candidate) =>
      candidate.directoryName === diagnostic.pluginDirectoryName,
  );
  if (plugin === undefined) return undefined;
  return scan.snapshot.issues.find((issue) => {
    if (issue.scope.pluginId !== plugin.id) return false;
    const detail = scan.snapshot.diagnostics.find(
      (candidate) => candidate.id === issue.diagnosticRef,
    );
    return detail?.code === diagnostic.code;
  });
}

function collectScanFacts(
  scan: Extract<ScanWorkspaceHealthResult, { status: "scanned" }>,
  kind: WorkspaceOperationKind,
  workspaceDirectory: string,
  targetId: string,
  counters: { issue: number; diagnostic: number },
): {
  readonly issues: readonly WorkspaceOperationIssue[];
  readonly diagnostics: readonly WorkspaceOperationDiagnostic[];
} {
  const sourceIssues =
    kind === "source-check"
      ? scan.snapshot.issues.filter(
          (issue) =>
            (issue.dimension === "source" ||
              issue.dimension === "reference") &&
            (targetId.startsWith("workspace:")
              ? issue.scope.pluginId === undefined
              : issue.scope.pluginId === targetId),
        )
      : [];
  const validationIssues =
    kind === "full-validate"
      ? scan.validationDiagnostics.map((diagnostic) => ({
          diagnostic,
          issue: healthIssueForDiagnostic(scan, diagnostic),
        }))
      : [];
  const diagnostics: WorkspaceOperationDiagnostic[] = [];
  const issues: WorkspaceOperationIssue[] = [];

  const append = (
    code: string,
    message: string,
    copy: {
      readonly severity: "blocking" | "attention";
      readonly title: string;
      readonly summary: string;
      readonly impact: string;
      readonly nextAction: string;
    },
  ) => {
    const diagnosticId = `diagnostic-${++counters.diagnostic}`;
    const issueId = `issue-${++counters.issue}`;
    diagnostics.push({
      id: diagnosticId,
      code,
      message: sanitizeDiagnostic(message, workspaceDirectory),
    });
    issues.push({
      id: issueId,
      code,
      severity: copy.severity,
      title: copy.title,
      summary: copy.summary,
      impact: copy.impact,
      nextAction: copy.nextAction,
      targetId,
      diagnosticRef: diagnosticId,
    });
  };

  for (const issue of sourceIssues) {
    const raw = scan.snapshot.diagnostics.find(
      (item) => item.id === issue.diagnosticRef,
    );
    append(raw?.code ?? "SOURCE_CHECK_ISSUE", raw?.message ?? issue.summary, {
      severity: issue.severity,
      title: issue.title,
      summary: issue.summary,
      impact: issue.impact,
      nextAction: issue.nextAction,
    });
  }
  for (const { diagnostic, issue } of validationIssues) {
    append(diagnostic.code, diagnostic.message, {
      severity: issue?.severity ?? "blocking",
      title: issue?.title ?? "完整验证发现不一致",
      summary:
        issue?.summary ??
        "这个插件的源声明与当前平台结果不一致。",
      impact:
        issue?.impact ??
        "当前平台结果不能被确认与 canonical source 一致。",
      nextAction:
        issue?.nextAction ??
        "请查看原始诊断并在修正或重新生成后再次验证。",
    });
  }
  return { issues, diagnostics };
}

function listOperationTargets(
  workspaceDirectory: string,
  kind: WorkspaceOperationKind,
): WorkspaceOperationTarget[] {
  const authorization = authorizeExistingDirectory(workspaceDirectory);
  let pluginsDirectory: string;
  try {
    pluginsDirectory = resolveAuthorizedPath(authorization, "plugins");
  } catch (error) {
    if (error instanceof AuthorizedPathError) return [];
    throw error;
  }
  if (
    !existsSync(pluginsDirectory) ||
    !lstatSync(pluginsDirectory).isDirectory()
  ) {
    return [];
  }
  return readdirSync(pluginsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter(
      (entry) =>
        kind === "source-check" ||
        existsSync(join(pluginsDirectory, entry.name, "plugin.yaml")),
    )
    .map((entry) => ({
      id: `plugin:${entry.name}`,
      kind: "plugin" as const,
      label: entry.name,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export async function runWorkspaceOperation(
  input: RunWorkspaceOperationInput,
  dependencies: RunWorkspaceOperationDependencies = {},
): Promise<WorkspaceOperationRecord> {
  const now = dependencies.now ?? (() => new Date());
  const yieldToEventLoop =
    dependencies.yieldToEventLoop ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const scan = dependencies.scan ?? scanWorkspaceHealth;
  const authorization = authorizeExistingDirectory(input.workspaceDirectory);
  const workspaceId = workspaceOperationIdForPath(authorization.canonicalPath);
  const workspaceTarget: WorkspaceOperationTarget = {
    id: workspaceId,
    kind: "workspace",
    label: input.workspaceLabel,
  };
  const startedAt = input.startedAt ?? iso(now);
  let record: WorkspaceOperationRecord = {
    schemaVersion: 1,
    id: input.id,
    kind: input.kind,
    access: "read",
    workspace: { id: workspaceId, label: input.workspaceLabel },
    targets: [workspaceTarget],
    stages: [
      stage("discover", "确认检查范围", [workspaceId]),
      stage(
        input.kind === "source-check" ? "source-check" : "full-validate",
        input.kind === "source-check"
          ? "检查源信息与本地内容"
          : "验证平台结果一致性",
        [],
      ),
      stage("summarize", "整理检查结果", [workspaceId]),
    ],
    status: "running",
    outcome: "pending",
    startedAt,
    updatedAt: startedAt,
    issues: [],
    diagnostics: [],
    cancel: { requested: false },
  };
  const emit = () => dependencies.onUpdate?.(cloneRecord(record));
  const replaceStage = (
    index: number,
    next: WorkspaceOperationStage,
  ): void => {
    const stages = [...record.stages];
    stages[index] = next;
    record = { ...record, stages, updatedAt: iso(now) };
    emit();
  };
  const failExecution = (
    error: unknown,
    stageIndex: number,
  ): WorkspaceOperationRecord => {
    const endedAt = iso(now);
    const failedStage = record.stages[stageIndex]!;
    const diagnosticId = `diagnostic-${record.diagnostics.length + 1}`;
    const issueId = `issue-${record.issues.length + 1}`;
    const message = sanitizeDiagnostic(
      error instanceof Error ? error.message : String(error),
      authorization.canonicalPath,
    );
    const stages = [...record.stages];
    stages[stageIndex] = {
      ...failedStage,
      status: "failed",
      endedAt,
      durationMs: failedStage.startedAt
        ? duration(failedStage.startedAt, endedAt)
        : 0,
    };
    record = {
      ...record,
      stages,
      status: "failed",
      outcome: "execution-failure",
      endedAt,
      durationMs: duration(startedAt, endedAt),
      updatedAt: endedAt,
      diagnostics: [
        ...record.diagnostics,
        { id: diagnosticId, code: "OPERATION_EXECUTION_FAILED", message },
      ],
      issues: [
        ...record.issues,
        {
          id: issueId,
          code: "OPERATION_EXECUTION_FAILED",
          severity: "blocking",
          title: "操作没有完整执行",
          summary: "检查过程中无法继续读取当前目标。",
          impact: "已完成阶段仍保留，但待执行阶段没有被声明为成功。",
          nextAction: "确认 Marketplace 仍可访问后重新运行。",
          targetId: record.targets[0]?.id,
          diagnosticRef: diagnosticId,
        },
      ],
    };
    emit();
    return record;
  };
  const cancelAtBoundary = (stageIndex: number): WorkspaceOperationRecord => {
    const endedAt = iso(now);
    const stages = record.stages.map((current, index) =>
      index >= stageIndex && current.status !== "completed"
        ? {
            ...current,
            status: "canceled" as const,
            ...(current.startedAt === undefined
              ? {}
              : {
                  endedAt,
                  durationMs: duration(current.startedAt, endedAt),
                }),
          }
        : current,
    );
    record = {
      ...record,
      stages,
      status: "canceled",
      outcome: "canceled",
      endedAt,
      durationMs: duration(startedAt, endedAt),
      updatedAt: endedAt,
      cancel: {
        requested: true,
        requestedAt: record.cancel.requestedAt ?? endedAt,
        effectiveAt: endedAt,
      },
    };
    emit();
    return record;
  };

  emit();
  const discoverStarted = iso(now);
  replaceStage(0, {
    ...record.stages[0]!,
    status: "running",
    startedAt: discoverStarted,
  });
  try {
    const pluginTargets = listOperationTargets(
      authorization.canonicalPath,
      input.kind,
    );
    const targets = [workspaceTarget, ...pluginTargets];
    const discoveryEnded = iso(now);
    record = {
      ...record,
      targets,
      stages: [
        {
          ...record.stages[0]!,
          status: "completed",
          endedAt: discoveryEnded,
          durationMs: duration(discoverStarted, discoveryEnded),
          completedTargetIds: [workspaceId],
          pendingTargetIds: [],
        },
        {
          ...record.stages[1]!,
          pendingTargetIds:
            input.kind === "source-check"
              ? targets.map((target) => target.id)
              : pluginTargets.map((target) => target.id),
        },
        record.stages[2]!,
      ],
      updatedAt: discoveryEnded,
    };
    emit();
  } catch (error) {
    return failExecution(error, 0);
  }

  await yieldToEventLoop();
  if (dependencies.signal?.aborted) return cancelAtBoundary(1);

  const checkingStarted = iso(now);
  replaceStage(1, {
    ...record.stages[1]!,
    status: "running",
    startedAt: checkingStarted,
  });
  const counters = { issue: 0, diagnostic: 0 };
  try {
    const pluginTargets = record.targets.filter(
      (target) => target.kind === "plugin",
    );
    if (input.kind === "full-validate" && pluginTargets.length === 0) {
      const diagnosticId = `diagnostic-${++counters.diagnostic}`;
      const issueId = `issue-${++counters.issue}`;
      record = {
        ...record,
        diagnostics: [
          ...record.diagnostics,
          {
            id: diagnosticId,
            code: "NO_PLUGIN_TARGETS",
            message: "完整验证没有找到可验证的 plugin.yaml。",
          },
        ],
        issues: [
          ...record.issues,
          {
            id: issueId,
            code: "NO_PLUGIN_TARGETS",
            severity: "blocking",
            title: "没有可验证的插件",
            summary: "当前 Marketplace 没有包含 plugin.yaml 的插件目标。",
            impact: "完整验证不能声明为通过。",
            nextAction: "先创建或导入至少一个插件，再重新运行完整验证。",
            targetId: workspaceId,
            diagnosticRef: diagnosticId,
          },
        ],
        updatedAt: iso(now),
      };
      emit();
    }
    const checkingTargets =
      input.kind === "source-check"
        ? [workspaceTarget, ...pluginTargets]
        : pluginTargets;
    for (const target of checkingTargets) {
      if (dependencies.signal?.aborted) return cancelAtBoundary(1);
      const result = scan(
        {
          directory: authorization.canonicalPath,
          ...(target.kind === "workspace"
            ? { workspaceOnly: true }
            : { pluginNames: [target.label] }),
          scope:
            input.kind === "source-check"
              ? "source-and-references"
              : "full",
        },
        {
          beforeGeneratedRead: dependencies.beforeGeneratedRead,
        },
      );
      if (result.status === "unavailable") {
        throw new Error(result.error.technicalDetail ?? result.error.message);
      }
      const facts = collectScanFacts(
        result,
        input.kind,
        authorization.canonicalPath,
        target.id,
        counters,
      );
      const current = record.stages[1]!;
      const completedTargetIds = [...current.completedTargetIds, target.id];
      record = {
        ...record,
        issues: [...record.issues, ...facts.issues],
        diagnostics: [...record.diagnostics, ...facts.diagnostics],
        stages: record.stages.map((candidate, index) =>
          index === 1
            ? {
                ...candidate,
                completedTargetIds,
                pendingTargetIds: candidate.pendingTargetIds.filter(
                  (id) => id !== target.id,
                ),
              }
            : candidate,
        ),
        updatedAt: iso(now),
      };
      emit();
      await yieldToEventLoop();
    }
    const checkingEnded = iso(now);
    replaceStage(1, {
      ...record.stages[1]!,
      status: "completed",
      endedAt: checkingEnded,
      durationMs: duration(checkingStarted, checkingEnded),
    });
  } catch (error) {
    return failExecution(error, 1);
  }

  if (dependencies.signal?.aborted) return cancelAtBoundary(2);
  await yieldToEventLoop();
  if (dependencies.signal?.aborted) return cancelAtBoundary(2);
  const summaryStarted = iso(now);
  replaceStage(2, {
    ...record.stages[2]!,
    status: "running",
    startedAt: summaryStarted,
  });
  const endedAt = iso(now);
  const hasIssues = record.issues.length > 0;
  record = {
    ...record,
    stages: record.stages.map((current, index) =>
      index === 2
        ? {
            ...current,
            status: "completed",
            endedAt,
            durationMs: duration(summaryStarted, endedAt),
            completedTargetIds: [workspaceId],
            pendingTargetIds: [],
          }
        : current,
    ),
    status: hasIssues ? "failed" : "success",
    outcome: hasIssues ? "validation-issues" : "passed",
    endedAt,
    durationMs: duration(startedAt, endedAt),
    updatedAt: endedAt,
  };
  emit();
  return record;
}
