import type {
  ArtifactFreshness,
  ArtifactPlatform,
  ArtifactType,
} from "./artifact-generation.js";

export type WorkspaceOperationKind =
  | "source-check"
  | "full-validate"
  | "plugin-build"
  | "marketplace-index"
  | "generate-and-validate"
  | "local-release";
export type WorkspaceOperationAccess = "read" | "write";
export type WorkspaceOperationStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "canceled";
export type WorkspaceOperationOutcome =
  | "pending"
  | "passed"
  | "validation-issues"
  | "execution-failure"
  | "canceled"
  | "interrupted";
export type WorkspaceOperationStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export interface WorkspaceOperationTarget {
  readonly id: string;
  readonly kind: "workspace" | "plugin";
  readonly label: string;
}

export interface WorkspaceOperationStage {
  readonly id: string;
  readonly label: string;
  readonly status: WorkspaceOperationStageStatus;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly completedTargetIds: readonly string[];
  readonly pendingTargetIds: readonly string[];
}

export interface WorkspaceOperationIssue {
  readonly id: string;
  readonly code: string;
  readonly severity: "blocking" | "attention";
  readonly title: string;
  readonly summary: string;
  readonly impact: string;
  readonly nextAction: string;
  readonly targetId?: string;
  readonly diagnosticRef: string;
}

export interface WorkspaceOperationDiagnostic {
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

export interface WorkspaceGenerationOperationArtifact {
  readonly id: string;
  readonly source: {
    readonly kind: "plugin" | "marketplace";
    readonly id: string;
    readonly label: string;
  };
  readonly platform: ArtifactPlatform;
  readonly type: ArtifactType;
  readonly relativePath: string;
  /** Point-in-time freshness when this operation record was updated. */
  readonly freshness: ArtifactFreshness;
}

export interface WorkspaceReleaseOperationArtifact {
  readonly kind: "release";
  readonly id: string;
  readonly type:
    | "release-directory"
    | "release-manifest"
    | "release-archive";
  readonly objectType: "file" | "directory";
  readonly relativePath: string;
  readonly pluginCount: number;
  readonly createdAtCompletion: true;
}

export type WorkspaceOperationArtifact =
  | WorkspaceGenerationOperationArtifact
  | WorkspaceReleaseOperationArtifact;

export interface WorkspaceLocalReleaseFacts {
  readonly pluginCount: number;
  readonly releaseDirectory: "unchanged" | "committed" | "uncertain";
  readonly archive: "not-created" | "created" | "uncertain";
  readonly changedPaths: readonly string[];
  readonly canonicalPaths: readonly string[];
  readonly createdParentPaths: readonly string[];
  readonly residuePaths: readonly string[];
  readonly diskChanged: boolean;
  readonly cleanupComplete: boolean;
}

export interface WorkspaceOperationRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: WorkspaceOperationKind;
  readonly access: WorkspaceOperationAccess;
  readonly workspace: {
    readonly id: string;
    readonly label: string;
  };
  readonly targets: readonly WorkspaceOperationTarget[];
  readonly stages: readonly WorkspaceOperationStage[];
  readonly status: WorkspaceOperationStatus;
  readonly outcome: WorkspaceOperationOutcome;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly issues: readonly WorkspaceOperationIssue[];
  readonly diagnostics: readonly WorkspaceOperationDiagnostic[];
  readonly artifacts?: readonly WorkspaceOperationArtifact[];
  readonly release?: WorkspaceLocalReleaseFacts;
  readonly cancel: {
    readonly requested: boolean;
    readonly requestedAt?: string;
    readonly effectiveAt?: string;
  };
}

const MAX_RECORD_JSON = 512_000;
const MAX_TARGETS = 2_001;
const MAX_STAGES = 32;
const MAX_ISSUES = 4_000;
const MAX_DIAGNOSTICS = 4_000;
const MAX_ARTIFACTS = 8_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => allowed.has(key))
  );
}

function boundedString(
  value: unknown,
  maximum = 2_000,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum
  );
}

function timestamp(value: unknown): value is string {
  return (
    boundedString(value, 64) &&
    !Number.isNaN(Date.parse(value))
  );
}

function uuid(value: unknown): value is string {
  return (
    boundedString(value, 36) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function duration(value: unknown): value is number {
  return Number.isFinite(value) && Number(value) >= 0;
}

function uniqueStrings(
  value: unknown,
  maximum = MAX_TARGETS,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((entry) => boundedString(entry, 200)) &&
    new Set(value).size === value.length
  );
}

function isTarget(value: unknown): value is WorkspaceOperationTarget {
  return (
    isObject(value) &&
    exactKeys(value, ["id", "kind", "label"]) &&
    boundedString(value.id, 200) &&
    (value.kind === "workspace" || value.kind === "plugin") &&
    boundedString(value.label, 240)
  );
}

function isStage(value: unknown): value is WorkspaceOperationStage {
  return (
    isObject(value) &&
    exactKeys(
      value,
      ["id", "label", "status", "completedTargetIds", "pendingTargetIds"],
      ["startedAt", "endedAt", "durationMs"],
    ) &&
    boundedString(value.id, 120) &&
    boundedString(value.label, 240) &&
    new Set(["pending", "running", "completed", "failed", "canceled"]).has(
      String(value.status),
    ) &&
    (value.startedAt === undefined || timestamp(value.startedAt)) &&
    (value.endedAt === undefined || timestamp(value.endedAt)) &&
    (value.durationMs === undefined || duration(value.durationMs)) &&
    uniqueStrings(value.completedTargetIds) &&
    uniqueStrings(value.pendingTargetIds)
  );
}

function isIssue(value: unknown): value is WorkspaceOperationIssue {
  return (
    isObject(value) &&
    exactKeys(
      value,
      [
        "id",
        "code",
        "severity",
        "title",
        "summary",
        "impact",
        "nextAction",
        "diagnosticRef",
      ],
      ["targetId"],
    ) &&
    boundedString(value.id, 200) &&
    boundedString(value.code, 200) &&
    (value.severity === "blocking" || value.severity === "attention") &&
    boundedString(value.title, 500) &&
    boundedString(value.summary, 4_000) &&
    boundedString(value.impact, 4_000) &&
    boundedString(value.nextAction, 4_000) &&
    (value.targetId === undefined || boundedString(value.targetId, 200)) &&
    boundedString(value.diagnosticRef, 200)
  );
}

function isDiagnostic(
  value: unknown,
): value is WorkspaceOperationDiagnostic {
  return (
    isObject(value) &&
    exactKeys(value, ["id", "code", "message"]) &&
    boundedString(value.id, 200) &&
    boundedString(value.code, 200) &&
    boundedString(value.message, 20_000)
  );
}

function safeRelativePath(value: unknown): value is string {
  return (
    boundedString(value, 1_000) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === ".." || segment === "")
  );
}

function isGenerationArtifact(
  value: unknown,
): value is WorkspaceGenerationOperationArtifact {
  if (!isObject(value) || !isObject(value.source)) return false;
  return (
    exactKeys(
      value,
      [
        "id",
        "source",
        "platform",
        "type",
        "relativePath",
        "freshness",
      ],
    ) &&
    typeof value.id === "string" &&
    /^[0-9a-f]{64}$/i.test(value.id) &&
    exactKeys(value.source, ["kind", "id", "label"]) &&
    (value.source.kind === "plugin" ||
      value.source.kind === "marketplace") &&
    boundedString(value.source.id, 200) &&
    boundedString(value.source.label, 240) &&
    new Set([
      "agent-plugins",
      "claude-code",
      "codex",
      "cursor",
      "github-copilot",
      "shared",
    ]).has(
      String(value.platform),
    ) &&
    new Set([
      "plugin-manifest",
      "mcp-config",
      "hook-config",
      "lsp-config",
      "marketplace-index",
      "compatibility-mirror",
      "catalog",
    ]).has(String(value.type)) &&
    safeRelativePath(value.relativePath) &&
    new Set(["missing", "stale", "fresh"]).has(String(value.freshness))
  );
}

function isReleaseArtifact(
  value: unknown,
): value is WorkspaceReleaseOperationArtifact {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      "kind",
      "id",
      "type",
      "objectType",
      "relativePath",
      "pluginCount",
      "createdAtCompletion",
    ]) ||
    value.kind !== "release" ||
    typeof value.id !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.id) ||
    !Number.isSafeInteger(value.pluginCount) ||
    Number(value.pluginCount) < 0 ||
    Number(value.pluginCount) > MAX_TARGETS ||
    value.createdAtCompletion !== true ||
    !safeRelativePath(value.relativePath)
  ) {
    return false;
  }
  return (
    (value.type === "release-directory" &&
      value.objectType === "directory" &&
      value.relativePath === "dist/release") ||
    (value.type === "release-manifest" &&
      value.objectType === "file" &&
      value.relativePath === "dist/release/release-manifest.json") ||
    (value.type === "release-archive" &&
      value.objectType === "file" &&
      value.relativePath.startsWith("dist/") &&
      value.relativePath.endsWith(".tar.gz"))
  );
}

function isArtifact(value: unknown): value is WorkspaceOperationArtifact {
  return isGenerationArtifact(value) || isReleaseArtifact(value);
}

function isLocalReleaseFacts(value: unknown): value is WorkspaceLocalReleaseFacts {
  return (
    isObject(value) &&
    exactKeys(value, [
      "pluginCount",
      "releaseDirectory",
      "archive",
      "changedPaths",
      "canonicalPaths",
      "createdParentPaths",
      "residuePaths",
      "diskChanged",
      "cleanupComplete",
    ]) &&
    Number.isSafeInteger(value.pluginCount) &&
    Number(value.pluginCount) >= 0 &&
    Number(value.pluginCount) <= MAX_TARGETS &&
    new Set(["unchanged", "committed", "uncertain"]).has(
      String(value.releaseDirectory),
    ) &&
    new Set(["not-created", "created", "uncertain"]).has(
      String(value.archive),
    ) &&
    uniqueStrings(value.changedPaths, 64) &&
    value.changedPaths.every(safeRelativePath) &&
    uniqueStrings(value.canonicalPaths, 8) &&
    value.canonicalPaths.every(safeRelativePath) &&
    uniqueStrings(value.createdParentPaths, 8) &&
    value.createdParentPaths.every(safeRelativePath) &&
    uniqueStrings(value.residuePaths, 16) &&
    value.residuePaths.every(safeRelativePath) &&
    typeof value.diskChanged === "boolean" &&
    typeof value.cleanupComplete === "boolean"
  );
}

function containsReusableCapability(value: WorkspaceOperationRecord): boolean {
  const text = JSON.stringify(value);
  return (
    /(?:^|["\s])\/(?:Users|Volumes|private|tmp|var|opt|Applications)\//.test(
      text,
    ) ||
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z0-9_]*\s*=\s*(?!\[REDACTED\])\S+/i.test(
      text,
    ) ||
    /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|Bearer\s+(?!\[REDACTED\])\S+)/i.test(
      text,
    )
  );
}

export function isWorkspaceOperationRecord(
  value: unknown,
): value is WorkspaceOperationRecord {
  if (
    !isObject(value) ||
    !exactKeys(
      value,
      [
        "schemaVersion",
        "id",
        "kind",
        "access",
        "workspace",
        "targets",
        "stages",
        "status",
        "outcome",
        "startedAt",
        "updatedAt",
        "issues",
        "diagnostics",
        "cancel",
      ],
      ["endedAt", "durationMs", "artifacts", "release"],
    ) ||
    value.schemaVersion !== 1 ||
    !uuid(value.id) ||
    !new Set([
      "source-check",
      "full-validate",
      "plugin-build",
      "marketplace-index",
      "generate-and-validate",
      "local-release",
    ]).has(String(value.kind)) ||
    !new Set(["read", "write"]).has(String(value.access)) ||
    !isObject(value.workspace) ||
    !exactKeys(value.workspace, ["id", "label"]) ||
    !boundedString(value.workspace.id, 200) ||
    !boundedString(value.workspace.label, 240) ||
    !Array.isArray(value.targets) ||
    value.targets.length > MAX_TARGETS ||
    !value.targets.every(isTarget) ||
    !Array.isArray(value.stages) ||
    value.stages.length === 0 ||
    value.stages.length > MAX_STAGES ||
    !value.stages.every(isStage) ||
    !new Set(["queued", "running", "success", "failed", "canceled"]).has(
      String(value.status),
    ) ||
    !new Set([
      "pending",
      "passed",
      "validation-issues",
      "execution-failure",
      "canceled",
      "interrupted",
    ]).has(String(value.outcome)) ||
    !timestamp(value.startedAt) ||
    !timestamp(value.updatedAt) ||
    (value.endedAt !== undefined && !timestamp(value.endedAt)) ||
    (value.durationMs !== undefined && !duration(value.durationMs)) ||
    !Array.isArray(value.issues) ||
    value.issues.length > MAX_ISSUES ||
    !value.issues.every(isIssue) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > MAX_DIAGNOSTICS ||
    !value.diagnostics.every(isDiagnostic) ||
    (value.artifacts !== undefined &&
      (!Array.isArray(value.artifacts) ||
        value.artifacts.length > MAX_ARTIFACTS ||
        !value.artifacts.every(isArtifact))) ||
    (value.release !== undefined && !isLocalReleaseFacts(value.release)) ||
    !isObject(value.cancel) ||
    !exactKeys(
      value.cancel,
      ["requested"],
      ["requestedAt", "effectiveAt"],
    ) ||
    typeof value.cancel.requested !== "boolean" ||
    (value.cancel.requestedAt !== undefined &&
      !timestamp(value.cancel.requestedAt)) ||
    (value.cancel.effectiveAt !== undefined &&
      !timestamp(value.cancel.effectiveAt))
  ) {
    return false;
  }

  const record = value as unknown as WorkspaceOperationRecord;
  const targetIds = record.targets.map((target) => target.id);
  const stageIds = record.stages.map((stage) => stage.id);
  const issueIds = record.issues.map((issue) => issue.id);
  const diagnosticIds = record.diagnostics.map((item) => item.id);
  const artifactIds = record.artifacts?.map((item) => item.id) ?? [];
  const artifactPaths =
    record.artifacts?.map((item) => item.relativePath) ?? [];
  const diagnosticSet = new Set(diagnosticIds);
  const targetSet = new Set(targetIds);
  const releaseArtifacts =
    record.artifacts?.filter(isReleaseArtifact) ?? [];
  const generationArtifacts =
    record.artifacts?.filter(isGenerationArtifact) ?? [];
  if (
    new Set(targetIds).size !== targetIds.length ||
    new Set(stageIds).size !== stageIds.length ||
    new Set(issueIds).size !== issueIds.length ||
    new Set(diagnosticIds).size !== diagnosticIds.length ||
    new Set(artifactIds).size !== artifactIds.length ||
    new Set(artifactPaths).size !== artifactPaths.length ||
    record.issues.some(
      (issue) =>
        !diagnosticSet.has(issue.diagnosticRef) ||
        (issue.targetId !== undefined && !targetSet.has(issue.targetId)),
    ) ||
    record.stages.some(
      (stage) =>
        stage.completedTargetIds.some((id) => !targetSet.has(id)) ||
        stage.pendingTargetIds.some((id) => !targetSet.has(id)) ||
        stage.completedTargetIds.some((id) =>
          stage.pendingTargetIds.includes(id),
        ),
    ) ||
    record.targets.filter((target) => target.kind === "workspace").length !==
      1 ||
    record.targets.find((target) => target.kind === "workspace")?.id !==
      record.workspace.id ||
    record.stages.filter((stage) => stage.status === "running").length > 1
  ) {
    return false;
  }
  if (containsReusableCapability(record)) return false;

  if (
    (record.kind === "local-release" &&
      (record.release === undefined || generationArtifacts.length > 0)) ||
    (record.kind !== "local-release" &&
      (record.release !== undefined || releaseArtifacts.length > 0)) ||
    (record.release !== undefined &&
      (record.release.diskChanged !==
        (record.release.changedPaths.length > 0) ||
        releaseArtifacts.some(
          (artifact) => artifact.pluginCount !== record.release!.pluginCount,
        ) ||
        (record.release.cleanupComplete && record.release.residuePaths.length > 0)))
  ) {
    return false;
  }
  if (record.kind === "local-release") {
    const release = record.release!;
    const changedPaths = new Set(release.changedPaths);
    const expectedChangedPaths = new Set([
      ...release.canonicalPaths,
      ...release.createdParentPaths,
      ...release.residuePaths,
    ]);
    const directoryArtifacts = releaseArtifacts.filter(
      (artifact) => artifact.type === "release-directory",
    );
    const manifestArtifacts = releaseArtifacts.filter(
      (artifact) => artifact.type === "release-manifest",
    );
    const archiveArtifacts = releaseArtifacts.filter(
      (artifact) => artifact.type === "release-archive",
    );
    const archivePath = archiveArtifacts[0]?.relativePath;
    if (
      changedPaths.size !== expectedChangedPaths.size ||
      [...expectedChangedPaths].some((path) => !changedPaths.has(path)) ||
      directoryArtifacts.length > 1 ||
      manifestArtifacts.length > 1 ||
      archiveArtifacts.length > 1 ||
      (release.releaseDirectory === "committed"
        ? directoryArtifacts.length !== 1 ||
          manifestArtifacts.length !== 1 ||
          !release.canonicalPaths.includes("dist/release")
        : directoryArtifacts.length !== 0 || manifestArtifacts.length !== 0) ||
      (release.archive === "created"
        ? archiveArtifacts.length !== 1 ||
          archivePath === undefined ||
          !release.canonicalPaths.includes(archivePath)
        : archiveArtifacts.length !== 0) ||
      (release.archive !== "not-created" &&
        release.releaseDirectory !== "committed") ||
      release.canonicalPaths.some(
        (path) => path !== "dist/release" && path !== archivePath,
      ) ||
      (record.status === "success" &&
        (release.releaseDirectory !== "committed" ||
          release.archive !== "created" ||
          !release.cleanupComplete ||
          releaseArtifacts.length !== 3))
    ) {
      return false;
    }
  }

  const terminal =
    record.status === "success" ||
    record.status === "failed" ||
    record.status === "canceled";
  const statusOutcomeValid =
    (record.status === "queued" && record.outcome === "pending") ||
    (record.status === "running" && record.outcome === "pending") ||
    (record.status === "success" && record.outcome === "passed") ||
    (record.status === "failed" &&
      new Set([
        "validation-issues",
        "execution-failure",
        "interrupted",
      ]).has(record.outcome)) ||
    (record.status === "canceled" && record.outcome === "canceled");
  if (
    !statusOutcomeValid ||
    (record.kind === "source-check" || record.kind === "full-validate"
      ? record.access !== "read"
      : record.access !== "write") ||
    ((record.kind === "source-check" || record.kind === "full-validate") &&
      record.artifacts !== undefined) ||
    (terminal &&
      (record.endedAt === undefined || record.durationMs === undefined)) ||
    (!terminal &&
      (record.endedAt !== undefined || record.durationMs !== undefined)) ||
    (record.endedAt !== undefined &&
      Date.parse(record.endedAt) < Date.parse(record.startedAt)) ||
    Date.parse(record.updatedAt) < Date.parse(record.startedAt) ||
    (record.endedAt !== undefined &&
      Date.parse(record.updatedAt) > Date.parse(record.endedAt)) ||
    (!record.cancel.requested &&
      (record.cancel.requestedAt !== undefined ||
        record.cancel.effectiveAt !== undefined)) ||
    (record.cancel.requested && record.cancel.requestedAt === undefined) ||
    (record.status === "canceled" &&
      (!record.cancel.requested ||
        record.cancel.effectiveAt === undefined)) ||
    (record.status !== "canceled" &&
      record.cancel.effectiveAt !== undefined) ||
    (record.cancel.requestedAt !== undefined &&
      Date.parse(record.cancel.requestedAt) < Date.parse(record.startedAt)) ||
    (record.cancel.effectiveAt !== undefined &&
      (record.cancel.requestedAt === undefined ||
        Date.parse(record.cancel.effectiveAt) <
          Date.parse(record.cancel.requestedAt))) ||
    record.stages.some((current) => {
      if (
        current.startedAt !== undefined &&
        (Date.parse(current.startedAt) < Date.parse(record.startedAt) ||
          (record.endedAt !== undefined &&
            Date.parse(current.startedAt) > Date.parse(record.endedAt)))
      ) {
        return true;
      }
      if (
        current.endedAt !== undefined &&
        (current.startedAt === undefined ||
          Date.parse(current.endedAt) < Date.parse(current.startedAt) ||
          (record.endedAt !== undefined &&
            Date.parse(current.endedAt) > Date.parse(record.endedAt)))
      ) {
        return true;
      }
      if (current.status === "pending") {
        return (
          current.startedAt !== undefined ||
          current.endedAt !== undefined ||
          current.durationMs !== undefined
        );
      }
      if (current.status === "running") {
        return (
          current.startedAt === undefined ||
          current.endedAt !== undefined ||
          current.durationMs !== undefined
        );
      }
      if (current.status === "completed" || current.status === "failed") {
        return (
          current.startedAt === undefined ||
          current.endedAt === undefined ||
          current.durationMs === undefined
        );
      }
      return (
        current.startedAt !== undefined &&
        (current.endedAt === undefined || current.durationMs === undefined)
      );
    }) ||
    (record.outcome === "passed" &&
      (record.issues.length > 0 ||
        record.stages.some((current) => current.status !== "completed"))) ||
    (record.outcome === "validation-issues" &&
      (record.issues.length === 0 ||
        ((record.kind === "source-check" ||
          record.kind === "full-validate") &&
          record.stages.some(
            (current) => current.status !== "completed",
          )))) ||
    (record.outcome === "execution-failure" &&
      !record.stages.some((current) => current.status === "failed")) ||
    (record.outcome === "interrupted" && record.status !== "failed") ||
    (record.outcome === "canceled" &&
      !record.stages.some((current) => current.status === "canceled"))
  ) {
    return false;
  }

  try {
    return JSON.stringify(record).length <= MAX_RECORD_JSON;
  } catch {
    return false;
  }
}
