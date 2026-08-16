import { existsSync, lstatSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import {
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
import {
  SKILL_DOCUMENT_FILENAME,
  type BuildSkillDocumentBytesResult,
  type ReadSkillDocumentResult,
  type SaveSkillDocumentResult,
  type SkillDocumentDraft,
  type SkillDocumentProblem,
  type SkillDocumentView,
  type SkillFrontmatterDraft,
} from "./skill-document-contract.js";
import { skillGuidedSections } from "./skill-document-guided.js";
export { skillGuidedSections, updateSkillGuidedSection } from "./skill-document-guided.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const MAX_SKILL_DOCUMENT_BYTES = 5 * 1024 * 1024;
const RAW_PREVIEW_BYTES = 256 * 1024;

export interface SkillDocumentRequest {
  readonly pluginDirectory: string;
  readonly skillDirectory: string;
}

export interface SaveSkillDocumentRequest extends SkillDocumentRequest {
  readonly expectedRevision: string;
  readonly draft: SkillDocumentDraft;
}

export interface SkillDocumentDependencies {
  readonly readSource?: (path: string) => Buffer;
  readonly commit?: typeof commitAuthorizedDocument;
  readonly commitDependencies?: AtomicDocumentCommitDependencies;
}

interface FrontmatterSlice {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly bodyStart: number;
  readonly document: ReturnType<typeof parseDocument>;
  readonly map: YAMLMap<unknown, unknown>;
}

interface ParsedSkillDocument {
  readonly bytes: Buffer;
  readonly source: string;
  readonly bom: boolean;
  readonly lineEnding: "lf" | "crlf";
  readonly frontmatter?: FrontmatterSlice;
  readonly draft: SkillDocumentDraft;
  readonly view: SkillDocumentView;
}

type ParseSkillResult =
  | { readonly status: "valid"; readonly value: ParsedSkillDocument }
  | {
      readonly status: "invalid";
      readonly kind: "encoding" | "frontmatter";
      readonly revision: string;
      readonly problem: SkillDocumentProblem;
      readonly source?: string;
    };

function problem(
  code: SkillDocumentProblem["code"],
  technicalDetail?: string,
): SkillDocumentProblem {
  const details = technicalDetail === undefined ? {} : { technicalDetail };
  if (code === "SKILL_MISSING") {
    return {
      code,
      title: "找不到 Skill 正文",
      message: "当前 Skill 中没有可读取的 SKILL.md。",
      impact: "正文编辑没有开始，也没有创建或修改文件。",
      nextAction: "请先重新检查组件声明或在外部恢复这个文件。",
      ...details,
    };
  }
  if (code === "SKILL_UNSAFE") {
    return {
      code,
      title: "Skill 正文的位置不安全",
      message: "当前声明路径无法在已授权插件内安全解析。",
      impact: "客户端已停止读取或保存，没有越过授权边界。",
      nextAction: "请在组件声明中修正路径后重新打开正文。",
      ...details,
    };
  }
  if (code === "SKILL_UNAVAILABLE") {
    return {
      code,
      title: "暂时无法读取 Skill 正文",
      message: "SKILL.md 当前不可访问或不是普通文件。",
      impact: "客户端没有修改正文或同目录其他内容。",
      nextAction: "请检查本机权限和文件状态，然后重新加载。",
      ...details,
    };
  }
  if (code === "INVALID_ENCODING") {
    return {
      code,
      title: "正文编码无法安全解释",
      message: "SKILL.md 不是有效 UTF-8 文本。",
      impact: "客户端只显示受限原始字节预览，不会覆盖原文件。",
      nextAction: "请用外部编辑器转换为 UTF-8 后重新加载。",
      ...details,
    };
  }
  return {
    code,
    title: "正文 frontmatter 无法安全解释",
    message: "SKILL.md 的开头配置不是可安全局部维护的 YAML mapping。",
    impact: "客户端保留完整原文，只提供只读预览和外部修复入口。",
    nextAction: "请用外部编辑器修正 frontmatter 后重新加载。",
    ...details,
  };
}

function decode(bytes: Buffer): { source: string; bom: boolean } {
  const bom = bytes.subarray(0, 3).equals(UTF8_BOM);
  const content = bom ? bytes.subarray(3) : bytes;
  return {
    source: new TextDecoder("utf-8", { fatal: true }).decode(content),
    bom,
  };
}

function lineEnding(source: string): "lf" | "crlf" {
  return source.includes("\r\n") ? "crlf" : "lf";
}

function lineRanges(source: string): readonly { start: number; end: number; text: string }[] {
  const lines: { start: number; end: number; text: string }[] = [];
  let start = 0;
  while (start <= source.length) {
    const lf = source.indexOf("\n", start);
    const end = lf === -1 ? source.length : lf + 1;
    const raw = source.slice(start, lf === -1 ? source.length : lf);
    lines.push({ start, end, text: raw.replace(/\r$/, "") });
    if (lf === -1) break;
    start = lf + 1;
  }
  return lines;
}

function locateFrontmatter(
  source: string,
): { status: "none" } | { status: "valid"; value: FrontmatterSlice } | { status: "invalid"; detail: string } {
  const lines = lineRanges(source);
  if (lines[0]?.text.trimEnd() !== "---") return { status: "none" };
  const failures: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.text.trimEnd() !== "---") continue;
    const contentStart = lines[0]!.end;
    const contentEnd = lines[index]!.start;
    const document = parseDocument(source.slice(contentStart, contentEnd), {
      keepSourceTokens: true,
      logLevel: "silent",
    });
    if (document.errors.length > 0) {
      failures.push(...document.errors.map((error) => error.message));
      continue;
    }
    if (document.contents !== null && !isMap(document.contents)) {
      failures.push("frontmatter must contain a mapping");
      continue;
    }
    const map = (document.contents ?? document.createNode({})) as YAMLMap<unknown, unknown>;
    if (!isMap(map)) continue;
    return {
      status: "valid",
      value: {
        contentStart,
        contentEnd,
        bodyStart: lines[index]!.end,
        document,
        map,
      },
    };
  }
  return {
    status: "invalid",
    detail: failures[0] ?? "frontmatter closing delimiter is missing",
  };
}

function scalarString(
  document: ReturnType<typeof parseDocument>,
  map: YAMLMap<unknown, unknown>,
  key: string,
): string | undefined | null {
  const pair = map.items.find((entry) => {
    const node = entry.key;
    return isScalar(node) && node.value === key;
  });
  if (pair === undefined || pair.value == null) return undefined;
  const node = isAlias(pair.value) ? pair.value.resolve(document) : pair.value;
  if (!isScalar(node) || typeof node.value !== "string") return null;
  return node.value;
}

function parseBytes(bytes: Buffer): ParseSkillResult {
  const revision = documentRevision(bytes);
  let decoded: ReturnType<typeof decode>;
  try {
    decoded = decode(bytes);
  } catch (error) {
    return {
      status: "invalid",
      kind: "encoding",
      revision,
      problem: problem("INVALID_ENCODING", error instanceof Error ? error.message : String(error)),
    };
  }
  const frontmatter = locateFrontmatter(decoded.source);
  if (frontmatter.status === "invalid") {
    return {
      status: "invalid",
      kind: "frontmatter",
      revision,
      source: decoded.source,
      problem: problem("INVALID_FRONTMATTER", frontmatter.detail),
    };
  }
  const values: { name: string; description: string; argumentHint: string } = { name: "", description: "", argumentHint: "" };
  if (frontmatter.status === "valid") {
    const name = scalarString(frontmatter.value.document, frontmatter.value.map, "name");
    const description = scalarString(frontmatter.value.document, frontmatter.value.map, "description");
    const argumentHint = scalarString(frontmatter.value.document, frontmatter.value.map, "argument-hint");
    if (name === null || description === null || argumentHint === null) {
      return {
        status: "invalid",
        kind: "frontmatter",
        revision,
        source: decoded.source,
        problem: problem("INVALID_FRONTMATTER", "owned frontmatter fields must be strings"),
      };
    }
    values.name = name ?? "";
    values.description = description ?? "";
    values.argumentHint = argumentHint ?? "";
  }
  const body = frontmatter.status === "valid"
    ? decoded.source.slice(frontmatter.value.bodyStart)
    : decoded.source;
  const draft = { frontmatter: values, body };
  const view: SkillDocumentView = {
    origin: frontmatter.status === "none" && body.trim().length === 0 ? "new" : "existing",
    revision,
    format: { bom: decoded.bom, lineEnding: lineEnding(decoded.source) },
    draft,
    guidedSections: skillGuidedSections(body),
  };
  return {
    status: "valid",
    value: {
      bytes,
      source: decoded.source,
      bom: decoded.bom,
      lineEnding: view.format.lineEnding,
      ...(frontmatter.status === "valid" ? { frontmatter: frontmatter.value } : {}),
      draft,
      view,
    },
  };
}

function exactSkillPath(pluginDirectory: string, skillDirectory: string): string {
  const authorization = authorizeExistingDirectory(pluginDirectory);
  return resolveAuthorizedPath(authorization, `${skillDirectory}/${SKILL_DOCUMENT_FILENAME}`);
}

function unavailableFrom(error: unknown): Extract<ReadSkillDocumentResult, { status: "unavailable" }> {
  const unsafe = error instanceof AuthorizedPathError;
  return {
    status: "unavailable",
    problem: problem(
      unsafe ? "SKILL_UNSAFE" : "SKILL_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
    ),
  };
}

export function readSkillDocument(
  request: SkillDocumentRequest,
  dependencies: SkillDocumentDependencies = {},
): ReadSkillDocumentResult {
  let path: string;
  try {
    path = exactSkillPath(request.pluginDirectory, request.skillDirectory);
    if (!existsSync(path)) {
      return { status: "unavailable", problem: problem("SKILL_MISSING") };
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_DOCUMENT_BYTES) {
      throw new Error("SKILL.md 不是受支持大小的普通文件");
    }
    const bytes = (dependencies.readSource ?? readFileSync)(path);
    if (bytes.byteLength > MAX_SKILL_DOCUMENT_BYTES) {
      throw new Error("SKILL.md 超过安全大小上限");
    }
    const parsed = parseBytes(bytes);
    if (parsed.status === "valid") {
      return { status: "loaded", sourceBytes: Buffer.from(bytes), document: parsed.value.view };
    }
    const previewBytes = bytes.subarray(0, RAW_PREVIEW_BYTES);
    return {
      status: "uninterpretable",
      kind: parsed.kind,
      revision: parsed.revision,
      problem: parsed.problem,
      preview:
        parsed.kind === "encoding"
          ? { kind: "hex", content: previewBytes.toString("hex"), truncated: bytes.length > previewBytes.length }
          : { kind: "text", content: (parsed.source ?? "").slice(0, RAW_PREVIEW_BYTES), truncated: (parsed.source?.length ?? 0) > RAW_PREVIEW_BYTES },
    };
  } catch (error) {
    return unavailableFrom(error);
  }
}

function pairFor(map: YAMLMap<unknown, unknown>, key: string): Pair<unknown, unknown> | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function yamlScalar(value: string): string {
  const document = new Document(value);
  return document.toString({ lineWidth: 0 }).trimEnd();
}

function patchFrontmatter(
  source: string,
  slice: FrontmatterSlice | undefined,
  original: SkillFrontmatterDraft,
  next: SkillFrontmatterDraft,
  eol: string,
): string {
  const fields = [
    ["name", original.name, next.name],
    ["description", original.description, next.description],
    ["argument-hint", original.argumentHint, next.argumentHint],
  ] as const;
  if (slice === undefined) {
    if (fields.every(([, , value]) => value.length === 0)) return source;
    const header = fields
      .filter(([, , value]) => value.length > 0)
      .map(([key, , value]) => `${key}: ${yamlScalar(value)}`)
      .join(eol);
    return `---${eol}${header}${eol}---${eol}${source}`;
  }
  const block = source.slice(slice.contentStart, slice.contentEnd);
  const replacements: { start: number; end: number; value: string }[] = [];
  const additions: string[] = [];
  for (const [key, before, after] of fields) {
    if (before === after) continue;
    const pair = pairFor(slice.map, key);
    const node = pair?.value as Node | null | undefined;
    if (node?.range != null) {
      replacements.push({ start: node.range[0], end: node.range[1], value: yamlScalar(after) });
    } else if (after.length > 0) {
      additions.push(`${key}: ${yamlScalar(after)}`);
    }
  }
  let patched = block;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    patched = `${patched.slice(0, replacement.start)}${replacement.value}${patched.slice(replacement.end)}`;
  }
  if (additions.length > 0) {
    if (patched.length > 0 && !patched.endsWith("\n")) patched += eol;
    patched += `${additions.join(eol)}${eol}`;
  }
  return `${source.slice(0, slice.contentStart)}${patched}${source.slice(slice.contentEnd)}`;
}

function isDraft(value: SkillDocumentDraft): boolean {
  return (
    typeof value.body === "string" &&
    value.body.length <= MAX_SKILL_DOCUMENT_BYTES &&
    typeof value.frontmatter?.name === "string" &&
    typeof value.frontmatter.description === "string" &&
    typeof value.frontmatter.argumentHint === "string" &&
    value.frontmatter.name.length + value.frontmatter.description.length + value.frontmatter.argumentHint.length <= MAX_SKILL_DOCUMENT_BYTES
  );
}

export function buildSkillDocumentBytes(
  sourceBytes: Uint8Array,
  draft: SkillDocumentDraft,
): BuildSkillDocumentBytesResult {
  if (!isDraft(draft)) {
    return { status: "invalid-input", problem: problem("INVALID_FRONTMATTER", "draft exceeds safe bounds") };
  }
  const parsed = parseBytes(Buffer.from(sourceBytes));
  if (parsed.status === "invalid") {
    return { status: "invalid-source", problem: parsed.problem };
  }
  if (
    parsed.value.draft.body === draft.body &&
    parsed.value.draft.frontmatter.name === draft.frontmatter.name &&
    parsed.value.draft.frontmatter.description === draft.frontmatter.description &&
    parsed.value.draft.frontmatter.argumentHint === draft.frontmatter.argumentHint
  ) {
    return { status: "built", bytes: Buffer.from(sourceBytes) };
  }
  const eol = parsed.value.lineEnding === "crlf" ? "\r\n" : "\n";
  const frontPatched = patchFrontmatter(
    parsed.value.source,
    parsed.value.frontmatter,
    parsed.value.draft.frontmatter,
    draft.frontmatter,
    eol,
  );
  const located = locateFrontmatter(frontPatched);
  const bodyStart = located.status === "valid" ? located.value.bodyStart : 0;
  const nextSource = `${frontPatched.slice(0, bodyStart)}${draft.body}`;
  const encoded = Buffer.from(nextSource, "utf8");
  const bytes = parsed.value.bom ? Buffer.concat([UTF8_BOM, encoded]) : encoded;
  if (bytes.byteLength > MAX_SKILL_DOCUMENT_BYTES) {
    return { status: "invalid-input", problem: problem("INVALID_FRONTMATTER", "document exceeds safe bounds") };
  }
  return { status: "built", bytes };
}

export function saveSkillDocument(
  request: SaveSkillDocumentRequest,
  dependencies: SkillDocumentDependencies = {},
): SaveSkillDocumentResult {
  const loaded = readSkillDocument(request, dependencies);
  if (loaded.status === "unavailable") {
    return { status: "invalid-source", problem: loaded.problem, diskChanged: false, changedPaths: [], cleanupComplete: true };
  }
  if (loaded.status === "uninterpretable") {
    return { status: "invalid-source", problem: loaded.problem, diskChanged: false, changedPaths: [], cleanupComplete: true };
  }
  const built = buildSkillDocumentBytes(loaded.sourceBytes, request.draft);
  if (built.status !== "built") {
    return { status: built.status, problem: built.problem, diskChanged: false, changedPaths: [], cleanupComplete: true };
  }
  let authorization;
  try {
    authorization = authorizeExistingDirectory(request.pluginDirectory);
    const target = resolveAuthorizedPath(authorization, `${request.skillDirectory}/${SKILL_DOCUMENT_FILENAME}`);
    const relativePath = relative(authorization.canonicalPath, target).split(sep).join("/");
    const committed = (dependencies.commit ?? commitAuthorizedDocument)(
      {
        directory: authorization.canonicalPath,
        relativePath,
        expectedRevision: request.expectedRevision,
        nextBytes: built.bytes,
      },
      dependencies.commitDependencies,
    );
    if (committed.status === "committed") return { ...committed, status: "saved" };
    if (committed.status === "verified") return { ...committed, status: "verified" };
    return committed;
  } catch (error) {
    const failure = unavailableFrom(error);
    return { status: "invalid-source", problem: failure.problem, diskChanged: false, changedPaths: [], cleanupComplete: true };
  }
}
