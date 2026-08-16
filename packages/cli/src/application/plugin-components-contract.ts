import type {
  PluginHook,
  PluginLsp,
  PluginMcp,
  PluginSkill,
} from "../schema/plugin-yaml.js";
import type { ComponentType } from "./plugin-scaffold.js";

export type PluginComponentKind = ComponentType;

export interface PluginComponentCollections {
  readonly skill: readonly PluginSkill[];
  readonly mcp: readonly PluginMcp[];
  readonly hook: readonly PluginHook[];
  readonly lsp: readonly PluginLsp[];
}

export type PluginComponentValue =
  | PluginSkill
  | PluginMcp
  | PluginHook
  | PluginLsp;

export type PluginComponentMutation =
  | {
      readonly operation: "add";
      readonly kind: PluginComponentKind;
      readonly value: PluginComponentValue;
      readonly createScaffold: boolean;
    }
  | {
      readonly operation: "edit";
      readonly kind: PluginComponentKind;
      readonly index: number;
      readonly value: PluginComponentValue;
    }
  | {
      readonly operation: "remove";
      readonly kind: PluginComponentKind;
      readonly index: number;
    };

export interface PluginComponentIssue {
  readonly id: string;
  readonly severity: "blocking" | "attention";
  readonly kind: PluginComponentKind;
  readonly index?: number;
  readonly field: string;
  readonly title: string;
  readonly message: string;
  readonly impact: string;
  readonly nextAction: string;
  readonly technicalPath: string;
}

export interface PluginComponentPermissions {
  readonly readable: boolean;
  readonly writable: boolean;
  readonly executable: boolean;
}

export type PluginComponentFileState =
  | "present"
  | "missing"
  | "unsafe"
  | "wrong-type"
  | "unavailable"
  | "external-command";

export interface PluginComponentFileFact {
  readonly kind: PluginComponentKind;
  readonly componentIndex: number;
  readonly role:
    | "skill-directory"
    | "skill-document"
    | "hook-script"
    | "command"
    | "argument"
    | "workspace-folder";
  readonly configuredPath: string;
  readonly state: PluginComponentFileState;
  readonly objectType: "file" | "directory" | "other" | "unknown";
  readonly permissions: PluginComponentPermissions;
  readonly canReveal: boolean;
  readonly canOpenExternally: boolean;
  readonly message: string;
}

export interface PluginComponentImpactPreview {
  readonly operation: PluginComponentMutation["operation"];
  readonly kind: PluginComponentKind;
  readonly title: string;
  readonly summary: string;
  readonly canonicalChanges: readonly string[];
  readonly generatedResults: readonly string[];
  readonly retainedUserFiles: readonly string[];
  readonly scaffoldFiles: readonly string[];
  readonly generatedAction: "none";
}

export interface PluginComponentPlan {
  readonly workspaceCanonicalPath: string;
  readonly pluginDirectoryName: string;
  readonly expectedRevision: string;
  readonly fingerprint: string;
  readonly nextBytes: Buffer;
  readonly createFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Buffer;
    readonly mode: number;
  }[];
  readonly impact: PluginComponentImpactPreview;
}

export interface PluginComponentTransactionFacts {
  readonly canonical: "unchanged" | "committed" | "restored" | "uncertain";
  readonly scaffolds: "none" | "committed" | "rolled-back" | "residual";
  readonly cleanupComplete: boolean;
}

export type ReadPluginComponentsResult =
  | {
      readonly status: "loaded";
      readonly canonicalName: string;
      readonly revision: string;
      readonly collections: PluginComponentCollections;
      readonly issues: readonly PluginComponentIssue[];
      readonly files: readonly PluginComponentFileFact[];
    }
  | {
      readonly status: "invalid" | "unavailable";
      readonly message: string;
      readonly impact: string;
      readonly nextAction: string;
      readonly revision?: string;
    };

export type PlanPluginComponentMutationResult =
  | {
      readonly status: "planned";
      readonly plan: PluginComponentPlan;
      readonly issues: readonly PluginComponentIssue[];
    }
  | {
      readonly status: "conflict";
      readonly currentRevision: string;
      readonly message: string;
    }
  | {
      readonly status: "invalid" | "unavailable";
      readonly message: string;
      readonly impact: string;
      readonly nextAction: string;
      readonly issues: readonly PluginComponentIssue[];
    };

export type ExecutePluginComponentPlanResult =
  | {
      readonly status: "saved";
      readonly revision: string;
      readonly changedPaths: readonly string[];
      readonly diskChanged: boolean;
      readonly cleanupComplete: true;
      readonly transaction: PluginComponentTransactionFacts;
    }
  | {
      readonly status: "conflict";
      readonly currentRevision: string;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
      readonly transaction: PluginComponentTransactionFacts;
    }
  | {
      readonly status: "busy" | "failed";
      readonly message: string;
      readonly diskChanged: boolean;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: boolean;
      readonly transaction: PluginComponentTransactionFacts;
    };
