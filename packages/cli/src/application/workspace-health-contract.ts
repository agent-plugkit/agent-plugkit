export type WorkspaceHealthOverall = 'ready' | 'invalid' | 'stale' | 'empty';
export type SourceValidity = 'valid' | 'invalid';
export type ReferenceValidity = 'valid' | 'invalid' | 'unknown';
export type GeneratedFreshness =
  | 'fresh'
  | 'missing'
  | 'stale'
  | 'unknown'
  | 'not-applicable';
export type WorkspaceHealthDimension = 'source' | 'reference' | 'generated';

export interface WorkspaceHealthDiagnostic {
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

export interface WorkspaceHealthIssueScope {
  readonly kind: 'workspace' | 'plugin' | 'field' | 'path';
  readonly label: string;
  readonly pluginId?: string;
  readonly field?: string;
  readonly relativePath?: string;
}

export interface WorkspaceHealthIssue {
  readonly id: string;
  readonly dimension: WorkspaceHealthDimension;
  readonly severity: 'blocking' | 'attention';
  readonly scope: WorkspaceHealthIssueScope;
  readonly title: string;
  readonly summary: string;
  readonly impact: string;
  readonly nextAction: string;
  readonly diagnosticRef: string;
}

export interface WorkspacePluginHealth {
  readonly id: string;
  readonly directoryName: string;
  readonly displayName: string;
  readonly canonicalName?: string;
  readonly version?: string;
  readonly componentCount: number;
  readonly componentKinds: readonly ('Skill' | 'MCP' | 'Hook' | 'LSP')[];
  readonly platforms: readonly ('Agent Plugins' | 'Claude Code' | 'Codex')[];
  readonly source: SourceValidity;
  readonly references: ReferenceValidity;
  readonly generated: GeneratedFreshness;
  readonly issueIds: readonly string[];
  readonly diagnosticRefs: readonly string[];
}

export interface WorkspaceHealthDimensionSummary<
  TState extends string,
> {
  readonly state: TState;
  readonly issueIds: readonly string[];
}

export interface WorkspaceHealthRecommendedAction {
  readonly kind:
    | 'review-source'
    | 'review-reference'
    | 'review-generated'
    | 'prepare-first-plugin'
    | 'review-evidence';
  readonly label: string;
  readonly description: string;
  readonly issueId?: string;
}

export interface WorkspaceHealthSnapshot {
  readonly overall: WorkspaceHealthOverall;
  readonly workspace: {
    readonly path: string;
    readonly name: string;
    readonly description?: string;
    readonly organization?: string;
    readonly marketplaceValidity: SourceValidity;
  };
  readonly dimensions: {
    readonly source: WorkspaceHealthDimensionSummary<SourceValidity>;
    readonly references: WorkspaceHealthDimensionSummary<ReferenceValidity>;
    readonly generated: WorkspaceHealthDimensionSummary<GeneratedFreshness>;
  };
  readonly summary: {
    readonly pluginCount: number;
    readonly componentCount: number;
    readonly platformCount: number;
    readonly platforms: readonly ('Agent Plugins' | 'Claude Code' | 'Codex')[];
  };
  readonly plugins: readonly WorkspacePluginHealth[];
  readonly issues: readonly WorkspaceHealthIssue[];
  readonly diagnostics: readonly WorkspaceHealthDiagnostic[];
  readonly recommendedAction: WorkspaceHealthRecommendedAction;
  readonly checkedAt: string;
  readonly access: 'read-only';
  /**
   * Workspace health deliberately matches the existing `validate` contract: plugin-level
   * manifests/configs only. Marketplace index/CATALOG freshness remains outside
   * this snapshot until the build/index operation slice owns that contract.
   */
  readonly generatedScope: 'plugin-manifests';
}

export interface WorkspaceHealthScanError {
  readonly code:
    | 'PATH_NOT_FOUND'
    | 'PATH_UNAVAILABLE'
    | 'NOT_A_DIRECTORY'
    | 'UNSAFE_SYMLINK';
  readonly title: string;
  readonly message: string;
  readonly impact: string;
  readonly nextAction: string;
  readonly technicalDetail?: string;
}

export interface WorkspaceValidationDiagnostic {
  readonly pluginDirectoryName: string;
  readonly code: string;
  readonly message: string;
}

export type ScanWorkspaceHealthResult =
  | {
      readonly status: 'scanned';
      readonly snapshot: WorkspaceHealthSnapshot;
      /**
       * Ordered validation diagnostics preserve the existing terminal contract.
       * They are separate from health aggregation because the CLI historically
       * continues generated-file checks after some parseable source errors.
       */
      readonly validationDiagnostics: readonly WorkspaceValidationDiagnostic[];
    }
  | {
      readonly status: 'unavailable';
      readonly error: WorkspaceHealthScanError;
    };

export interface ScanWorkspaceHealthRequest {
  readonly directory: string;
  /**
   * Omit for a workspace overview. CLI validate passes an ordered selection so
   * its existing name/--all presentation contract can be preserved.
   */
  readonly pluginNames?: readonly string[];
  /**
   * Defaults to the public validate-compatible full scan. Operation source
   * check deliberately stops after canonical source and local references; it
   * does not touch generated manifests and never hides a full scan afterward.
   */
  readonly scope?: 'full' | 'source-and-references';
  /**
   * Inspect marketplace/plugins container facts without scanning plugin
   * contents. Used by the operation runner before target-by-target checks.
   */
  readonly workspaceOnly?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function hasUniqueNonEmptyStrings(values: readonly string[]): boolean {
  return (
    values.every((value) => value.length > 0) &&
    new Set(values).size === values.length
  );
}

function isDimensionSummary(
  value: unknown,
  states: ReadonlySet<string>,
): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, ['state', 'issueIds']) &&
    typeof value.state === 'string' &&
    states.has(value.state) &&
    isStringArray(value.issueIds)
  );
}

function isHealthPlugin(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = [
    'id',
    'directoryName',
    'displayName',
    ...(value.canonicalName === undefined ? [] : ['canonicalName']),
    ...(value.version === undefined ? [] : ['version']),
    'componentCount',
    'componentKinds',
    'platforms',
    'source',
    'references',
    'generated',
    'issueIds',
    'diagnosticRefs',
  ];
  return (
    hasExactKeys(value, keys) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.directoryName === 'string' &&
    typeof value.displayName === 'string' &&
    (value.canonicalName === undefined ||
      typeof value.canonicalName === 'string') &&
    (value.version === undefined || typeof value.version === 'string') &&
    Number.isInteger(value.componentCount) &&
    (value.componentCount as number) >= 0 &&
    Array.isArray(value.componentKinds) &&
    value.componentKinds.every((kind) =>
      new Set(['Skill', 'MCP', 'Hook', 'LSP']).has(String(kind)),
    ) &&
    Array.isArray(value.platforms) &&
    value.platforms.every((platform) =>
      new Set(['Agent Plugins', 'Claude Code', 'Codex']).has(String(platform)),
    ) &&
    (value.source === 'valid' || value.source === 'invalid') &&
    new Set(['valid', 'invalid', 'unknown']).has(String(value.references)) &&
    new Set([
      'fresh',
      'missing',
      'stale',
      'unknown',
      'not-applicable',
    ]).has(String(value.generated)) &&
    isStringArray(value.issueIds) &&
    hasUniqueNonEmptyStrings(value.issueIds) &&
    isStringArray(value.diagnosticRefs) &&
    hasUniqueNonEmptyStrings(value.diagnosticRefs)
  );
}

function isHealthIssue(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.scope)) return false;
  const scopeKeys = [
    'kind',
    'label',
    ...(value.scope.pluginId === undefined ? [] : ['pluginId']),
    ...(value.scope.field === undefined ? [] : ['field']),
    ...(value.scope.relativePath === undefined ? [] : ['relativePath']),
  ];
  return (
    hasExactKeys(value, [
      'id',
      'dimension',
      'severity',
      'scope',
      'title',
      'summary',
      'impact',
      'nextAction',
      'diagnosticRef',
    ]) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    new Set(['source', 'reference', 'generated']).has(
      String(value.dimension),
    ) &&
    (value.severity === 'blocking' || value.severity === 'attention') &&
    hasExactKeys(value.scope, scopeKeys) &&
    new Set(['workspace', 'plugin', 'field', 'path']).has(
      String(value.scope.kind),
    ) &&
    typeof value.scope.label === 'string' &&
    (value.scope.pluginId === undefined ||
      typeof value.scope.pluginId === 'string') &&
    (value.scope.field === undefined ||
      typeof value.scope.field === 'string') &&
    (value.scope.relativePath === undefined ||
      typeof value.scope.relativePath === 'string') &&
    typeof value.title === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.impact === 'string' &&
    typeof value.nextAction === 'string' &&
    typeof value.diagnosticRef === 'string' &&
    value.diagnosticRef.length > 0
  );
}

function isHealthDiagnostic(value: unknown): boolean {
  return (
    isObject(value) &&
    hasExactKeys(value, ['id', 'code', 'message']) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  );
}

function isRecommendedAction(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = [
    'kind',
    'label',
    'description',
    ...(value.issueId === undefined ? [] : ['issueId']),
  ];
  return (
    hasExactKeys(value, keys) &&
    new Set([
      'review-source',
      'review-reference',
      'review-generated',
      'prepare-first-plugin',
      'review-evidence',
    ]).has(String(value.kind)) &&
    typeof value.label === 'string' &&
    typeof value.description === 'string' &&
    (value.issueId === undefined || typeof value.issueId === 'string')
  );
}

export function isWorkspaceHealthSnapshot(
  value: unknown,
): value is WorkspaceHealthSnapshot {
  if (
    !isObject(value) ||
    !isObject(value.workspace) ||
    !isObject(value.dimensions) ||
    !isObject(value.summary)
  ) {
    return false;
  }
  const workspaceKeys = [
    'path',
    'name',
    ...(value.workspace.description === undefined ? [] : ['description']),
    ...(value.workspace.organization === undefined ? [] : ['organization']),
    'marketplaceValidity',
  ];
  const structurallyValid =
    hasExactKeys(value, [
      'overall',
      'workspace',
      'dimensions',
      'summary',
      'plugins',
      'issues',
      'diagnostics',
      'recommendedAction',
      'checkedAt',
      'access',
      'generatedScope',
    ]) &&
    new Set(['ready', 'invalid', 'stale', 'empty']).has(
      String(value.overall),
    ) &&
    hasExactKeys(value.workspace, workspaceKeys) &&
    typeof value.workspace.path === 'string' &&
    value.workspace.path.length > 0 &&
    typeof value.workspace.name === 'string' &&
    value.workspace.name.length > 0 &&
    (value.workspace.description === undefined ||
      typeof value.workspace.description === 'string') &&
    (value.workspace.organization === undefined ||
      typeof value.workspace.organization === 'string') &&
    (value.workspace.marketplaceValidity === 'valid' ||
      value.workspace.marketplaceValidity === 'invalid') &&
    hasExactKeys(value.dimensions, [
      'source',
      'references',
      'generated',
    ]) &&
    isDimensionSummary(
      value.dimensions.source,
      new Set(['valid', 'invalid']),
    ) &&
    isDimensionSummary(
      value.dimensions.references,
      new Set(['valid', 'invalid', 'unknown']),
    ) &&
    isDimensionSummary(
      value.dimensions.generated,
      new Set(['fresh', 'missing', 'stale', 'unknown', 'not-applicable']),
    ) &&
    hasExactKeys(value.summary, [
      'pluginCount',
      'componentCount',
      'platformCount',
      'platforms',
    ]) &&
    Number.isInteger(value.summary.pluginCount) &&
    (value.summary.pluginCount as number) >= 0 &&
    Number.isInteger(value.summary.componentCount) &&
    (value.summary.componentCount as number) >= 0 &&
    Number.isInteger(value.summary.platformCount) &&
    (value.summary.platformCount as number) >= 0 &&
    Array.isArray(value.summary.platforms) &&
    value.summary.platforms.every((platform) =>
      new Set(['Agent Plugins', 'Claude Code', 'Codex']).has(String(platform)),
    ) &&
    Array.isArray(value.plugins) &&
    value.plugins.every(isHealthPlugin) &&
    Array.isArray(value.issues) &&
    value.issues.every(isHealthIssue) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isHealthDiagnostic) &&
    isRecommendedAction(value.recommendedAction) &&
    typeof value.checkedAt === 'string' &&
    !Number.isNaN(Date.parse(value.checkedAt)) &&
    value.access === 'read-only' &&
    value.generatedScope === 'plugin-manifests';
  if (!structurallyValid) return false;

  const snapshot = value as unknown as WorkspaceHealthSnapshot;
  const pluginIds = snapshot.plugins.map((plugin) => plugin.id);
  const issueIds = snapshot.issues.map((issue) => issue.id);
  const diagnosticIds = snapshot.diagnostics.map(
    (diagnostic) => diagnostic.id,
  );
  if (
    !hasUniqueNonEmptyStrings(pluginIds) ||
    !hasUniqueNonEmptyStrings(issueIds) ||
    !hasUniqueNonEmptyStrings(diagnosticIds)
  ) {
    return false;
  }

  const issueById = new Map(
    snapshot.issues.map((issue) => [issue.id, issue] as const),
  );
  const diagnosticIdSet = new Set(diagnosticIds);
  const pluginIdSet = new Set(pluginIds);
  const dimensionReferences = [
    ['source', snapshot.dimensions.source.issueIds],
    ['reference', snapshot.dimensions.references.issueIds],
    ['generated', snapshot.dimensions.generated.issueIds],
  ] as const;

  if (
    dimensionReferences.some(
      ([dimension, references]) =>
        !hasUniqueNonEmptyStrings(references) ||
        references.some(
          (issueId) => issueById.get(issueId)?.dimension !== dimension,
        ),
    )
  ) {
    return false;
  }
  if (
    snapshot.plugins.some(
      (plugin) =>
        plugin.issueIds.some((issueId) => !issueById.has(issueId)) ||
        plugin.diagnosticRefs.some(
          (diagnosticId) => !diagnosticIdSet.has(diagnosticId),
        ),
    )
  ) {
    return false;
  }
  if (
    snapshot.issues.some(
      (issue) =>
        !diagnosticIdSet.has(issue.diagnosticRef) ||
        (issue.scope.pluginId !== undefined &&
          !pluginIdSet.has(issue.scope.pluginId)),
    )
  ) {
    return false;
  }
  return (
    snapshot.recommendedAction.issueId === undefined ||
    issueById.has(snapshot.recommendedAction.issueId)
  );
}

export function isWorkspaceHealthScanError(
  value: unknown,
): value is WorkspaceHealthScanError {
  if (!isObject(value)) return false;
  const keys = [
    'code',
    'title',
    'message',
    'impact',
    'nextAction',
    ...(value.technicalDetail === undefined ? [] : ['technicalDetail']),
  ];
  return (
    hasExactKeys(value, keys) &&
    new Set([
      'PATH_NOT_FOUND',
      'PATH_UNAVAILABLE',
      'NOT_A_DIRECTORY',
      'UNSAFE_SYMLINK',
    ]).has(String(value.code)) &&
    typeof value.title === 'string' &&
    typeof value.message === 'string' &&
    typeof value.impact === 'string' &&
    typeof value.nextAction === 'string' &&
    (value.technicalDetail === undefined ||
      typeof value.technicalDetail === 'string')
  );
}
