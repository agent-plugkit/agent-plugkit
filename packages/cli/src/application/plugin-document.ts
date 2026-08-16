import { existsSync, lstatSync, readFileSync } from "node:fs";
import {
  CST,
  Document,
  isAlias,
  isMap,
  isScalar,
  parseDocument,
  type Node,
  type Pair,
  type YAMLMap,
} from "yaml";
import {
  AuthorizedPathError,
  authorizeExistingDirectory,
  resolveAuthorizedPath,
} from "../infrastructure/authorized-path.js";
import {
  commitAuthorizedDocument,
  documentRevision,
  type AtomicDocumentCommitDependencies,
} from "../infrastructure/document-commit.js";
import type { PluginSourceSchemaIssue } from "./plugin-source.js";
import { validatePluginYamlValue } from "./plugin-source.js";
import {
  PLUGIN_DOCUMENT_FILENAME,
  type PluginDocumentFormat,
  type PluginDocumentProblem,
  type PluginEditorDraft,
  type PluginEditorField,
  type PluginEditorIssue,
  type PluginEditorQuality,
  type ReadPluginDocumentResult,
  type SavePluginDocumentResult,
} from "./plugin-document-contract.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
export const MAX_PLUGIN_DOCUMENT_BYTES = 5 * 1024 * 1024;

type EditableLeaf =
  | {
      readonly path: readonly string[];
      readonly field: PluginEditorField;
      readonly optional: false;
      readonly value: string;
      readonly baseline: string;
    }
  | {
      readonly path: readonly string[];
      readonly field: PluginEditorField;
      readonly optional: true;
      readonly value: string;
      readonly baseline: string;
    }
  | {
      readonly path: readonly string[];
      readonly field: PluginEditorField;
      readonly optional: true;
      readonly value: readonly string[];
      readonly baseline: readonly string[];
    };

interface ParsedPluginDocument {
  readonly sourceBytes: Buffer;
  readonly source: string;
  readonly document: ReturnType<typeof parseDocument>;
  readonly map: YAMLMap<unknown, unknown>;
  readonly value: unknown;
  readonly draft: PluginEditorDraft;
  readonly revision: string;
  readonly format: PluginDocumentFormat;
}

type ParsedPluginResult =
  | { readonly status: "valid"; readonly value: ParsedPluginDocument }
  | {
      readonly status: "invalid";
      readonly revision: string;
      readonly problem: PluginDocumentProblem;
    };

export interface PluginDocumentRequest {
  readonly directory: string;
  readonly pluginDirectoryName: string;
}

export interface SavePluginDocumentRequest extends PluginDocumentRequest {
  readonly expectedRevision: string;
  readonly draft: PluginEditorDraft;
}

export interface PluginDocumentReadDependencies {
  readonly statSource?: (path: string) => {
    readonly size: number;
    isFile(): boolean;
  };
  readonly readSource?: (path: string) => Buffer;
}

export interface PluginDocumentDependencies
  extends PluginDocumentReadDependencies {
  readonly now?: () => Date;
  readonly commit?: (
    request: {
      readonly directory: string;
      readonly relativePath: string;
      readonly expectedRevision: string;
      readonly nextBytes: Uint8Array;
    },
    dependencies?: AtomicDocumentCommitDependencies,
  ) => ReturnType<typeof commitAuthorizedDocument>;
  readonly commitDependencies?: AtomicDocumentCommitDependencies;
}

export type PatchPluginDocumentBytesResult =
  | {
      readonly status: "patched";
      readonly bytes: Buffer;
      readonly draft: PluginEditorDraft;
      readonly quality: PluginEditorQuality;
    }
  | {
      readonly status: "invalid-input";
      readonly revision: string;
      readonly quality: PluginEditorQuality;
    }
  | {
      readonly status: "invalid-source";
      readonly revision: string;
      readonly problem: PluginDocumentProblem;
    };

export type AnalyzePluginEditorDraftResult =
  | { readonly status: "analyzed"; readonly quality: PluginEditorQuality }
  | {
      readonly status: "invalid-source";
      readonly revision: string;
      readonly problem: PluginDocumentProblem;
    };

export type LoadPluginDocumentStateResult =
  | {
      readonly status: "loaded";
      readonly result: Extract<
        ReadPluginDocumentResult,
        { readonly status: "loaded" }
      >;
      readonly sourceBytes: Buffer;
    }
  | Exclude<ReadPluginDocumentResult, { readonly status: "loaded" }>;

function problem(
  code: PluginDocumentProblem["code"],
  technicalDetail?: string,
): PluginDocumentProblem {
  if (code === "PLUGIN_MISSING") {
    return {
      code,
      title: "找不到插件基础信息",
      message: "当前插件中没有可读取的源信息。",
      impact: "无法打开结构化编辑；没有创建或修改任何文件。",
      nextAction: "请在外部确认插件文件，然后重新加载。",
      ...(technicalDetail === undefined ? {} : { technicalDetail }),
    };
  }
  if (code === "PLUGIN_UNSAFE") {
    return {
      code,
      title: "插件基础信息的位置不安全",
      message: "插件源信息使用了无法确认授权边界的路径或链接。",
      impact: "结构化编辑已停止，没有覆盖任何文件。",
      nextAction: "请在外部修正文件位置，然后重新检查 Marketplace。",
      ...(technicalDetail === undefined ? {} : { technicalDetail }),
    };
  }
  if (code === "PLUGIN_UNAVAILABLE") {
    return {
      code,
      title: "暂时无法读取插件基础信息",
      message: "插件文件夹或源信息当前不可访问。",
      impact: "结构化编辑已停止，没有覆盖任何文件。",
      nextAction: "请检查本机权限和文件状态后重新加载。",
      ...(technicalDetail === undefined ? {} : { technicalDetail }),
    };
  }
  if (code === "INVALID_ENCODING") {
    return {
      code,
      title: "插件基础信息的文字编码无法安全读取",
      message: "插件源信息不是有效 UTF-8 文本。",
      impact: "客户端不会用结构化表单覆盖这个文件。",
      nextAction: "请在外部编辑器中转换为 UTF-8，然后重新加载。",
      ...(technicalDetail === undefined ? {} : { technicalDetail }),
    };
  }
  if (code === "INVALID_YAML") {
    return {
      code,
      title: "插件基础信息无法解析",
      message: "插件源信息不是可安全解释的文档。",
      impact: "客户端不会用结构化表单覆盖原文件。",
      nextAction: "请在外部编辑器中修正 YAML，然后重新加载。",
      ...(technicalDetail === undefined ? {} : { technicalDetail }),
    };
  }
  return {
    code,
    title: "这部分插件信息无法安全改写",
    message: "目标字段位于无法局部确认的 YAML 结构中。",
    impact: "客户端保留原文件和本机输入，不会重排或覆盖不明确的内容。",
    nextAction: "请在外部编辑器中调整这部分结构，然后重新加载。",
    ...(technicalDetail === undefined ? {} : { technicalDetail }),
  };
}

function decodeUtf8(bytes: Buffer): {
  readonly source: string;
  readonly bom: boolean;
} {
  const bom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const content = bom ? bytes.subarray(UTF8_BOM.length) : bytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return { source: decoder.decode(content), bom };
}

function lineEnding(source: string): "lf" | "crlf" {
  return source.includes("\r\n") ? "crlf" : "lf";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry : ""))
    : [];
}

function draftFromValue(value: unknown): PluginEditorDraft {
  const root = isRecord(value) ? value : {};
  const author = isRecord(root.author) ? root.author : {};
  const platform = isRecord(root.platform) ? root.platform : {};
  const codex = isRecord(platform.codex) ? platform.codex : {};
  const iface = isRecord(codex.interface) ? codex.interface : {};
  return {
    name: stringValue(root.name),
    version: stringValue(root.version),
    description: stringValue(root.description),
    author: {
      name: stringValue(author.name),
      email: stringValue(author.email),
      url: stringValue(author.url),
    },
    category: stringValue(root.category),
    tags: stringList(root.tags),
    codex: {
      displayName: stringValue(iface.displayName),
      shortDescription: stringValue(iface.shortDescription),
      longDescription: stringValue(iface.longDescription),
      category: stringValue(iface.category),
      developerName: stringValue(iface.developerName),
      capabilities: stringList(iface.capabilities),
      defaultPrompts: stringList(iface.defaultPrompt),
    },
  };
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function leafIsUnchanged(leaf: EditableLeaf): boolean {
  if (typeof leaf.value === "string") {
    return typeof leaf.baseline === "string" && leaf.value === leaf.baseline;
  }
  return (
    typeof leaf.baseline !== "string" && sameStrings(leaf.value, leaf.baseline)
  );
}

function sameDraft(left: PluginEditorDraft, right: PluginEditorDraft): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    left.description === right.description &&
    left.author.name === right.author.name &&
    left.author.email === right.author.email &&
    left.author.url === right.author.url &&
    left.category === right.category &&
    sameStrings(left.tags, right.tags) &&
    left.codex.displayName === right.codex.displayName &&
    left.codex.shortDescription === right.codex.shortDescription &&
    left.codex.longDescription === right.codex.longDescription &&
    left.codex.category === right.codex.category &&
    left.codex.developerName === right.codex.developerName &&
    sameStrings(left.codex.capabilities, right.codex.capabilities) &&
    sameStrings(left.codex.defaultPrompts, right.codex.defaultPrompts)
  );
}

function parseBytes(bytes: Buffer): ParsedPluginResult {
  const revision = documentRevision(bytes);
  let decoded: ReturnType<typeof decodeUtf8>;
  try {
    decoded = decodeUtf8(bytes);
  } catch (error) {
    return {
      status: "invalid",
      revision,
      problem: problem(
        "INVALID_ENCODING",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  const document = parseDocument(decoded.source, {
    keepSourceTokens: true,
    logLevel: "silent",
  });
  if (document.errors.length > 0) {
    return {
      status: "invalid",
      revision,
      problem: problem(
        "INVALID_YAML",
        document.errors.map((error) => error.message).join("\n"),
      ),
    };
  }
  if (!isMap(document.contents)) {
    return {
      status: "invalid",
      revision,
      problem: problem(
        "UNSAFE_STRUCTURE",
        "plugin.yaml must contain a mapping",
      ),
    };
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return {
      status: "invalid",
      revision,
      problem: problem(
        "INVALID_YAML",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  return {
    status: "valid",
    value: {
      sourceBytes: bytes,
      source: decoded.source,
      document,
      map: document.contents,
      value,
      draft: draftFromValue(value),
      revision,
      format: {
        bom: decoded.bom,
        lineEnding: lineEnding(decoded.source),
      },
    },
  };
}

export function pluginDocumentRelativePath(pluginDirectoryName: string): string {
  if (
    pluginDirectoryName.length === 0 ||
    pluginDirectoryName === "." ||
    pluginDirectoryName === ".." ||
    pluginDirectoryName.includes("/") ||
    pluginDirectoryName.includes("\\")
  ) {
    throw new AuthorizedPathError(
      "OUTSIDE_AUTHORIZED_ROOT",
      "插件目录标识不是单个已授权对象",
      pluginDirectoryName,
    );
  }
  return `plugins/${pluginDirectoryName}/${PLUGIN_DOCUMENT_FILENAME}`;
}

function readPluginBytes(
  request: PluginDocumentRequest,
  dependencies: PluginDocumentReadDependencies = {},
):
  | { readonly status: "loaded"; readonly bytes: Buffer }
  | {
      readonly status: "unavailable";
      readonly problem: PluginDocumentProblem;
    } {
  try {
    const authorization = authorizeExistingDirectory(request.directory);
    const relativePath = pluginDocumentRelativePath(request.pluginDirectoryName);
    const path = resolveAuthorizedPath(authorization, relativePath);
    if (!existsSync(path)) {
      return {
        status: "unavailable",
        problem: problem("PLUGIN_MISSING"),
      };
    }
    const sourceStat = (dependencies.statSource ?? lstatSync)(path);
    if (!sourceStat.isFile()) {
      return {
        status: "unavailable",
        problem: problem(
          "PLUGIN_UNAVAILABLE",
          "plugin.yaml is not a regular file",
        ),
      };
    }
    if (sourceStat.size > MAX_PLUGIN_DOCUMENT_BYTES) {
      return {
        status: "unavailable",
        problem: problem(
          "PLUGIN_UNAVAILABLE",
          `plugin source exceeds ${MAX_PLUGIN_DOCUMENT_BYTES} bytes`,
        ),
      };
    }
    const bytes = (dependencies.readSource ?? readFileSync)(path);
    if (bytes.length > MAX_PLUGIN_DOCUMENT_BYTES) {
      return {
        status: "unavailable",
        problem: problem(
          "PLUGIN_UNAVAILABLE",
          `plugin source grew beyond ${MAX_PLUGIN_DOCUMENT_BYTES} bytes while reading`,
        ),
      };
    }
    return { status: "loaded", bytes };
  } catch (error) {
    const unsafe =
      error instanceof AuthorizedPathError &&
      new Set([
        "ABSOLUTE_PATH",
        "OUTSIDE_AUTHORIZED_ROOT",
        "UNSAFE_SYMLINK",
      ]).has(error.code);
    return {
      status: "unavailable",
      problem: problem(
        unsafe ? "PLUGIN_UNSAFE" : "PLUGIN_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

function cloneValue(value: unknown): unknown {
  return structuredClone(value);
}

function recordAt(
  root: Record<string, unknown>,
  path: readonly string[],
  create: boolean,
): Record<string, unknown> | undefined {
  let cursor = root;
  for (const key of path) {
    const next = cursor[key];
    if (isRecord(next)) {
      cursor = next;
      continue;
    }
    if (!create) return undefined;
    const created: Record<string, unknown> = {};
    cursor[key] = created;
    cursor = created;
  }
  return cursor;
}

function applyLeafToCandidate(
  root: Record<string, unknown>,
  leaf: EditableLeaf,
): void {
  if (leafIsUnchanged(leaf)) return;
  const parentPath = leaf.path.slice(0, -1);
  const key = leaf.path.at(-1);
  if (key === undefined) return;
  if (
    leaf.optional &&
    (typeof leaf.value === "string"
      ? leaf.value.length === 0
      : leaf.value.length === 0)
  ) {
    const parent = recordAt(root, parentPath, false);
    if (parent !== undefined) delete parent[key];
    return;
  }
  const parent = recordAt(root, parentPath, true);
  if (parent !== undefined) {
    parent[key] = Array.isArray(leaf.value) ? [...leaf.value] : leaf.value;
  }
}

function editableLeaves(
  baseline: PluginEditorDraft,
  draft: PluginEditorDraft,
): readonly EditableLeaf[] {
  return [
    {
      path: ["name"],
      field: "name",
      optional: false,
      value: draft.name,
      baseline: baseline.name,
    },
    {
      path: ["version"],
      field: "version",
      optional: false,
      value: draft.version,
      baseline: baseline.version,
    },
    {
      path: ["description"],
      field: "description",
      optional: false,
      value: draft.description,
      baseline: baseline.description,
    },
    {
      path: ["author", "name"],
      field: "author.name",
      optional: false,
      value: draft.author.name,
      baseline: baseline.author.name,
    },
    {
      path: ["author", "email"],
      field: "author.email",
      optional: true,
      value: draft.author.email,
      baseline: baseline.author.email,
    },
    {
      path: ["author", "url"],
      field: "author.url",
      optional: true,
      value: draft.author.url,
      baseline: baseline.author.url,
    },
    {
      path: ["category"],
      field: "category",
      optional: true,
      value: draft.category,
      baseline: baseline.category,
    },
    {
      path: ["tags"],
      field: "tags",
      optional: true,
      value: draft.tags,
      baseline: baseline.tags,
    },
    {
      path: ["platform", "codex", "interface", "displayName"],
      field: "codex.displayName",
      optional: true,
      value: draft.codex.displayName,
      baseline: baseline.codex.displayName,
    },
    {
      path: ["platform", "codex", "interface", "shortDescription"],
      field: "codex.shortDescription",
      optional: true,
      value: draft.codex.shortDescription,
      baseline: baseline.codex.shortDescription,
    },
    {
      path: ["platform", "codex", "interface", "longDescription"],
      field: "codex.longDescription",
      optional: true,
      value: draft.codex.longDescription,
      baseline: baseline.codex.longDescription,
    },
    {
      path: ["platform", "codex", "interface", "category"],
      field: "codex.category",
      optional: true,
      value: draft.codex.category,
      baseline: baseline.codex.category,
    },
    {
      path: ["platform", "codex", "interface", "developerName"],
      field: "codex.developerName",
      optional: true,
      value: draft.codex.developerName,
      baseline: baseline.codex.developerName,
    },
    {
      path: ["platform", "codex", "interface", "capabilities"],
      field: "codex.capabilities",
      optional: true,
      value: draft.codex.capabilities,
      baseline: baseline.codex.capabilities,
    },
    {
      path: ["platform", "codex", "interface", "defaultPrompt"],
      field: "codex.defaultPrompts",
      optional: true,
      value: draft.codex.defaultPrompts,
      baseline: baseline.codex.defaultPrompts,
    },
  ];
}

function candidateValue(
  parsed: ParsedPluginDocument,
  draft: PluginEditorDraft,
): unknown {
  const candidate = cloneValue(parsed.value);
  if (!isRecord(candidate)) return candidate;
  for (const leaf of editableLeaves(parsed.draft, draft)) {
    applyLeafToCandidate(candidate, leaf);
  }
  return candidate;
}

function fieldForPath(path: string): PluginEditorField {
  if (path === "/name" || path.startsWith("/name/")) return "name";
  if (path === "/version" || path.startsWith("/version/")) return "version";
  if (path === "/description" || path.startsWith("/description/")) {
    return "description";
  }
  if (path === "/author/name" || path.startsWith("/author/name/")) {
    return "author.name";
  }
  if (path === "/author/email" || path.startsWith("/author/email/")) {
    return "author.email";
  }
  if (path === "/author/url" || path.startsWith("/author/url/")) {
    return "author.url";
  }
  if (path === "/category" || path.startsWith("/category/")) {
    return "category";
  }
  if (path === "/tags" || path.startsWith("/tags/")) return "tags";
  const interfacePrefix = "/platform/codex/interface/";
  if (!path.startsWith(interfacePrefix)) return "advanced";
  const leaf = path.slice(interfacePrefix.length).split("/")[0];
  const interfaceFields: Readonly<
    Record<string, PluginEditorField | undefined>
  > = {
    displayName: "codex.displayName",
    shortDescription: "codex.shortDescription",
    longDescription: "codex.longDescription",
    category: "codex.category",
    developerName: "codex.developerName",
    capabilities: "codex.capabilities",
    defaultPrompt: "codex.defaultPrompts",
  };
  return interfaceFields[leaf ?? ""] ?? "advanced";
}

function fieldLabel(field: PluginEditorField): string {
  return {
    name: "内部名称",
    version: "版本",
    description: "插件说明",
    "author.name": "维护者名称",
    "author.email": "维护者邮箱",
    "author.url": "维护者主页",
    category: "插件分类",
    tags: "标签",
    "codex.displayName": "Codex 显示名称",
    "codex.shortDescription": "Codex 简短说明",
    "codex.longDescription": "Codex 完整说明",
    "codex.category": "Codex 分类",
    "codex.developerName": "Codex 开发者名称",
    "codex.capabilities": "Codex 能力标签",
    "codex.defaultPrompts": "Codex 默认提示",
    advanced: "高级插件结构",
  }[field];
}

function technicalPath(issue: PluginSourceSchemaIssue): string {
  const base = issue.instancePath === "/" ? "" : issue.instancePath;
  if (issue.keyword === "required" && issue.missingProperty !== undefined) {
    return `${base}/${issue.missingProperty}` || "/";
  }
  if (
    issue.keyword === "additionalProperties" &&
    issue.additionalProperty !== undefined
  ) {
    return `${base}/${issue.additionalProperty}` || "/";
  }
  return issue.instancePath || "/";
}

function schemaIssueKind(keyword: string): PluginEditorIssue["kind"] {
  if (keyword === "required") return "required";
  if (
    keyword === "minLength" ||
    keyword === "maxLength" ||
    keyword === "minItems" ||
    keyword === "maxItems"
  ) {
    return "length";
  }
  if (keyword === "pattern") return "pattern";
  if (keyword === "enum") return "enum";
  if (keyword === "type") return "type";
  return "unsupported";
}

function schemaProductIssue(
  issue: PluginSourceSchemaIssue,
  index: number,
): PluginEditorIssue {
  const path = technicalPath(issue);
  const field = fieldForPath(path);
  const label = fieldLabel(field);
  const kind = schemaIssueKind(issue.keyword);
  const title =
    kind === "required"
      ? `${label}还没有填写`
      : kind === "length"
        ? `${label}的长度不符合要求`
        : kind === "pattern"
          ? `${label}的格式不符合要求`
          : kind === "enum"
            ? `${label}使用了不支持的选项`
            : kind === "type"
              ? `${label}的内容类型无法理解`
              : `${label}包含当前编辑器不能处理的内容`;
  const message =
    kind === "required"
      ? `${label}是完成保存所需的信息。`
      : kind === "length"
        ? `${label}的文字长度或条目数量超出允许范围。`
        : kind === "pattern"
          ? `${label}需要使用该字段支持的格式。`
          : kind === "enum"
            ? `${label}需要改为当前支持的选项。`
            : kind === "type"
              ? `${label}需要改为该字段支持的内容类型。`
              : `${label}包含结构化编辑器无法安全处理的内容。`;
  return {
    id: `schema-${String(index + 1).padStart(3, "0")}`,
    severity: "blocking",
    kind,
    field,
    title,
    message,
    impact:
      field === "advanced"
        ? "客户端不能安全提交其他字段，避免顺带保留一个无法验证的插件声明。"
        : "保存会被阻止，已保存的插件信息保持不变。",
    nextAction:
      field === "advanced"
        ? "请在外部编辑器中修正技术详情标出的位置，再重新加载。"
        : `请先修正${label}，再保存更改。`,
    technicalPath: path,
  };
}

function normalizedListValue(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function duplicateIssues(
  field: PluginEditorField,
  values: readonly string[],
  startIndex: number,
): readonly PluginEditorIssue[] {
  const firstByValue = new Map<string, number>();
  const issues: PluginEditorIssue[] = [];
  for (const [index, value] of values.entries()) {
    const normalized = normalizedListValue(value);
    if (normalized.length === 0) continue;
    const first = firstByValue.get(normalized);
    if (first === undefined) {
      firstByValue.set(normalized, index);
      continue;
    }
    const label = fieldLabel(field);
    issues.push({
      id: `attention-${String(startIndex + issues.length + 1).padStart(3, "0")}`,
      severity: "attention",
      kind: "duplicate",
      field,
      title: `${label}中有重复内容`,
      message: `第 ${first + 1} 项和第 ${index + 1} 项表达了相同内容。`,
      impact: "这不会改变文件格式有效性，但会让平台展示或检索结果重复。",
      nextAction: `建议保留一项${label}内容；也可以先保存并稍后整理。`,
      technicalPath:
        field === "tags"
          ? `/tags/${index}`
          : field === "codex.capabilities"
            ? `/platform/codex/interface/capabilities/${index}`
            : `/platform/codex/interface/defaultPrompt/${index}`,
    });
  }
  return issues;
}

function qualityFor(
  parsed: ParsedPluginDocument,
  draft: PluginEditorDraft,
  directoryName: string,
): PluginEditorQuality {
  const candidate = candidateValue(parsed, draft);
  const validation = validatePluginYamlValue(candidate);
  const issues: PluginEditorIssue[] =
    validation.status === "valid"
      ? []
      : validation.issues.map(schemaProductIssue);
  if (draft.name.length > 0 && draft.name !== directoryName) {
    issues.push({
      id: `attention-${String(issues.length + 1).padStart(3, "0")}`,
      severity: "attention",
      kind: "cross-field",
      field: "name",
      title: "内部名称与插件文件夹不同",
      message: `保存后内部名称会是“${draft.name}”，插件文件夹仍保持“${directoryName}”。`,
      impact:
        "目录不会自动重命名；插件会进入名称待修复状态，相关平台生成结果需要重新生成。",
      nextAction: `如需消除差异，请把内部名称改回“${directoryName}”；也可以保留差异后继续保存。`,
      technicalPath: "/name",
    });
  }
  const duplicateFields: readonly [PluginEditorField, readonly string[]][] = [
    ["tags", draft.tags],
    ["codex.capabilities", draft.codex.capabilities],
    ["codex.defaultPrompts", draft.codex.defaultPrompts],
  ];
  for (const [field, values] of duplicateFields) {
    issues.push(...duplicateIssues(field, values, issues.length));
  }
  const blockingCount = issues.filter(
    (issue) => issue.severity === "blocking",
  ).length;
  const attentionCount = issues.length - blockingCount;
  return {
    state:
      blockingCount > 0
        ? "invalid"
        : attentionCount > 0
          ? "attention"
          : "valid",
    blockingCount,
    attentionCount,
    firstAction:
      issues[0]?.nextAction ?? "当前字段满足保存要求，可以保存更改。",
    issues,
  };
}

export function analyzePluginEditorDraft(
  bytes: Uint8Array,
  draft: PluginEditorDraft,
  context: { readonly directoryName: string },
): AnalyzePluginEditorDraftResult {
  const parsed = parseBytes(Buffer.from(bytes));
  if (parsed.status === "invalid") {
    return {
      status: "invalid-source",
      revision: parsed.revision,
      problem: parsed.problem,
    };
  }
  return {
    status: "analyzed",
    quality: qualityFor(parsed.value, draft, context.directoryName),
  };
}

function pairForKey(
  map: YAMLMap<unknown, unknown>,
  key: string,
): Pair<unknown, unknown> | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function encodeScalar(value: string): string {
  const document = new Document(value);
  return document
    .toString({
      blockQuote: false,
      defaultStringType: "QUOTE_DOUBLE",
      lineWidth: 0,
    })
    .replace(/\n$/, "");
}

function encodeValue(value: string | readonly string[]): string {
  return typeof value === "string"
    ? encodeScalar(value)
    : `[${value.map(encodeScalar).join(", ")}]`;
}

type ParentMapResult =
  | {
      readonly status: "found";
      readonly map: YAMLMap<unknown, unknown>;
      readonly missingPath: readonly string[];
    }
  | {
      readonly status: "unsafe";
      readonly detail: string;
    };

function findParentMap(
  root: YAMLMap<unknown, unknown>,
  path: readonly string[],
): ParentMapResult {
  let map = root;
  for (const [index, key] of path.entries()) {
    const pair = pairForKey(map, key);
    if (pair === undefined) {
      return {
        status: "found",
        map,
        missingPath: path.slice(index),
      };
    }
    const node = pair.value as Node | null;
    if (node == null || isAlias(node) || !isMap(node)) {
      return {
        status: "unsafe",
        detail: `${path.slice(0, index + 1).join(".")} is not a directly editable mapping`,
      };
    }
    map = node;
  }
  return { status: "found", map, missingPath: [] };
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const prefix = source.slice(lineStart, offset);
  if (!/^[ \t]*$/.test(prefix)) {
    throw new Error("无法确认 YAML mapping 的缩进");
  }
  return prefix;
}

function mapIndent(
  source: string,
  map: YAMLMap<unknown, unknown>,
  fallbackDepth: number,
): string {
  const first = map.items.find(
    (pair) => isScalar(pair.key) && pair.key.range != null,
  );
  if (first === undefined || !isScalar(first.key) || first.key.range == null) {
    return "  ".repeat(fallbackDepth);
  }
  return lineIndent(source, first.key.range[0]);
}

function nestedBlockPair(
  path: readonly string[],
  value: string | readonly string[],
  indent: string,
): string {
  return path
    .map((key, index) => {
      const currentIndent = `${indent}${"  ".repeat(index)}`;
      return index === path.length - 1
        ? `${currentIndent}${key}: ${encodeValue(value)}`
        : `${currentIndent}${key}:`;
    })
    .join("\n");
}

function nestedFlowPair(
  path: readonly string[],
  value: string | readonly string[],
): string {
  let result = `${path.at(-1)}: ${encodeValue(value)}`;
  for (let index = path.length - 2; index >= 0; index -= 1) {
    result = `${path[index]}: { ${result} }`;
  }
  return result;
}

function insertionForMap(
  source: string,
  map: YAMLMap<unknown, unknown>,
  path: readonly string[],
  value: string | readonly string[],
  lineEndingValue: "lf" | "crlf",
  fallbackDepth: number,
): { readonly start: number; readonly replacement: string } {
  const range = map.range;
  if (range == null) {
    throw new Error("YAML Document API 没有提供 mapping source range");
  }
  if (map.flow) {
    const close = source.lastIndexOf("}", range[1] - 1);
    if (close < range[0]) {
      throw new Error("无法定位 flow mapping 的结束位置");
    }
    const token = map.srcToken;
    if (token === undefined || !CST.isCollection(token)) {
      throw new Error("无法确认 flow mapping 的原始 token");
    }
    const trailingItem = token.items.at(-1);
    const hasTrailingComma =
      trailingItem !== undefined &&
      trailingItem.key === undefined &&
      trailingItem.value === undefined &&
      trailingItem.start.some((item) => item.type === "comma");
    const empty = map.items.length === 0;
    const prefix =
      hasTrailingComma || empty
        ? /\s/.test(source[close - 1] ?? "")
          ? ""
          : " "
        : ", ";
    return {
      start: close,
      replacement: `${prefix}${nestedFlowPair(path, value)}`,
    };
  }
  const eol = lineEndingValue === "crlf" ? "\r\n" : "\n";
  const start = range[1];
  const indent = mapIndent(source, map, fallbackDepth);
  const lines = nestedBlockPair(path, value, indent);
  const needsLeadingLine = start > 0 && source[start - 1] !== "\n";
  const needsTrailingLine = start < source.length || source.endsWith("\n");
  return {
    start,
    replacement: `${needsLeadingLine ? eol : ""}${lines}${
      needsTrailingLine ? eol : ""
    }`,
  };
}

function replacementForExistingPair(
  source: string,
  pair: Pair<unknown, unknown>,
  value: string | readonly string[],
): {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
} {
  const node = pair.value as Node | null;
  if (node?.range == null) {
    throw new Error("无法定位字段的原始文字范围");
  }
  const original = source.slice(node.range[0], node.range[1]);
  const trailingLineEnding = original.endsWith("\r\n")
    ? "\r\n"
    : original.endsWith("\n")
      ? "\n"
      : "";
  return {
    start: node.range[0],
    end: node.range[1],
    replacement: `${encodeValue(value)}${trailingLineEnding}`,
  };
}

function deletionForPair(
  source: string,
  map: YAMLMap<unknown, unknown>,
  pair: Pair<unknown, unknown>,
): { readonly start: number; readonly end: number } {
  const keyRange = isScalar(pair.key) ? pair.key.range : undefined;
  const valueRange = (pair.value as Node | null)?.range;
  const mapRange = map.range;
  if (keyRange == null || valueRange == null || mapRange == null) {
    throw new Error("无法定位需要清除的字段范围");
  }
  if (map.flow) {
    const after = source.slice(valueRange[1], mapRange[1]);
    const afterMatch = after.match(/^[ \t]*(,)[ \t]*/);
    if (afterMatch !== null) {
      return {
        start: keyRange[0],
        end: valueRange[1] + afterMatch[0].length,
      };
    }
    const before = source.slice(mapRange[0], keyRange[0]);
    const comma = before.lastIndexOf(",");
    if (comma >= 0) {
      return {
        start: mapRange[0] + comma,
        end: valueRange[1],
      };
    }
    return { start: keyRange[0], end: valueRange[1] };
  }
  const start = source.lastIndexOf("\n", Math.max(0, keyRange[0] - 1)) + 1;
  if (!/^[ \t]*$/.test(source.slice(start, keyRange[0]))) {
    throw new Error("无法确认需要清除字段的行边界");
  }
  const valueAlreadyIncludesLineEnding =
    valueRange[1] > valueRange[0] && source[valueRange[1] - 1] === "\n";
  const newline = valueAlreadyIncludesLineEnding
    ? valueRange[1] - 1
    : source.indexOf("\n", valueRange[1]);
  return {
    start,
    end: newline < 0 ? source.length : newline + 1,
  };
}

function patchLeaf(
  source: string,
  format: PluginDocumentFormat,
  leaf: EditableLeaf,
):
  | { readonly status: "patched"; readonly source: string }
  | { readonly status: "unsafe"; readonly detail: string } {
  const document = parseDocument(source, {
    keepSourceTokens: true,
    logLevel: "silent",
  });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    return {
      status: "unsafe",
      detail: "source became unparseable during minimal patch",
    };
  }
  const parentPath = leaf.path.slice(0, -1);
  const key = leaf.path.at(-1);
  if (key === undefined) {
    return { status: "unsafe", detail: "empty owned field path" };
  }
  const parent = findParentMap(document.contents, parentPath);
  if (parent.status === "unsafe") return parent;
  const fullMissingPath = [...parent.missingPath, key];
  const pair =
    parent.missingPath.length === 0 ? pairForKey(parent.map, key) : undefined;
  const clear =
    leaf.optional &&
    (typeof leaf.value === "string"
      ? leaf.value.length === 0
      : leaf.value.length === 0);
  try {
    if (clear) {
      if (pair === undefined) return { status: "patched", source };
      const deletion = deletionForPair(source, parent.map, pair);
      if (!parent.map.flow && parent.map.items.length === 1) {
        const eol = format.lineEnding === "crlf" ? "\r\n" : "\n";
        const indent = mapIndent(source, parent.map, parentPath.length);
        return {
          status: "patched",
          source:
            source.slice(0, deletion.start) +
            `${indent}{}${deletion.end < source.length ? eol : ""}` +
            source.slice(deletion.end),
        };
      }
      return {
        status: "patched",
        source: source.slice(0, deletion.start) + source.slice(deletion.end),
      };
    }
    if (pair !== undefined) {
      const replacement = replacementForExistingPair(source, pair, leaf.value);
      return {
        status: "patched",
        source:
          source.slice(0, replacement.start) +
          replacement.replacement +
          source.slice(replacement.end),
      };
    }
    const insertion = insertionForMap(
      source,
      parent.map,
      fullMissingPath,
      leaf.value,
      format.lineEnding,
      leaf.path.length - fullMissingPath.length,
    );
    return {
      status: "patched",
      source:
        source.slice(0, insertion.start) +
        insertion.replacement +
        source.slice(insertion.start),
    };
  } catch (error) {
    return {
      status: "unsafe",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function patchPluginDocumentBytes(
  bytes: Uint8Array,
  draft: PluginEditorDraft,
  context: { readonly directoryName: string },
): PatchPluginDocumentBytesResult {
  const parsed = parseBytes(Buffer.from(bytes));
  if (parsed.status === "invalid") {
    return {
      status: "invalid-source",
      revision: parsed.revision,
      problem: parsed.problem,
    };
  }
  const quality = qualityFor(parsed.value, draft, context.directoryName);
  if (quality.blockingCount > 0) {
    return {
      status: "invalid-input",
      revision: parsed.value.revision,
      quality,
    };
  }
  let source = parsed.value.source;
  for (const leaf of editableLeaves(parsed.value.draft, draft)) {
    if (leafIsUnchanged(leaf)) continue;
    const patched = patchLeaf(source, parsed.value.format, leaf);
    if (patched.status === "unsafe") {
      return {
        status: "invalid-source",
        revision: parsed.value.revision,
        problem: problem(
          "UNSAFE_STRUCTURE",
          `${leaf.field}: ${patched.detail}`,
        ),
      };
    }
    source = patched.source;
  }
  const encoded = Buffer.from(source, "utf8");
  const nextBytes = parsed.value.format.bom
    ? Buffer.concat([UTF8_BOM, encoded])
    : encoded;
  const reparsed = parseBytes(nextBytes);
  if (reparsed.status === "invalid") {
    return {
      status: "invalid-source",
      revision: parsed.value.revision,
      problem: reparsed.problem,
    };
  }
  const finalQuality = qualityFor(reparsed.value, draft, context.directoryName);
  if (
    finalQuality.blockingCount > 0 ||
    !sameDraft(reparsed.value.draft, draft)
  ) {
    return {
      status: "invalid-source",
      revision: parsed.value.revision,
      problem: problem(
        "UNSAFE_STRUCTURE",
        "patched document does not project back to the requested plugin fields",
      ),
    };
  }
  return {
    status: "patched",
    bytes: nextBytes,
    draft: reparsed.value.draft,
    quality: finalQuality,
  };
}

export function loadPluginDocumentState(
  request: PluginDocumentRequest,
  dependencies: PluginDocumentReadDependencies = {},
): LoadPluginDocumentStateResult {
  const loaded = readPluginBytes(request, dependencies);
  if (loaded.status === "unavailable") return loaded;
  const parsed = parseBytes(loaded.bytes);
  if (parsed.status === "invalid") return parsed;
  const quality = qualityFor(
    parsed.value,
    parsed.value.draft,
    request.pluginDirectoryName,
  );
  return {
    status: "loaded",
    result: {
      status: "loaded",
      draft: parsed.value.draft,
      revision: parsed.value.revision,
      format: parsed.value.format,
      quality,
    },
    sourceBytes: Buffer.from(parsed.value.sourceBytes),
  };
}

export function readPluginDocument(
  request: PluginDocumentRequest,
  dependencies: PluginDocumentReadDependencies = {},
): ReadPluginDocumentResult {
  const loaded = loadPluginDocumentState(request, dependencies);
  return loaded.status === "loaded" ? loaded.result : loaded;
}

export function savePluginDocument(
  request: SavePluginDocumentRequest,
  dependencies: PluginDocumentDependencies = {},
): SavePluginDocumentResult {
  const loaded = readPluginBytes(request, dependencies);
  if (loaded.status === "unavailable") {
    return {
      status: "invalid-source",
      problem: loaded.problem,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  const revision = documentRevision(loaded.bytes);
  if (revision !== request.expectedRevision) {
    return {
      status: "conflict",
      currentRevision: revision,
      message:
        "已保存的插件信息已在外部变化；本机草稿仍保留，没有覆盖外部内容。",
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  const patched = patchPluginDocumentBytes(loaded.bytes, request.draft, {
    directoryName: request.pluginDirectoryName,
  });
  if (patched.status === "invalid-input") {
    return {
      status: "invalid-input",
      quality: patched.quality,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  if (patched.status === "invalid-source") {
    return {
      status: "invalid-source",
      problem: patched.problem,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  const relativePath = pluginDocumentRelativePath(request.pluginDirectoryName);
  const commit = (dependencies.commit ?? commitAuthorizedDocument)(
    {
      directory: request.directory,
      relativePath,
      expectedRevision: request.expectedRevision,
      nextBytes: patched.bytes,
    },
    dependencies.commitDependencies,
  );
  if (commit.status === "conflict") {
    return {
      status: "conflict",
      currentRevision: commit.currentRevision,
      message:
        "已保存的插件信息在提交前再次发生变化；本机草稿仍保留，没有覆盖外部内容。",
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  if (commit.status === "busy") {
    return {
      status: "busy",
      message: "另一个写入正在处理这个 Marketplace，请稍后重试。",
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  if (commit.status === "failed") return commit;
  return {
    status: "saved",
    draft: patched.draft,
    revision: commit.revision,
    savedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    diskChanged: commit.diskChanged,
    changedPaths: commit.changedPaths,
    cleanupComplete: true,
    quality: patched.quality,
  };
}
