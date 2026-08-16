export const PLUGIN_DOCUMENT_FILENAME = "plugin.yaml";

export interface PluginAuthorDraft {
  readonly name: string;
  readonly email: string;
  readonly url: string;
}

export interface CodexInterfaceDraft {
  readonly displayName: string;
  readonly shortDescription: string;
  readonly longDescription: string;
  readonly category: string;
  readonly developerName: string;
  readonly capabilities: readonly string[];
  readonly defaultPrompts: readonly string[];
}

/**
 * This document contract owns only plugin identity, descriptive metadata and Codex interface
 * overrides. Components and every other legal source node stay outside this
 * draft and therefore cannot be exposed as editable state to untrusted callers.
 */
export interface PluginEditorDraft {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: PluginAuthorDraft;
  readonly category: string;
  readonly tags: readonly string[];
  readonly codex: CodexInterfaceDraft;
}

export type PluginEditorField =
  | "name"
  | "version"
  | "description"
  | "author.name"
  | "author.email"
  | "author.url"
  | "category"
  | "tags"
  | "codex.displayName"
  | "codex.shortDescription"
  | "codex.longDescription"
  | "codex.category"
  | "codex.developerName"
  | "codex.capabilities"
  | "codex.defaultPrompts"
  | "advanced";

export interface PluginEditorIssue {
  readonly id: string;
  readonly severity: "blocking" | "attention";
  readonly kind:
    | "required"
    | "length"
    | "pattern"
    | "type"
    | "enum"
    | "duplicate"
    | "cross-field"
    | "unsupported";
  readonly field: PluginEditorField;
  readonly title: string;
  readonly message: string;
  readonly impact: string;
  readonly nextAction: string;
  readonly technicalPath: string;
}

export interface PluginEditorQuality {
  readonly state: "valid" | "attention" | "invalid";
  readonly blockingCount: number;
  readonly attentionCount: number;
  readonly firstAction: string;
  readonly issues: readonly PluginEditorIssue[];
}

export interface PluginDocumentFormat {
  readonly bom: boolean;
  readonly lineEnding: "lf" | "crlf";
}

export interface PluginDocumentProblem {
  readonly code:
    | "PLUGIN_MISSING"
    | "PLUGIN_UNAVAILABLE"
    | "PLUGIN_UNSAFE"
    | "INVALID_ENCODING"
    | "INVALID_YAML"
    | "UNSAFE_STRUCTURE";
  readonly title: string;
  readonly message: string;
  readonly impact: string;
  readonly nextAction: string;
  readonly technicalDetail?: string;
}

export type ReadPluginDocumentResult =
  | {
      readonly status: "loaded";
      readonly draft: PluginEditorDraft;
      readonly revision: string;
      readonly format: PluginDocumentFormat;
      readonly quality: PluginEditorQuality;
    }
  | {
      readonly status: "invalid";
      readonly revision: string;
      readonly problem: PluginDocumentProblem;
    }
  | {
      readonly status: "unavailable";
      readonly problem: PluginDocumentProblem;
    };

export type SavePluginDocumentResult =
  | {
      readonly status: "saved";
      readonly draft: PluginEditorDraft;
      readonly revision: string;
      readonly savedAt: string;
      readonly diskChanged: boolean;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: true;
      readonly quality: PluginEditorQuality;
    }
  | {
      readonly status: "conflict";
      readonly currentRevision: string;
      readonly message: string;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: "busy";
      readonly message: string;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: "invalid-input";
      readonly quality: PluginEditorQuality;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: "invalid-source";
      readonly problem: PluginDocumentProblem;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly diskChanged: boolean;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: boolean;
    };
