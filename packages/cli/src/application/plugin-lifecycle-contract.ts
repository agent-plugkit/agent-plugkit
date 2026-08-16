import type { ComponentType, PluginScaffoldFile } from './plugin-scaffold.js';

export const SKILL_IMPORT_MAX_FILES = 500;
export const SKILL_IMPORT_MAX_BYTES = 10_485_760;

export type PluginLifecycleErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_COMPONENT_TYPE'
  | 'INVALID_DESCRIPTION'
  | 'INVALID_AUTHOR'
  | 'WORKSPACE_UNAVAILABLE'
  | 'PLUGINS_DIRECTORY_UNAVAILABLE'
  | 'TARGET_CONFLICT'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_NOT_DIRECTORY'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_SHAPE_UNSUPPORTED'
  | 'SOURCE_MULTIPLE_SKILLS'
  | 'SOURCE_INVALID_FRONTMATTER'
  | 'SOURCE_UNSAFE_ENTRY'
  | 'SOURCE_LIMIT_EXCEEDED'
  | 'SOURCE_CHANGED'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_CHANGED'
  | 'PLAN_STALE'
  | 'TRANSACTION_BUSY'
  | 'TRANSACTION_FAILED';

export interface PluginLifecycleProblem {
  readonly code: PluginLifecycleErrorCode;
  readonly message: string;
  readonly relativePath?: string;
}

export interface PluginLifecycleWarning {
  readonly code:
    | 'MISSING_FRONTMATTER'
    | 'NORMALIZED_NAME'
    | 'CANONICAL_NAME_DIFFERENCE'
    | 'TRUNCATED_DESCRIPTION'
    | 'MISSING_DESCRIPTION';
  readonly message: string;
}

export interface PluginWriteSummary {
  readonly pluginName: string;
  readonly directoryName: string;
  readonly componentType: ComponentType;
  readonly componentLabels: readonly string[];
  readonly relativePaths: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface CreatePluginRequest {
  readonly workspaceDirectory: string;
  readonly name: string;
  readonly type: ComponentType;
}

export interface PluginCreationPlan {
  readonly kind: 'create';
  readonly request: CreatePluginRequest;
  readonly workspaceCanonicalPath: string;
  readonly targetRelativePath: string;
  readonly targetCanonicalPath: string;
  readonly fingerprint: string;
  readonly files: readonly PluginScaffoldFile[];
  readonly summary: PluginWriteSummary;
}

export type PlanPluginCreationResult =
  | { readonly status: 'planned'; readonly plan: PluginCreationPlan }
  | { readonly status: 'blocked'; readonly problem: PluginLifecycleProblem }
  | { readonly status: 'invalid'; readonly problem: PluginLifecycleProblem };

export interface ImportSkillRequest {
  readonly workspaceDirectory: string;
  readonly sourceDirectory: string;
  readonly name?: string;
  readonly description?: string;
  readonly author?: string;
}

export interface SkillImportBudget {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly maxFiles: typeof SKILL_IMPORT_MAX_FILES;
  readonly maxBytes: typeof SKILL_IMPORT_MAX_BYTES;
}

export interface ImportedSkillFile {
  readonly sourceCanonicalPath: string;
  readonly relativePath: string;
  readonly bytes: Buffer;
  readonly mode: number;
  readonly digest: string;
}

export interface ImportedSkillDirectory {
  readonly relativePath: string;
  readonly mode: number;
}

export interface SkillImportDerivation {
  readonly sourceDisplayName: string;
  readonly sourceSkillDirectoryName: string;
  /** Resulting plugin directory. It is never renamed from a source mismatch. */
  readonly directoryName: string;
  /** Preserved canonical name declared by the source SKILL.md, when present. */
  readonly canonicalName?: string;
  readonly nameRepairIssue?: {
    readonly state: 'needs-review';
    readonly summary: string;
    readonly nextAction: string;
  };
  readonly frontmatterName?: string;
  readonly frontmatterDescription?: string;
  readonly argumentHint?: string;
  readonly pluginName: string;
  readonly description: string;
  readonly author?: string;
  readonly warnings: readonly PluginLifecycleWarning[];
  readonly budget: SkillImportBudget;
}

/**
 * Inspection of one explicitly selected Skill source. Canonical paths and
 * bytes intentionally stay inside the trusted application boundary; callers
 * receive only the derived, path-free projection.
 */
export interface SkillImportInspection {
  readonly sourceRootCanonicalPath: string;
  readonly sourceSkillCanonicalPath: string;
  readonly fingerprint: string;
  readonly importedDirectories: readonly ImportedSkillDirectory[];
  readonly importedFiles: readonly ImportedSkillFile[];
  readonly sourceDisplayName: string;
  readonly sourceSkillDirectoryName: string;
  readonly frontmatter: {
    readonly name?: string;
    readonly description?: string;
    readonly argumentHint?: string;
    readonly warnings: readonly PluginLifecycleWarning[];
  };
  readonly suggestion: SkillImportDerivation;
}

export type InspectSkillImportSourceResult =
  | { readonly status: 'inspected'; readonly inspection: SkillImportInspection }
  | { readonly status: 'invalid'; readonly problem: PluginLifecycleProblem };

export interface SkillImportPlan {
  readonly kind: 'import-skill';
  readonly request: ImportSkillRequest;
  readonly workspaceCanonicalPath: string;
  readonly sourceRootCanonicalPath: string;
  readonly sourceSkillCanonicalPath: string;
  readonly targetRelativePath: string;
  readonly targetCanonicalPath: string;
  readonly fingerprint: string;
  readonly importedDirectories: readonly ImportedSkillDirectory[];
  readonly importedFiles: readonly ImportedSkillFile[];
  readonly pluginFile: PluginScaffoldFile;
  readonly derivation: SkillImportDerivation;
  readonly summary: PluginWriteSummary;
}

export type PlanSkillImportResult =
  | { readonly status: 'planned'; readonly plan: SkillImportPlan }
  | { readonly status: 'blocked'; readonly problem: PluginLifecycleProblem }
  | { readonly status: 'invalid'; readonly problem: PluginLifecycleProblem };

export interface PluginTransactionSuccess {
  readonly status: 'created';
  readonly pluginName: string;
  readonly written: readonly string[];
  readonly cleanupComplete: true;
}

export interface PluginTransactionFailure {
  readonly status: 'blocked' | 'stale' | 'failed';
  readonly problem: PluginLifecycleProblem;
  readonly changedPaths: readonly string[];
  readonly rollbackComplete: boolean;
  readonly cleanupComplete: boolean;
}

export type ExecutePluginTransactionResult =
  | PluginTransactionSuccess
  | PluginTransactionFailure;

export type PluginLifecyclePlan = PluginCreationPlan | SkillImportPlan;

export interface PluginTransactionHooks {
  /** Test seam after the complete staging tree exists, before source recheck. */
  readonly afterStaging?: (plan: PluginLifecyclePlan) => void;
  /** Test seam for deterministic conflict/failure injection after staging. */
  readonly beforeTargetReservation?: (plan: PluginLifecyclePlan) => void;
  /** Test seam called immediately after an exact target file is created. */
  readonly afterTargetFileCreated?: (
    relativePath: string,
    createdFileCount: number,
  ) => void;
}

export interface PlanPluginTrashRequest {
  readonly workspaceDirectory: string;
  readonly directoryName: string;
}

export interface PluginTrashComponentFact {
  readonly kind: 'Skill' | 'MCP' | 'Hook' | 'LSP';
  readonly name: string;
}

export interface PluginTrashGeneratedFact {
  readonly label: string;
  readonly relativePath: string;
}

export interface PluginTrashPlan {
  readonly kind: 'trash-plugin';
  readonly request: PlanPluginTrashRequest;
  readonly workspaceCanonicalPath: string;
  readonly targetRelativePath: string;
  readonly targetCanonicalPath: string;
  readonly fingerprint: string;
  readonly plugin: {
    readonly directoryName: string;
    readonly canonicalName?: string;
    readonly displayName: string;
    readonly hasCanonicalDirectoryDifference: boolean;
    readonly nameRepairIssue?: {
      readonly state: 'needs-review';
      readonly summary: string;
      readonly nextAction: string;
    };
  };
  readonly components: readonly PluginTrashComponentFact[];
  readonly generated: readonly PluginTrashGeneratedFact[];
  readonly scope: {
    readonly entryCount: number;
    readonly regularFileCount: number;
    readonly totalRegularFileBytes: number;
    readonly relativePaths: readonly string[];
    readonly additionalEntryCount: number;
  };
  readonly workspaceGeneratedNotice: {
    readonly status: 'not-moved-becomes-stale';
    readonly labels: readonly ['Marketplace index', 'CATALOG'];
    readonly message: string;
  };
}

export type PlanPluginTrashResult =
  | { readonly status: 'planned'; readonly plan: PluginTrashPlan }
  | { readonly status: 'invalid'; readonly problem: PluginLifecycleProblem };

export type VerifyPluginTrashPlanResult =
  | { readonly status: 'verified'; readonly plan: PluginTrashPlan }
  | { readonly status: 'stale'; readonly problem: PluginLifecycleProblem }
  | { readonly status: 'invalid'; readonly problem: PluginLifecycleProblem };
