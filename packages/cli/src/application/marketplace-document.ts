import { existsSync, readFileSync } from 'node:fs';
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
} from 'yaml';
import {
  AuthorizedPathError,
  authorizeExistingDirectory,
  resolveAuthorizedPath,
} from '../infrastructure/authorized-path.js';
import {
  commitAuthorizedDocument,
  documentRevision,
  type AtomicDocumentCommitDependencies,
} from '../infrastructure/document-commit.js';
import type {
  MarketplaceDocumentFormat,
  MarketplaceDocumentProblem,
  MarketplaceMetadata,
  MarketplaceMetadataDraft,
  ReadMarketplaceDocumentResult,
  SaveMarketplaceMetadataResult,
} from './marketplace-document-contract.js';
import { MARKETPLACE_FILENAME } from './marketplace-document-contract.js';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const ownedFields = ['name', 'description', 'organization'] as const;
type OwnedField = (typeof ownedFields)[number];

interface ParsedMarketplaceDocument {
  readonly sourceBytes: Buffer;
  readonly source: string;
  readonly document: ReturnType<typeof parseDocument>;
  readonly map: YAMLMap<unknown, unknown>;
  readonly metadata: MarketplaceMetadata;
  readonly draft: MarketplaceMetadataDraft;
  readonly revision: string;
  readonly format: MarketplaceDocumentFormat;
}

type MarketplaceParseFailure =
  | 'invalid-encoding'
  | 'invalid-yaml'
  | 'non-mapping'
  | 'invalid-name'
  | 'unsupported-owned-field';

type ParsedMarketplaceResult =
  | { readonly status: 'valid'; readonly value: ParsedMarketplaceDocument }
  | {
      readonly status: 'invalid';
      readonly revision: string;
      readonly problem: MarketplaceDocumentProblem;
      readonly failure: MarketplaceParseFailure;
    };

export type MarketplaceCompatibilityViewResult =
  | Extract<ReadMarketplaceDocumentResult, { readonly status: 'loaded' }>
  | Extract<ReadMarketplaceDocumentResult, { readonly status: 'unavailable' }>
  | (Extract<ReadMarketplaceDocumentResult, { readonly status: 'invalid' }> & {
      readonly compatibilityFailure:
        | 'non-object'
        | 'invalid-name'
        | 'other';
    });

export interface SaveMarketplaceMetadataRequest {
  readonly directory: string;
  readonly expectedRevision: string;
  readonly draft: MarketplaceMetadataDraft;
}

export interface MarketplaceDocumentDependencies {
  readonly now?: () => Date;
  readonly buildNextBytes?: (
    sourceBytes: Uint8Array,
    draft: MarketplaceMetadataDraft,
  ) => Uint8Array;
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

function problem(
  code: MarketplaceDocumentProblem['code'],
  technicalDetail?: string,
): MarketplaceDocumentProblem {
  if (code === 'MARKETPLACE_MISSING') {
    return {
      code,
      title: '找不到 Marketplace 基础信息',
      message: '当前文件夹中没有 marketplace.yaml。',
      impact: '无法打开结构化编辑；没有创建或修改任何文件。',
      nextAction: '请重新打开有效的 Marketplace，或在外部确认文件位置。',
      ...(technicalDetail === undefined ? {} : { technicalDetail }),
    };
  }
  if (code === 'MARKETPLACE_UNSAFE') {
    return {
      code,
      title: 'Marketplace 基础信息的位置不安全',
      message: 'marketplace.yaml 使用了无法确认授权边界的路径或链接。',
      impact: '结构化编辑已停止，没有覆盖任何文件。',
      nextAction: '请在外部修正文件位置，然后重新打开 Marketplace。',
      ...(technicalDetail === undefined ? {} : { technicalDetail }),
    };
  }
  if (code === 'MARKETPLACE_UNAVAILABLE') {
    return {
      code,
      title: '暂时无法读取 Marketplace 基础信息',
      message: '文件夹或 marketplace.yaml 当前不可访问。',
      impact: '结构化编辑已停止，没有覆盖任何文件。',
      nextAction: '请检查本机权限和文件状态后重新加载。',
      ...(technicalDetail === undefined ? {} : { technicalDetail }),
    };
  }
  if (code === 'INVALID_ENCODING') {
    return {
      code,
      title: 'Marketplace 基础信息的文字编码无法安全读取',
      message: 'marketplace.yaml 不是有效 UTF-8 文本。',
      impact: '客户端不会用结构化表单覆盖这个文件。',
      nextAction: '请在外部编辑器中转换为 UTF-8，然后重新加载。',
      ...(technicalDetail === undefined ? {} : { technicalDetail }),
    };
  }
  if (code === 'INVALID_YAML') {
    return {
      code,
      title: 'Marketplace 基础信息无法解析',
      message: 'marketplace.yaml 不是可安全解释的 YAML 文档。',
      impact: '客户端不会用结构化表单覆盖原文件。',
      nextAction: '请在外部编辑器中修正 YAML，然后重新加载。',
      ...(technicalDetail === undefined ? {} : { technicalDetail }),
    };
  }
  return {
    code,
    title: 'Marketplace 基础信息需要修正',
    message: 'marketplace.yaml 的 name、description 或 organization 不是当前契约支持的文字值。',
    impact: '客户端不会用结构化表单覆盖未能可靠理解的内容。',
    nextAction: '请在外部编辑器中修正基础信息，然后重新加载。',
    ...(technicalDetail === undefined ? {} : { technicalDetail }),
  };
}

function decodeUtf8(bytes: Buffer): {
  readonly source: string;
  readonly bom: boolean;
} {
  const bom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const content = bom ? bytes.subarray(UTF8_BOM.length) : bytes;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return { source: decoder.decode(content), bom };
}

function lineEnding(source: string): 'lf' | 'crlf' {
  return source.includes('\r\n') ? 'crlf' : 'lf';
}

function metadataFromValue(
  value: unknown,
  optionalFieldPolicy: 'strict' | 'ignore-non-string',
): MarketplaceMetadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.trim().length === 0) {
    return undefined;
  }
  if (
    optionalFieldPolicy === 'strict' &&
    ((record.description !== undefined &&
      typeof record.description !== 'string') ||
      (record.organization !== undefined &&
        typeof record.organization !== 'string'))
  ) {
    return undefined;
  }
  return {
    name: record.name.trim(),
    ...(typeof record.description === 'string'
      ? { description: record.description }
      : {}),
    ...(typeof record.organization === 'string'
      ? { organization: record.organization }
      : {}),
  };
}

function editableDraft(metadata: MarketplaceMetadata): MarketplaceMetadataDraft {
  return {
    name: metadata.name,
    description: metadata.description ?? '',
    organization: metadata.organization ?? '',
  };
}

function hasUnsupportedOwnedTag(
  document: ReturnType<typeof parseDocument>,
  map: YAMLMap<unknown, unknown>,
): boolean {
  for (const field of ownedFields) {
    const pair = pairForField(map, field);
    const node = pair?.value;
    if (node == null) continue;
    const resolved = isAlias(node) ? node.resolve(document) : node;
    if (!isScalar(resolved)) continue;
    const tag = resolved.tag;
    if (tag !== undefined && tag !== 'tag:yaml.org,2002:str') {
      return true;
    }
  }
  return false;
}

function parseBytes(
  bytes: Buffer,
  optionalFieldPolicy: 'strict' | 'ignore-non-string' = 'strict',
): ParsedMarketplaceResult {
  const revision = documentRevision(bytes);
  let decoded: ReturnType<typeof decodeUtf8>;
  try {
    decoded = decodeUtf8(bytes);
  } catch (error) {
    return {
      status: 'invalid',
      revision,
      failure: 'invalid-encoding',
      problem: problem(
        'INVALID_ENCODING',
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  const document = parseDocument(decoded.source, {
    keepSourceTokens: true,
    logLevel: 'silent',
  });
  if (document.errors.length > 0) {
    return {
      status: 'invalid',
      revision,
      failure: 'invalid-yaml',
      problem: problem(
        'INVALID_YAML',
        document.errors.map((error) => error.message).join('\n'),
      ),
    };
  }
  if (
    optionalFieldPolicy === 'ignore-non-string' &&
    document.warnings.some((warning) => warning.code === 'TAG_RESOLVE_FAILED')
  ) {
    return {
      status: 'invalid',
      revision,
      failure: 'invalid-yaml',
      problem: problem(
        'INVALID_YAML',
        document.warnings
          .filter((warning) => warning.code === 'TAG_RESOLVE_FAILED')
          .map((warning) => warning.message)
          .join('\n'),
      ),
    };
  }
  if (!isMap(document.contents)) {
    return {
      status: 'invalid',
      revision,
      failure: 'non-mapping',
      problem: problem(
        'INVALID_YAML',
        'marketplace.yaml must contain a mapping',
      ),
    };
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return {
      status: 'invalid',
      revision,
      failure: 'invalid-yaml',
      problem: problem(
        'INVALID_YAML',
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  const metadata = metadataFromValue(value, optionalFieldPolicy);
  if (metadata === undefined) {
    const record =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const invalidName =
      typeof record.name !== 'string' || record.name.trim().length === 0;
    return {
      status: 'invalid',
      revision,
      failure: invalidName ? 'invalid-name' : 'unsupported-owned-field',
      problem: problem('INVALID_METADATA'),
    };
  }
  if (
    optionalFieldPolicy === 'strict' &&
    hasUnsupportedOwnedTag(document, document.contents)
  ) {
    return {
      status: 'invalid',
      revision,
      failure: 'unsupported-owned-field',
      problem: problem(
        'INVALID_METADATA',
        'owned metadata field uses an unsupported explicit YAML tag',
      ),
    };
  }
  return {
    status: 'valid',
    value: {
      sourceBytes: bytes,
      source: decoded.source,
      document,
      map: document.contents,
      metadata,
      draft: editableDraft(metadata),
      revision,
      format: {
        bom: decoded.bom,
        lineEnding: lineEnding(decoded.source),
      },
    },
  };
}

function readMarketplaceBytes(directory: string):
  | { readonly status: 'loaded'; readonly bytes: Buffer }
  | { readonly status: 'unavailable'; readonly problem: MarketplaceDocumentProblem } {
  try {
    const authorization = authorizeExistingDirectory(directory);
    const path = resolveAuthorizedPath(authorization, MARKETPLACE_FILENAME);
    if (!existsSync(path)) {
      return {
        status: 'unavailable',
        problem: problem('MARKETPLACE_MISSING'),
      };
    }
    return { status: 'loaded', bytes: readFileSync(path) };
  } catch (error) {
    const unsafe =
      error instanceof AuthorizedPathError &&
      new Set([
        'ABSOLUTE_PATH',
        'OUTSIDE_AUTHORIZED_ROOT',
        'UNSAFE_SYMLINK',
      ]).has(error.code);
    return {
      status: 'unavailable',
      problem: problem(
        unsafe ? 'MARKETPLACE_UNSAFE' : 'MARKETPLACE_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

export function readMarketplaceDocument(
  directory: string,
): ReadMarketplaceDocumentResult {
  const loaded = readMarketplaceBytes(directory);
  if (loaded.status === 'unavailable') return loaded;
  const parsed = parseBytes(loaded.bytes);
  if (parsed.status === 'invalid') return parsed;
  return {
    status: 'loaded',
    metadata: parsed.value.metadata,
    draft: parsed.value.draft,
    revision: parsed.value.revision,
    format: parsed.value.format,
  };
}

/**
 * Existing CLI/open/health consumers historically ignore non-string optional
 * display fields while still rejecting a non-mapping document or invalid
 * `name`. This compatibility view shares the exact same bytes, UTF-8, YAML
 * Document, alias, and path parser as the strict structured editor, while retaining
 * the former optional-field behavior and unresolved-tag rejection boundary.
 */
export function readMarketplaceCompatibilityView(
  directory: string,
): MarketplaceCompatibilityViewResult {
  const loaded = readMarketplaceBytes(directory);
  if (loaded.status === 'unavailable') return loaded;
  const parsed = parseBytes(loaded.bytes, 'ignore-non-string');
  if (parsed.status === 'invalid') {
    return {
      status: 'invalid',
      revision: parsed.revision,
      problem: parsed.problem,
      compatibilityFailure:
        parsed.failure === 'non-mapping'
          ? 'non-object'
          : parsed.failure === 'invalid-name'
            ? 'invalid-name'
            : 'other',
    };
  }
  return {
    status: 'loaded',
    metadata: parsed.value.metadata,
    draft: parsed.value.draft,
    revision: parsed.value.revision,
    format: parsed.value.format,
  };
}

function pairForField(
  map: YAMLMap<unknown, unknown>,
  field: OwnedField,
): Pair<unknown, unknown> | undefined {
  return map.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === field,
  );
}

function encodeScalar(value: string): string {
  const document = new Document(value);
  return document
    .toString({
      blockQuote: false,
      defaultStringType: 'QUOTE_DOUBLE',
      lineWidth: 0,
    })
    .replace(/\n$/, '');
}

function insertionForMissingFields(
  parsed: ParsedMarketplaceDocument,
  fields: readonly { readonly key: OwnedField; readonly value: string }[],
): { readonly start: number; readonly replacement: string } | undefined {
  if (fields.length === 0) return undefined;
  const range = parsed.map.range;
  if (range == null) {
    throw new Error('YAML Document API did not provide a map source range');
  }
  if (parsed.map.flow) {
    const close = parsed.source.lastIndexOf('}', range[1] - 1);
    if (close < range[0]) {
      throw new Error('无法定位 flow mapping 的结束位置');
    }
    const token = parsed.map.srcToken;
    if (token === undefined || !CST.isCollection(token)) {
      throw new Error('无法确认 flow mapping 的原始 token');
    }
    const trailingItem = token.items.at(-1);
    const hasTrailingComma =
      trailingItem !== undefined &&
      trailingItem.key === undefined &&
      trailingItem.value === undefined &&
      trailingItem.start.some((item) => item.type === 'comma');
    const empty = parsed.map.items.length === 0;
    const prefix =
      hasTrailingComma || empty
        ? /\s/.test(parsed.source[close - 1] ?? '')
          ? ''
          : ' '
        : ', ';
    return {
      start: close,
      replacement:
        prefix +
        fields
          .map(({ key, value }) => `${key}: ${encodeScalar(value)}`)
          .join(', '),
    };
  }

  const eol = parsed.format.lineEnding === 'crlf' ? '\r\n' : '\n';
  const start = range[1];
  const needsLeadingLine =
    start > 0 && parsed.source[start - 1] !== '\n';
  const lines = fields
    .map(({ key, value }) => `${key}: ${encodeScalar(value)}`)
    .join(eol);
  const needsTrailingLine =
    start < parsed.source.length || parsed.source.endsWith('\n');
  return {
    start,
    replacement: `${needsLeadingLine ? eol : ''}${lines}${
      needsTrailingLine ? eol : ''
    }`,
  };
}

function patchBytes(
  parsed: ParsedMarketplaceDocument,
  draft: MarketplaceMetadataDraft,
): Buffer {
  const edits: Array<{
    readonly start: number;
    readonly end: number;
    readonly replacement: string;
  }> = [];
  const missing: Array<{ readonly key: OwnedField; readonly value: string }> = [];

  for (const field of ownedFields) {
    const desired = draft[field];
    const pair = pairForField(parsed.map, field);
    if (pair === undefined) {
      if (field === 'name' || desired.length > 0) {
        missing.push({ key: field, value: desired });
      }
      continue;
    }
    const node = pair.value as Node | null;
    const range = node?.range;
    if (range == null) {
      throw new Error(`无法定位 ${field} 的原始文字范围`);
    }
    const current = parsed.draft[field];
    if (current === desired) continue;
    edits.push({
      start: range[0],
      end: range[1],
      replacement: encodeScalar(desired),
    });
  }

  const insertion = insertionForMissingFields(parsed, missing);
  if (insertion !== undefined) {
    edits.push({
      start: insertion.start,
      end: insertion.start,
      replacement: insertion.replacement,
    });
  }

  let source = parsed.source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    source =
      source.slice(0, edit.start) +
      edit.replacement +
      source.slice(edit.end);
  }
  const encoded = Buffer.from(source, 'utf8');
  return parsed.format.bom
    ? Buffer.concat([UTF8_BOM, encoded])
    : encoded;
}

function normalizedDraft(
  draft: MarketplaceMetadataDraft,
): MarketplaceMetadataDraft {
  return {
    ...draft,
    name: draft.name.trim(),
  };
}

function prepareValidatedPatch(
  parsed: ParsedMarketplaceDocument,
  draft: MarketplaceMetadataDraft,
  buildNextBytes: (
    parsed: ParsedMarketplaceDocument,
    draft: MarketplaceMetadataDraft,
  ) => Uint8Array = patchBytes,
):
  | {
      readonly status: 'ready';
      readonly bytes: Buffer;
      readonly parsed: ParsedMarketplaceDocument;
    }
  | {
      readonly status: 'invalid';
      readonly problem: MarketplaceDocumentProblem;
    } {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(buildNextBytes(parsed, draft));
  } catch (error) {
    return {
      status: 'invalid',
      problem: problem(
        'INVALID_YAML',
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  const reparsed = parseBytes(bytes);
  if (reparsed.status === 'invalid') {
    return { status: 'invalid', problem: reparsed.problem };
  }
  if (
    reparsed.value.draft.name !== draft.name ||
    reparsed.value.draft.description !== draft.description ||
    reparsed.value.draft.organization !== draft.organization
  ) {
    return {
      status: 'invalid',
      problem: problem(
        'INVALID_METADATA',
        'patched document does not project back to the requested metadata',
      ),
    };
  }
  return { status: 'ready', bytes, parsed: reparsed.value };
}

export function patchMarketplaceDocumentBytes(
  bytes: Uint8Array,
  draft: MarketplaceMetadataDraft,
):
  | { readonly status: 'patched'; readonly bytes: Buffer }
  | {
      readonly status: 'invalid';
      readonly revision: string;
      readonly problem: MarketplaceDocumentProblem;
    } {
  const parsed = parseBytes(Buffer.from(bytes));
  if (parsed.status === 'invalid') return parsed;
  const issues = validateDraft(draft);
  if (issues.length > 0) {
    return {
      status: 'invalid',
      revision: parsed.value.revision,
      problem: problem('INVALID_METADATA', issues[0]?.message),
    };
  }
  const prepared = prepareValidatedPatch(
    parsed.value,
    normalizedDraft(draft),
  );
  return prepared.status === 'ready'
    ? { status: 'patched', bytes: prepared.bytes }
    : {
        status: 'invalid',
        revision: parsed.value.revision,
        problem: prepared.problem,
      };
}

function validateDraft(
  draft: MarketplaceMetadataDraft,
): readonly {
  readonly field: keyof MarketplaceMetadataDraft;
  readonly message: string;
}[] {
  const issues: Array<{
    readonly field: keyof MarketplaceMetadataDraft;
    readonly message: string;
  }> = [];
  if (draft.name.trim().length === 0) {
    issues.push({ field: 'name', message: '插件集合名称不能为空。' });
  }
  return issues;
}

export function saveMarketplaceMetadata(
  request: SaveMarketplaceMetadataRequest,
  dependencies: MarketplaceDocumentDependencies = {},
): SaveMarketplaceMetadataResult {
  const issues = validateDraft(request.draft);
  if (issues.length > 0) {
    return {
      status: 'invalid-input',
      issues,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }

  const loaded = readMarketplaceBytes(request.directory);
  if (loaded.status === 'unavailable') {
    return {
      status: 'invalid-source',
      problem: loaded.problem,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  const parsed = parseBytes(loaded.bytes);
  if (parsed.status === 'invalid') {
    return {
      status: 'invalid-source',
      problem: parsed.problem,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  if (parsed.value.revision !== request.expectedRevision) {
    return {
      status: 'conflict',
      currentRevision: parsed.value.revision,
      message: 'marketplace.yaml 已在外部变化；本机草稿仍保留，未覆盖磁盘内容。',
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }

  const requestedDraft = normalizedDraft(request.draft);
  const prepared = prepareValidatedPatch(
    parsed.value,
    requestedDraft,
    dependencies.buildNextBytes === undefined
      ? patchBytes
      : (source, draft) =>
          dependencies.buildNextBytes!(source.sourceBytes, draft),
  );
  if (prepared.status === 'invalid') {
    return {
      status: 'invalid-source',
      problem: prepared.problem,
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  const nextBytes = prepared.bytes;

  const commit = (dependencies.commit ?? commitAuthorizedDocument)(
    {
      directory: request.directory,
      relativePath: MARKETPLACE_FILENAME,
      expectedRevision: request.expectedRevision,
      nextBytes,
    },
    dependencies.commitDependencies,
  );
  if (commit.status === 'conflict') {
    return {
      status: 'conflict',
      currentRevision: commit.currentRevision,
      message: 'marketplace.yaml 在提交前再次发生变化；本机草稿仍保留，未覆盖磁盘内容。',
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }
  if (commit.status === 'busy') return commit;
  if (commit.status === 'failed') return commit;
  if (commit.status === 'verified') {
    return {
      status: 'saved',
      metadata: prepared.parsed.metadata,
      draft: prepared.parsed.draft,
      revision: commit.revision,
      savedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
    };
  }

  return {
    status: 'saved',
    metadata: prepared.parsed.metadata,
    draft: prepared.parsed.draft,
    revision: commit.revision,
    savedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    diskChanged: true,
    changedPaths: commit.changedPaths,
    cleanupComplete: true,
  };
}
