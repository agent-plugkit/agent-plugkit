export interface CreateWorkspaceRequest {
  readonly directory: string;
  readonly name: string;
  readonly organization: string;
  readonly includePlugkit: boolean;
}
export type WorkspaceCreationChangeAction = 'create' | 'update' | 'preserve';

export interface WorkspaceCreationChange {
  readonly relativePath: string;
  readonly action: WorkspaceCreationChangeAction;
  readonly summary: string;
}

export interface WorkspaceCreationConflict {
  readonly code:
    | 'MARKETPLACE_EXISTS'
    | 'INVALID_PACKAGE_JSON'
    | 'UNSAFE_PATH'
    | 'PATH_UNAVAILABLE';
  readonly title: string;
  readonly message: string;
  readonly relativePath?: string;
}

export interface WorkspaceCreationPlan {
  readonly status: 'ready' | 'blocked';
  readonly targetPath: string;
  readonly marketplaceName: string;
  readonly organization: string;
  readonly includePlugkit: boolean;
  readonly changes: readonly WorkspaceCreationChange[];
  readonly conflicts: readonly WorkspaceCreationConflict[];
  readonly preservationNote: string;
  /**
   * Opaque comparison token. Callers must not inspect or derive behavior from it.
   */
  readonly fingerprint: string;
}

export type ExecuteWorkspaceCreationResult =
  | {
      readonly status: 'created';
      readonly targetPath: string;
      readonly written: readonly string[];
      readonly preserved: readonly string[];
    }
  | {
      readonly status: 'blocked';
      readonly conflicts: readonly WorkspaceCreationConflict[];
    }
  | {
      readonly status: 'stale';
      readonly message: string;
    }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly changedPaths: readonly string[];
      readonly rollbackComplete: boolean;
    };

export function isWorkspaceCreationPlan(
  value: unknown,
): value is WorkspaceCreationPlan {
  if (value === null || typeof value !== 'object') return false;
  const plan = value as Record<string, unknown>;
  return (
    (plan.status === 'ready' || plan.status === 'blocked') &&
    typeof plan.targetPath === 'string' &&
    typeof plan.marketplaceName === 'string' &&
    typeof plan.organization === 'string' &&
    typeof plan.includePlugkit === 'boolean' &&
    Array.isArray(plan.changes) &&
    Array.isArray(plan.conflicts) &&
    typeof plan.preservationNote === 'string' &&
    typeof plan.fingerprint === 'string' &&
    plan.fingerprint.length > 0
  );
}
