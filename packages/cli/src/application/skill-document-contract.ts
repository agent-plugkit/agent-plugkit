export const SKILL_DOCUMENT_FILENAME = "SKILL.md";
export const SKILL_GUIDED_SECTION_KEYS = [
  "when-to-use",
  "outcome",
  "execution",
  "inputs",
] as const;

export type SkillGuidedSectionKey =
  (typeof SKILL_GUIDED_SECTION_KEYS)[number];

export interface SkillFrontmatterDraft {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
}

export interface SkillDocumentDraft {
  readonly frontmatter: SkillFrontmatterDraft;
  readonly body: string;
}

export interface SkillGuidedSection {
  readonly key: SkillGuidedSectionKey;
  readonly label: string;
  readonly present: boolean;
  readonly content: string;
}

export interface SkillDocumentFormat {
  readonly bom: boolean;
  readonly lineEnding: "lf" | "crlf";
}

export interface SkillDocumentView {
  readonly origin: "new" | "existing";
  readonly revision: string;
  readonly format: SkillDocumentFormat;
  readonly draft: SkillDocumentDraft;
  readonly guidedSections: readonly SkillGuidedSection[];
}

export interface SkillDocumentProblem {
  readonly code:
    | "SKILL_MISSING"
    | "SKILL_UNSAFE"
    | "SKILL_UNAVAILABLE"
    | "INVALID_ENCODING"
    | "INVALID_FRONTMATTER";
  readonly title: string;
  readonly message: string;
  readonly impact: string;
  readonly nextAction: string;
  readonly technicalDetail?: string;
}

export type SkillDocumentRawPreview =
  | { readonly kind: "text"; readonly content: string; readonly truncated: boolean }
  | { readonly kind: "hex"; readonly content: string; readonly truncated: boolean };

export type ReadSkillDocumentResult =
  | {
      readonly status: "loaded";
      readonly sourceBytes: Buffer;
      readonly document: SkillDocumentView;
    }
  | {
      readonly status: "uninterpretable";
      readonly kind: "encoding" | "frontmatter";
      readonly revision: string;
      readonly problem: SkillDocumentProblem;
      readonly preview: SkillDocumentRawPreview;
    }
  | {
      readonly status: "unavailable";
      readonly problem: SkillDocumentProblem;
    };

export type BuildSkillDocumentBytesResult =
  | { readonly status: "built"; readonly bytes: Buffer }
  | {
      readonly status: "invalid-source" | "invalid-input";
      readonly problem: SkillDocumentProblem;
    };

export type SaveSkillDocumentResult =
  | {
      readonly status: "saved" | "verified";
      readonly revision: string;
      readonly diskChanged: boolean;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: "conflict";
      readonly currentRevision: string;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    }
  | {
      readonly status: "busy" | "failed";
      readonly message: string;
      readonly diskChanged: boolean;
      readonly changedPaths: readonly string[];
      readonly cleanupComplete: boolean;
    }
  | {
      readonly status: "invalid-source" | "invalid-input";
      readonly problem: SkillDocumentProblem;
      readonly diskChanged: false;
      readonly changedPaths: readonly [];
      readonly cleanupComplete: true;
    };
