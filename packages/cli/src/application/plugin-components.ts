import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
} from "node:fs";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
  type YAMLMap,
} from "yaml";
import {
  AuthorizedPathError,
  authorizeExistingDirectory,
  resolveAuthorizedPath,
  type AuthorizedRoot,
} from "../infrastructure/authorized-path.js";
import {
  commitAuthorizedDocumentAndFiles,
  documentRevision,
  type AtomicDocumentAndFilesCommitDependencies,
} from "../infrastructure/document-commit.js";
import type {
  PluginComponents,
  PluginHook,
  PluginLsp,
  PluginMcp,
  PluginSkill,
  PluginYaml,
} from "../schema/plugin-yaml.js";
import {
  loadPluginDocumentState,
  pluginDocumentRelativePath,
  type PluginDocumentReadDependencies,
} from "./plugin-document.js";
import {
  type ExecutePluginComponentPlanResult,
  type PlanPluginComponentMutationResult,
  type PluginComponentCollections,
  type PluginComponentFileFact,
  type PluginComponentImpactPreview,
  type PluginComponentIssue,
  type PluginComponentKind,
  type PluginComponentMutation,
  type PluginComponentPlan,
  type PluginComponentValue,
  type ReadPluginComponentsResult,
} from "./plugin-components-contract.js";
import {
  createAddedComponentScaffold,
  type PluginScaffoldFile,
} from "./plugin-scaffold.js";
import {
  parsePluginYamlSource,
  validatePluginYamlValue,
  type PluginSourceSchemaIssue,
} from "./plugin-source.js";
import { isPluginLocalPathReference } from "./workspace-health.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface PluginComponentsRequest {
  readonly directory: string;
  readonly pluginDirectoryName: string;
}

export interface PlanPluginComponentMutationRequest
  extends PluginComponentsRequest {
  readonly expectedRevision: string;
  readonly mutation: PluginComponentMutation;
}

export interface PluginComponentDependencies
  extends PluginDocumentReadDependencies {
  readonly commitDependencies?: AtomicDocumentAndFilesCommitDependencies;
}

interface LoadedComponentDocument {
  readonly workspaceCanonicalPath: string;
  readonly pluginAuthorization: AuthorizedRoot;
  readonly sourceBytes: Buffer;
  readonly source: string;
  readonly bom: boolean;
  readonly lineEnding: "lf" | "crlf";
  readonly revision: string;
  readonly config: PluginYaml;
}

type LoadInternalResult =
  | { readonly status: "loaded"; readonly value: LoadedComponentDocument }
  | Exclude<ReadPluginComponentsResult, { readonly status: "loaded" }>;

const componentKey = {
  skill: "skills",
  mcp: "mcp",
  hook: "hooks",
  lsp: "lsp",
} as const satisfies Record<PluginComponentKind, keyof PluginComponents>;

function collectionsFrom(config: PluginYaml): PluginComponentCollections {
  return {
    skill: structuredClone(config.components.skills ?? []),
    mcp: structuredClone(config.components.mcp ?? []),
    hook: structuredClone(config.components.hooks ?? []),
    lsp: structuredClone(config.components.lsp ?? []),
  };
}

function valuesForKind(
  config: PluginYaml,
  kind: PluginComponentKind,
): PluginComponentValue[] {
  const values = config.components[componentKey[kind]] ?? [];
  return structuredClone(values) as PluginComponentValue[];
}

function loadInternal(
  request: PluginComponentsRequest,
  dependencies: PluginDocumentReadDependencies = {},
): LoadInternalResult {
  const loaded = loadPluginDocumentState(request, dependencies);
  if (loaded.status !== "loaded") {
    const problem = loaded.problem;
    return {
      status: loaded.status,
      message: problem.message,
      impact: problem.impact,
      nextAction: problem.nextAction,
      ...(loaded.status === "invalid" ? { revision: loaded.revision } : {}),
    };
  }
  const bytes = loaded.sourceBytes;
  const bom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const source = bytes.subarray(bom ? UTF8_BOM.length : 0).toString("utf8");
  const parsed = parsePluginYamlSource(source);
  if (parsed.status !== "valid") {
    return {
      status: "invalid",
      message: "当前插件声明还不能安全维护组件。",
      impact: "组件表单不会覆盖无效源文件；已有内容保持不变。",
      nextAction: "请先修正插件基础信息中的阻塞问题，再重新加载。",
      revision: documentRevision(bytes),
    };
  }
  try {
    const workspace = authorizeExistingDirectory(request.directory);
    const pluginPath = resolveAuthorizedPath(
      workspace,
      `plugins/${request.pluginDirectoryName}`,
    );
    const pluginAuthorization = authorizeExistingDirectory(pluginPath);
    return {
      status: "loaded",
      value: {
        workspaceCanonicalPath: workspace.canonicalPath,
        pluginAuthorization,
        sourceBytes: Buffer.from(bytes),
        source,
        bom,
        lineEnding: source.includes("\r\n") ? "crlf" : "lf",
        revision: documentRevision(bytes),
        config: parsed.value,
      },
    };
  } catch (error) {
    return {
      status: "unavailable",
      message: "当前插件文件夹无法确认授权。",
      impact: "组件和关联文件保持不变。",
      nextAction: "请重新检查 Marketplace 或文件夹权限。",
    };
  }
}

function pairForKey(
  map: YAMLMap<unknown, unknown>,
  key: string,
): Pair<unknown, unknown> | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function lineIndent(source: string, offset: number): string {
  const start = source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const indent = source.slice(start, offset);
  if (!/^[ \t]*$/.test(indent)) {
    throw new Error("无法确认组件声明的缩进");
  }
  return indent;
}

function serializeSequence(
  values: readonly PluginComponentValue[],
  continuationIndent: string,
  eol: string,
): string {
  if (values.length === 0) return "[]";
  const serialized = new Document(values).toString({
    lineWidth: 0,
    blockQuote: false,
  });
  const normalized = serialized.replace(/\n$/, "").replaceAll("\n", eol);
  return normalized.replaceAll(eol, `${eol}${continuationIndent}`);
}

function serializeInlineValue(value: unknown): string {
  const document = new Document();
  document.contents = document.createNode(value, { flow: true });
  return document
    .toString({ lineWidth: 0, blockQuote: false })
    .replace(/\n$/, "");
}

interface SourceTokenPart {
  readonly offset?: number;
}

interface CollectionItemToken {
  readonly start?: readonly SourceTokenPart[];
}

interface CollectionToken {
  readonly items?: readonly CollectionItemToken[];
}

interface TextPatch {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

function tokenStart(
  item: CollectionItemToken | undefined,
  fallback: number,
): number {
  return item?.start?.find((part) => part.offset !== undefined)?.offset ?? fallback;
}

function applyTextPatches(source: string, patches: readonly TextPatch[]): string {
  const ordered = [...patches].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  );
  let previousStart = source.length + 1;
  let next = source;
  for (const patch of ordered) {
    if (
      patch.start < 0 ||
      patch.end < patch.start ||
      patch.end > source.length ||
      patch.end > previousStart
    ) {
      throw new Error("组件最小补丁范围发生重叠");
    }
    next =
      next.slice(0, patch.start) + patch.replacement + next.slice(patch.end);
    previousStart = patch.start;
  }
  return next;
}

function editComponentItem(
  source: string,
  item: YAMLMap<unknown, unknown>,
  previousValue: PluginComponentValue,
  nextValue: PluginComponentValue,
  eol: string,
): string {
  if (item.flow || item.range == null) {
    throw new Error("目标组件不是可最小修改的 block mapping");
  }
  const previous = previousValue as unknown as Record<string, unknown>;
  const next = nextValue as unknown as Record<string, unknown>;
  const pairTokens = (item.srcToken as CollectionToken | undefined)?.items;
  const patches: TextPatch[] = [];
  const existingKeys = new Set<string>();

  for (const [pairIndex, pair] of item.items.entries()) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new Error("目标组件包含无法定位的字段 key");
    }
    const key = pair.key.value;
    existingKeys.add(key);
    const had = Object.hasOwn(previous, key);
    const has = Object.hasOwn(next, key);
    if (!had || (has && isDeepStrictEqual(previous[key], next[key]))) continue;

    if (!has) {
      const keyRange = pair.key.range;
      if (keyRange == null) throw new Error(`无法定位目标组件字段 ${key}`);
      const nextPair = item.items[pairIndex + 1];
      const nextKey = nextPair?.key as Node | null | undefined;
      const start =
        pairIndex === 0
          ? keyRange[0]
          : tokenStart(pairTokens?.[pairIndex], keyRange[0]);
      const end =
        pairIndex === 0 && nextPair !== undefined
          ? tokenStart(pairTokens?.[pairIndex + 1], nextKey?.range?.[0] ?? item.range[1])
          : nextPair === undefined
            ? item.range[1]
            : tokenStart(pairTokens?.[pairIndex + 1], nextKey?.range?.[0] ?? item.range[1]);
      patches.push({
        start,
        end,
        replacement: pairIndex === 0 && nextPair !== undefined ? eol : "",
      });
      continue;
    }

    const value = pair.value as Node | null;
    if (
      value == null ||
      value.range == null ||
      isAlias(value) ||
      value.anchor !== undefined
    ) {
      throw new Error(`目标组件字段 ${key} 不能安全最小修改`);
    }
    patches.push({
      start: value.range[0],
      end: value.range[1],
      replacement: `${serializeInlineValue(next[key])}${
        source.slice(value.range[0], value.range[1]).endsWith("\r\n")
          ? "\r\n"
          : source.slice(value.range[0], value.range[1]).endsWith("\n")
            ? "\n"
            : ""
      }`,
    });
  }

  const additions = Object.keys(next).filter((key) => !existingKeys.has(key));
  if (additions.length > 0) {
    const lastPair = item.items.at(-1);
    const lastKey = lastPair?.key as Node | null | undefined;
    if (lastKey?.range == null) {
      throw new Error("无法定位目标组件新增字段的缩进");
    }
    const indent = lineIndent(source, lastKey.range[0]);
    patches.push({
      start: item.range[1],
      end: item.range[1],
      replacement: additions
        .map((key) => `${indent}${key}: ${serializeInlineValue(next[key])}${eol}`)
        .join(""),
    });
  }
  return applyTextPatches(source, patches);
}

function patchComponentSequence(
  loaded: LoadedComponentDocument,
  mutation: PluginComponentMutation,
):
  | { readonly status: "patched"; readonly bytes: Buffer }
  | { readonly status: "unsafe"; readonly message: string } {
  const document = parseDocument(loaded.source, {
    keepSourceTokens: true,
    logLevel: "silent",
  });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    return { status: "unsafe", message: "plugin.yaml 不是可局部修改的 mapping" };
  }
  const componentsPair = pairForKey(document.contents, "components");
  const componentsNode = componentsPair?.value as Node | null | undefined;
  if (
    componentsPair === undefined ||
    componentsNode == null ||
    isAlias(componentsNode) ||
    !isMap(componentsNode) ||
    componentsNode.range == null
  ) {
    return {
      status: "unsafe",
      message: "components 使用了别名或非 mapping 结构",
    };
  }
  const key = componentKey[mutation.kind];
  const pair = pairForKey(componentsNode, key);
  const eol = loaded.lineEnding === "crlf" ? "\r\n" : "\n";
  let nextSource: string;
  try {
    if (pair !== undefined) {
      const node = pair.value as Node | null;
      if (
        node == null ||
        isAlias(node) ||
        !isSeq(node) ||
        node.range == null ||
        node.items.some((item) => {
          const componentNode = item as Node | null;
          return (
            componentNode != null &&
            (isAlias(componentNode) || componentNode.anchor !== undefined)
          );
        })
      ) {
        return {
          status: "unsafe",
          message: `${key} 使用了当前不能安全局部维护的 anchor/alias 结构`,
        };
      }
      if (node.flow) {
        if (
          mutation.operation !== "add" ||
          node.items.length !== 0 ||
          loaded.source.slice(node.range[0], node.range[1]).trim() !== "[]"
        ) {
          return {
            status: "unsafe",
            message: `${key} 使用了当前不能安全局部维护的 flow 结构`,
          };
        }
        const pairKey = pair.key as Node | null;
        if (pairKey?.range == null) {
          return { status: "unsafe", message: `无法定位 ${key} 字段` };
        }
        const indent = `${lineIndent(loaded.source, pairKey.range[0])}  `;
        let replacementStart = node.range[0];
        while (
          replacementStart > pairKey.range[1] &&
          (loaded.source[replacementStart - 1] === " " ||
            loaded.source[replacementStart - 1] === "\t")
        ) {
          replacementStart -= 1;
        }
        const nodeEnd = node.range[2] ?? node.range[1];
        const trailing = loaded.source.slice(node.range[1], nodeEnd);
        const hadLineEnding = trailing.endsWith(eol);
        const inlineSuffix = hadLineEnding
          ? trailing.slice(0, -eol.length)
          : trailing;
        if (inlineSuffix.trim().length > 0) {
          if (
            node.comment === undefined ||
            !/^[ \t]+#[^\r\n]*$/.test(inlineSuffix)
          ) {
            return {
              status: "unsafe",
              message: `${key} 的空 flow sequence 尾部无法安全保留`,
            };
          }
          nextSource = applyTextPatches(loaded.source, [
            {
              start: replacementStart,
              end: nodeEnd,
              replacement: `${inlineSuffix}${eol}${indent}${serializeSequence(
                [mutation.value],
                indent,
                eol,
              )}${hadLineEnding ? eol : ""}`,
            },
          ]);
        } else {
          nextSource = applyTextPatches(loaded.source, [
            {
              start: replacementStart,
              end: node.range[1],
              replacement: `${eol}${indent}${serializeSequence([mutation.value], indent, eol)}`,
            },
          ]);
        }
      } else if (mutation.operation === "add") {
        const indent = lineIndent(loaded.source, node.range[0]);
        const leading =
          node.range[1] > 0 && loaded.source[node.range[1] - 1] !== "\n"
            ? eol
            : "";
        nextSource = applyTextPatches(loaded.source, [
          {
            start: node.range[1],
            end: node.range[1],
            replacement: `${leading}${indent}${serializeSequence([mutation.value], indent, eol)}${eol}`,
          },
        ]);
      } else {
        const target = node.items[mutation.index] as Node | null | undefined;
        if (target == null || target.range == null || !isMap(target)) {
          return {
            status: "unsafe",
            message: `无法定位 ${key} 中的目标组件`,
          };
        }
        if (mutation.operation === "edit") {
          const previous = valuesForKind(loaded.config, mutation.kind)[mutation.index];
          if (previous === undefined) {
            return { status: "unsafe", message: `无法读取 ${key} 中的目标组件` };
          }
          nextSource = editComponentItem(
            loaded.source,
            target,
            previous,
            mutation.value,
            eol,
          );
        } else if (node.items.length === 1) {
          const original = loaded.source.slice(node.range[0], node.range[1]);
          const trailing = original.endsWith("\r\n")
            ? "\r\n"
            : original.endsWith("\n")
              ? "\n"
              : "";
          nextSource = applyTextPatches(loaded.source, [
            {
              start: node.range[0],
              end: node.range[1],
              replacement: `[]${trailing}`,
            },
          ]);
        } else {
          const sequenceTokens = (node.srcToken as CollectionToken | undefined)?.items;
          const start = tokenStart(sequenceTokens?.[mutation.index], target.range[0]);
          const nextTarget = node.items[mutation.index + 1] as Node | null | undefined;
          const end =
            nextTarget == null
              ? node.range[1]
              : tokenStart(
                  sequenceTokens?.[mutation.index + 1],
                  nextTarget.range?.[0] ?? node.range[1],
                );
          nextSource = applyTextPatches(loaded.source, [
            { start, end, replacement: "" },
          ]);
        }
      }
    } else {
      if (mutation.operation !== "add") {
        return { status: "unsafe", message: `无法定位 ${key} 组件序列` };
      }
      if (componentsNode.flow) {
        return {
          status: "unsafe",
          message: "flow components mapping 不能安全插入新的组件类型",
        };
      }
      const componentsKey = componentsPair.key as Node | null;
      if (componentsKey?.range == null) {
        return { status: "unsafe", message: "无法定位 components 字段" };
      }
      const childIndent = `${lineIndent(loaded.source, componentsKey.range[0])}  `;
      const sequenceIndent = `${childIndent}  `;
      const serialized = serializeSequence([mutation.value], sequenceIndent, eol);
      const insertionPoint = componentsNode.range[1];
      const leading =
        insertionPoint > 0 && loaded.source[insertionPoint - 1] !== "\n"
          ? eol
          : "";
      const insertion = `${leading}${childIndent}${key}:${eol}${sequenceIndent}${serialized}${eol}`;
      nextSource =
        loaded.source.slice(0, insertionPoint) +
        insertion +
        loaded.source.slice(insertionPoint);
    }
  } catch (error) {
    return {
      status: "unsafe",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const encoded = Buffer.from(nextSource, "utf8");
  return {
    status: "patched",
    bytes: loaded.bom ? Buffer.concat([UTF8_BOM, encoded]) : encoded,
  };
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

function schemaIssue(
  issue: PluginSourceSchemaIssue,
  index: number,
  fallbackKind: PluginComponentKind,
): PluginComponentIssue {
  const path = technicalPath(issue);
  const match = path.match(/^\/components\/(skills|mcp|hooks|lsp)\/(\d+)(?:\/(.*))?/);
  const kind =
    match?.[1] === "skills"
      ? "skill"
      : match?.[1] === "hooks"
        ? "hook"
        : match?.[1] === "mcp"
          ? "mcp"
          : match?.[1] === "lsp"
            ? "lsp"
            : fallbackKind;
  const field = match?.[3] ?? "component";
  return {
    id: `component-schema-${String(index + 1).padStart(3, "0")}`,
    severity: "blocking",
    kind,
    ...(match?.[2] === undefined ? {} : { index: Number(match[2]) }),
    field,
    title: "组件信息还不完整",
    message: "这项组件信息不符合当前插件格式。",
    impact: "保存会停止，磁盘上的插件声明和关联文件保持不变。",
    nextAction: "请修正标出的组件字段后重新预览。",
    technicalPath: path,
  };
}

function duplicateIssues(
  collections: PluginComponentCollections,
): PluginComponentIssue[] {
  const issues: PluginComponentIssue[] = [];
  const check = (
    kind: PluginComponentKind,
    values: readonly string[],
    field: string,
    label: string,
  ) => {
    const first = new Map<string, number>();
    for (const [index, value] of values.entries()) {
      const existing = first.get(value);
      if (existing === undefined) {
        first.set(value, index);
        continue;
      }
      issues.push({
        id: `component-duplicate-${kind}-${index}`,
        severity: "blocking",
        kind,
        index,
        field,
        title: `${label}重复`,
        message: `第 ${existing + 1} 项与第 ${index + 1} 项使用了相同${label}。`,
        impact: "CLI 与客户端都无法可靠定位要维护的具体组件。",
        nextAction: `请为每项${label}使用不同内容。`,
        technicalPath: `/components/${componentKey[kind]}/${index}/${field}`,
      });
    }
  };
  check("skill", collections.skill.map((item) => item.name), "name", "Skill 名称");
  check("skill", collections.skill.map((item) => item.path), "path", "Skill 路径");
  check("mcp", collections.mcp.map((item) => item.name), "name", "MCP 名称");
  check("lsp", collections.lsp.map((item) => item.name), "name", "语言服务名称");
  check("hook", collections.hook.map((item) => item.command), "command", "Hook 文件");
  return issues;
}

function semanticIssues(
  collections: PluginComponentCollections,
): PluginComponentIssue[] {
  const issues = duplicateIssues(collections);
  for (const [index, lsp] of collections.lsp.entries()) {
    if (lsp.startupTimeout != null && lsp.startupTimeout < 0) {
      issues.push({
        id: `component-lsp-timeout-${index}`,
        severity: "blocking",
        kind: "lsp",
        index,
        field: "startupTimeout",
        title: "启动等待时间不能小于零",
        message: "语言服务需要使用零或正数的启动等待时间。",
        impact: "保存会停止，现有声明保持不变。",
        nextAction: "请填写零或更大的毫秒数。",
        technicalPath: `/components/lsp/${index}/startupTimeout`,
      });
    }
    if (lsp.maxRestarts != null && lsp.maxRestarts < 0) {
      issues.push({
        id: `component-lsp-restarts-${index}`,
        severity: "blocking",
        kind: "lsp",
        index,
        field: "maxRestarts",
        title: "自动重试次数不能小于零",
        message: "语言服务需要使用零或正数的重试次数。",
        impact: "保存会停止，现有声明保持不变。",
        nextAction: "请填写零或更大的次数。",
        technicalPath: `/components/lsp/${index}/maxRestarts`,
      });
    }
    for (const [extension, language] of Object.entries(lsp.extensionToLanguage)) {
      if (!extension.startsWith(".")) {
        issues.push({
          id: `component-lsp-extension-${index}-${issues.length}`,
          severity: "blocking",
          kind: "lsp",
          index,
          field: "extensionToLanguage",
          title: "文件扩展名需要以点号开头",
          message: `“${extension}”不是可识别的文件扩展名。`,
          impact: "语言服务无法把文件映射到正确语言。",
          nextAction: "请改为例如 .ts 或 .py 的形式。",
          technicalPath: `/components/lsp/${index}/extensionToLanguage/${extension}`,
        });
      }
      if (language.trim().length === 0) {
        issues.push({
          id: `component-lsp-language-${index}-${issues.length}`,
          severity: "blocking",
          kind: "lsp",
          index,
          field: "extensionToLanguage",
          title: "语言标识不能为空",
          message: `“${extension}”还没有对应的语言标识。`,
          impact: "语言服务无法识别这类文件。",
          nextAction: "请填写语言服务支持的 language id。",
          technicalPath: `/components/lsp/${index}/extensionToLanguage/${extension}`,
        });
      }
    }
  }
  return issues;
}

function permissions(path: string) {
  const allowed = (mode: number) => {
    try {
      accessSync(path, mode);
      return true;
    } catch {
      return false;
    }
  };
  return {
    readable: allowed(fsConstants.R_OK),
    writable: allowed(fsConstants.W_OK),
    executable: allowed(fsConstants.X_OK),
  };
}

function fileFact(
  authorization: AuthorizedRoot,
  input: {
    readonly kind: PluginComponentKind;
    readonly componentIndex: number;
    readonly role: PluginComponentFileFact["role"];
    readonly configuredPath: string;
    readonly expected: "file" | "directory";
  },
): PluginComponentFileFact {
  const emptyPermissions = {
    readable: false,
    writable: false,
    executable: false,
  };
  try {
    const path = resolveAuthorizedPath(authorization, input.configuredPath);
    if (!existsSync(path)) {
      return {
        ...input,
        state: "missing",
        objectType: "unknown",
        permissions: emptyPermissions,
        canReveal: false,
        canOpenExternally: false,
        message: "关联对象不存在。",
      };
    }
    const stat = lstatSync(path);
    const objectType = stat.isFile()
      ? "file"
      : stat.isDirectory()
        ? "directory"
        : "other";
    const validType = objectType === input.expected;
    const access = permissions(path);
    return {
      ...input,
      state: validType ? "present" : "wrong-type",
      objectType,
      permissions: access,
      canReveal: validType,
      canOpenExternally: validType && access.readable,
      message: validType
        ? `对象存在；${access.readable ? "可读取" : "不可读取"}，${access.writable ? "可写入" : "只读"}${input.expected === "file" ? `，${access.executable ? "可执行" : "不可执行"}` : ""}。`
        : `关联位置不是${input.expected === "file" ? "普通文件" : "文件夹"}。`,
    };
  } catch (error) {
    const unsafe =
      error instanceof AuthorizedPathError &&
      (error.code === "ABSOLUTE_PATH" ||
        error.code === "OUTSIDE_AUTHORIZED_ROOT" ||
        error.code === "UNSAFE_SYMLINK");
    return {
      ...input,
      state: unsafe ? "unsafe" : "unavailable",
      objectType: "unknown",
      permissions: emptyPermissions,
      canReveal: false,
      canOpenExternally: false,
      message: unsafe
        ? "关联位置不是当前插件内的安全对象。"
        : "暂时无法确认关联对象状态。",
    };
  }
}

function externalCommandFact(
  kind: "mcp" | "lsp",
  componentIndex: number,
  command: string,
): PluginComponentFileFact {
  return {
    kind,
    componentIndex,
    role: "command",
    configuredPath: command,
    state: "external-command",
    objectType: "unknown",
    permissions: { readable: false, writable: false, executable: false },
    canReveal: false,
    canOpenExternally: false,
    message: "这是由系统环境提供的命令，不是插件内文件。",
  };
}

function inspectFiles(
  authorization: AuthorizedRoot,
  collections: PluginComponentCollections,
): PluginComponentFileFact[] {
  const facts: PluginComponentFileFact[] = [];
  for (const [index, skill] of collections.skill.entries()) {
    facts.push(
      fileFact(authorization, {
        kind: "skill",
        componentIndex: index,
        role: "skill-directory",
        configuredPath: skill.path,
        expected: "directory",
      }),
      fileFact(authorization, {
        kind: "skill",
        componentIndex: index,
        role: "skill-document",
        configuredPath: `${skill.path}/SKILL.md`,
        expected: "file",
      }),
    );
  }
  for (const [index, hook] of collections.hook.entries()) {
    facts.push(
      fileFact(authorization, {
        kind: "hook",
        componentIndex: index,
        role: "hook-script",
        configuredPath: hook.command,
        expected: "file",
      }),
    );
  }
  const commandFacts = (
    kind: "mcp" | "lsp",
    values: readonly (PluginMcp | PluginLsp)[],
  ) => {
    for (const [index, value] of values.entries()) {
      if (!("command" in value)) continue;
      facts.push(
        isPluginLocalPathReference(value.command)
          ? fileFact(authorization, {
              kind,
              componentIndex: index,
              role: "command",
              configuredPath: value.command,
              expected: "file",
            })
          : externalCommandFact(kind, index, value.command),
      );
      for (const argument of value.args ?? []) {
        if (!isPluginLocalPathReference(argument)) continue;
        facts.push(
          fileFact(authorization, {
            kind,
            componentIndex: index,
            role: "argument",
            configuredPath: argument,
            expected: "file",
          }),
        );
      }
      if (
        kind === "lsp" &&
        "workspaceFolder" in value &&
        typeof value.workspaceFolder === "string" &&
        value.workspaceFolder.length > 0
      ) {
        facts.push(
          fileFact(authorization, {
            kind,
            componentIndex: index,
            role: "workspace-folder",
            configuredPath: value.workspaceFolder,
            expected: "directory",
          }),
        );
      }
    }
  };
  commandFacts("mcp", collections.mcp);
  commandFacts("lsp", collections.lsp);
  return facts;
}

function localPathIssues(
  facts: readonly PluginComponentFileFact[],
): PluginComponentIssue[] {
  return facts
    .filter((fact) => fact.state === "unsafe")
    .map((fact, index) => ({
      id: `component-path-${String(index + 1).padStart(3, "0")}`,
      severity: "blocking" as const,
      kind: fact.kind,
      index: fact.componentIndex,
      field:
        fact.role === "skill-directory"
          ? "path"
          : fact.role === "workspace-folder"
            ? "workspaceFolder"
            : fact.role === "command"
              ? "command"
              : "args",
      title: "关联位置不在当前插件内",
      message: "绝对路径、越界路径和符号链接不能作为受控组件文件。",
      impact: "保存和系统文件动作都会停止，避免访问未授权对象。",
      nextAction: "请改用当前插件内的相对路径。",
      technicalPath: `/components/${componentKey[fact.kind]}/${fact.componentIndex}`,
    }));
}

function issuesFor(
  config: PluginYaml,
  authorization: AuthorizedRoot,
): { readonly issues: PluginComponentIssue[]; readonly files: PluginComponentFileFact[] } {
  const collections = collectionsFrom(config);
  const files = inspectFiles(authorization, collections);
  return {
    issues: [...semanticIssues(collections), ...localPathIssues(files)],
    files,
  };
}

export function readPluginComponents(
  request: PluginComponentsRequest,
  dependencies: PluginDocumentReadDependencies = {},
): ReadPluginComponentsResult {
  const loaded = loadInternal(request, dependencies);
  if (loaded.status !== "loaded") return loaded;
  const inspected = issuesFor(
    loaded.value.config,
    loaded.value.pluginAuthorization,
  );
  return {
    status: "loaded",
    canonicalName: loaded.value.config.name,
    revision: loaded.value.revision,
    collections: collectionsFrom(loaded.value.config),
    issues: inspected.issues,
    files: inspected.files,
  };
}

function mutationIndexIsValid(
  values: readonly PluginComponentValue[],
  mutation: PluginComponentMutation,
): boolean {
  return (
    mutation.operation === "add" ||
    (Number.isSafeInteger(mutation.index) &&
      mutation.index >= 0 &&
      mutation.index < values.length)
  );
}

function candidateFor(
  loaded: LoadedComponentDocument,
  mutation: PluginComponentMutation,
):
  | {
      readonly status: "ready";
      readonly config: PluginYaml;
      readonly values: readonly PluginComponentValue[];
    }
  | { readonly status: "invalid"; readonly message: string } {
  const values = valuesForKind(loaded.config, mutation.kind);
  if (!mutationIndexIsValid(values, mutation)) {
    return {
      status: "invalid",
      message: "要维护的组件已经变化，请重新加载后再试。",
    };
  }
  if (mutation.operation === "add") values.push(structuredClone(mutation.value));
  if (mutation.operation === "edit") {
    values[mutation.index] = structuredClone(mutation.value);
  }
  if (mutation.operation === "remove") values.splice(mutation.index, 1);
  const candidate = structuredClone(loaded.config);
  (candidate.components as Record<string, unknown>)[componentKey[mutation.kind]] = values;
  return { status: "ready", config: candidate, values };
}

function scaffoldFor(
  loaded: LoadedComponentDocument,
  mutation: PluginComponentMutation,
): readonly PluginScaffoldFile[] {
  if (mutation.operation !== "add" || !mutation.createScaffold) return [];
  if (mutation.kind !== "skill" && mutation.kind !== "hook") return [];
  const value = mutation.value;
  if (mutation.kind === "skill") {
    const skill = value as PluginSkill;
    const template = createAddedComponentScaffold("skill", skill.name)[0];
    return template === undefined
      ? []
      : [
          {
            ...template,
            relativePath: `${skill.path}/SKILL.md`,
          },
        ];
  }
  const hook = value as PluginHook;
  const stem = basename(hook.command).replace(/\.sh$/i, "") || "hook";
  const template = createAddedComponentScaffold("hook", stem)[0];
  return template === undefined
    ? []
    : [{ ...template, relativePath: hook.command.replace(/^\.\//, "") }];
}

function generatedForKind(kind: PluginComponentKind): readonly string[] {
  return [
    "plugin.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ...(kind === "mcp" ? ["mcp.json", ".mcp.json"] : []),
    ...(kind === "hook" ? ["hooks/hooks.json"] : []),
    ...(kind === "lsp" ? [".lsp.json"] : []),
  ];
}

function componentLabel(kind: PluginComponentKind): string {
  return { skill: "Skill", mcp: "MCP", hook: "Hook", lsp: "语言服务" }[kind];
}

function retainedFilesForRemoval(
  config: PluginYaml,
  mutation: PluginComponentMutation,
): readonly string[] {
  if (mutation.operation !== "remove") return [];
  const values = valuesForKind(config, mutation.kind);
  const value = values[mutation.index];
  if (value === undefined) return [];
  if (mutation.kind === "skill") return [(value as PluginSkill).path];
  if (mutation.kind === "hook") return [(value as PluginHook).command];
  const commandValue = value as PluginMcp | PluginLsp;
  if (!("command" in commandValue)) return [];
  const command = commandValue.command;
  return isPluginLocalPathReference(command) ? [command] : [];
}

function impactFor(
  loaded: LoadedComponentDocument,
  pluginDirectoryName: string,
  mutation: PluginComponentMutation,
  scaffolds: readonly PluginScaffoldFile[],
): PluginComponentImpactPreview {
  const label = componentLabel(mutation.kind);
  const verb =
    mutation.operation === "add"
      ? "添加"
      : mutation.operation === "edit"
        ? "更新"
        : "移除";
  const retained = retainedFilesForRemoval(loaded.config, mutation);
  return {
    operation: mutation.operation,
    kind: mutation.kind,
    title: `${verb}${label}声明`,
    summary:
      mutation.operation === "remove"
        ? `只从插件声明中移除这项${label}；关联用户文件默认保留。`
        : `${verb}这项${label}的源声明${scaffolds.length > 0 ? "及必要初始文件" : ""}。`,
    canonicalChanges: [
      `plugins/${pluginDirectoryName}/plugin.yaml 中的 ${label} 声明`,
    ],
    generatedResults: generatedForKind(mutation.kind),
    retainedUserFiles: retained,
    scaffoldFiles: scaffolds.map((file) => file.relativePath),
    generatedAction: "none",
  };
}

function planFingerprint(plan: Omit<PluginComponentPlan, "fingerprint">): string {
  const hash = createHash("sha256");
  hash.update(plan.workspaceCanonicalPath);
  hash.update("\0");
  hash.update(plan.pluginDirectoryName);
  hash.update("\0");
  hash.update(plan.expectedRevision);
  hash.update("\0");
  hash.update(plan.nextBytes);
  for (const file of plan.createFiles) {
    hash.update("\0");
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.mode));
    hash.update("\0");
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

export function planPluginComponentMutation(
  request: PlanPluginComponentMutationRequest,
  dependencies: PluginDocumentReadDependencies = {},
): PlanPluginComponentMutationResult {
  const loaded = loadInternal(request, dependencies);
  if (loaded.status !== "loaded") {
    return { ...loaded, issues: [] };
  }
  if (loaded.value.revision !== request.expectedRevision) {
    return {
      status: "conflict",
      currentRevision: loaded.value.revision,
      message: "插件声明已在外部变化；没有创建或修改任何文件。",
    };
  }
  const candidate = candidateFor(loaded.value, request.mutation);
  if (candidate.status === "invalid") {
    return {
      status: "invalid",
      message: candidate.message,
      impact: "当前组件草稿和磁盘内容保持不变。",
      nextAction: "请重新加载组件列表。",
      issues: [],
    };
  }
  const schema = validatePluginYamlValue(candidate.config);
  const schemaProblems =
    schema.status === "valid"
      ? []
      : schema.issues.map((issue, index) =>
          schemaIssue(issue, index, request.mutation.kind),
        );
  const semantic = semanticIssues(collectionsFrom(candidate.config));
  const candidateFiles = inspectFiles(
    loaded.value.pluginAuthorization,
    collectionsFrom(candidate.config),
  );
  const pathProblems = localPathIssues(candidateFiles);
  const issues = [...schemaProblems, ...semantic, ...pathProblems];
  if (issues.some((issue) => issue.severity === "blocking")) {
    return {
      status: "invalid",
      message: "组件信息还有阻塞问题。",
      impact: "没有修改 plugin.yaml 或关联文件。",
      nextAction: issues[0]?.nextAction ?? "请修正组件信息后重试。",
      issues,
    };
  }
  const patched = patchComponentSequence(
    loaded.value,
    request.mutation,
  );
  if (patched.status === "unsafe") {
    return {
      status: "invalid",
      message: "当前组件结构无法安全局部改写。",
      impact: "客户端保留原文件，不会整份重写 plugin.yaml。",
      nextAction: "请在外部编辑器中整理该组件数组后重新加载。",
      issues: [
        {
          id: "component-unsafe-structure",
          severity: "blocking",
          kind: request.mutation.kind,
          field: "component",
          title: "组件结构需要外部处理",
          message: patched.message,
          impact: "结构化保存已停止。",
          nextAction: "请在外部编辑器中处理后重新加载。",
          technicalPath: `/components/${componentKey[request.mutation.kind]}`,
        },
      ],
    };
  }
  const reparsed = parsePluginYamlSource(
    patched.bytes
      .subarray(patched.bytes.subarray(0, 3).equals(UTF8_BOM) ? 3 : 0)
      .toString("utf8"),
  );
  if (reparsed.status !== "valid") {
    return {
      status: "invalid",
      message: "组件局部修改后的文档无法重新验证。",
      impact: "没有修改磁盘文件。",
      nextAction: "请检查组件字段或在外部修正源文件。",
      issues,
    };
  }
  const scaffolds = scaffoldFor(loaded.value, request.mutation);
  for (const file of scaffolds) {
    try {
      const path = resolveAuthorizedPath(
        loaded.value.pluginAuthorization,
        file.relativePath,
      );
      if (existsSync(path)) {
        return {
          status: "invalid",
          message: "需要创建的初始文件已经存在。",
          impact: "客户端不会覆盖已有用户文件；plugin.yaml 保持不变。",
          nextAction: "请保留现有文件并关闭“创建初始文件”，或选择其他组件位置。",
          issues: [],
        };
      }
    } catch {
      return {
        status: "invalid",
        message: "初始文件位置不在当前插件的安全范围内。",
        impact: "没有修改任何文件。",
        nextAction: "请改用当前插件内的相对路径。",
        issues: [],
      };
    }
  }
  const createFiles = scaffolds.map((file) => ({
    relativePath: `plugins/${request.pluginDirectoryName}/${file.relativePath}`,
    bytes: Buffer.from(file.bytes),
    mode: file.mode,
  }));
  const withoutFingerprint = {
    workspaceCanonicalPath: loaded.value.workspaceCanonicalPath,
    pluginDirectoryName: request.pluginDirectoryName,
    expectedRevision: request.expectedRevision,
    nextBytes: Buffer.from(patched.bytes),
    createFiles,
    impact: impactFor(
      loaded.value,
      request.pluginDirectoryName,
      request.mutation,
      scaffolds,
    ),
  };
  const plan: PluginComponentPlan = {
    ...withoutFingerprint,
    fingerprint: planFingerprint(withoutFingerprint),
  };
  return { status: "planned", plan, issues };
}

export function executePluginComponentPlan(
  plan: PluginComponentPlan,
  dependencies: PluginComponentDependencies = {},
): ExecutePluginComponentPlanResult {
  const { fingerprint: _fingerprint, ...withoutFingerprint } = plan;
  if (planFingerprint(withoutFingerprint) !== plan.fingerprint) {
    return {
      status: "failed",
      message: "组件变更计划已失效；没有写入文件。",
      diskChanged: false,
      changedPaths: [],
      cleanupComplete: true,
      transaction: {
        canonical: "unchanged",
        scaffolds: "none",
        cleanupComplete: true,
      },
    };
  }
  const result = commitAuthorizedDocumentAndFiles(
    {
      directory: plan.workspaceCanonicalPath,
      relativePath: pluginDocumentRelativePath(plan.pluginDirectoryName),
      expectedRevision: plan.expectedRevision,
      nextBytes: plan.nextBytes,
      createFiles: plan.createFiles,
    },
    dependencies.commitDependencies,
  );
  if (result.status === "committed" || result.status === "verified") {
    return {
      status: "saved",
      revision: result.revision,
      changedPaths: result.changedPaths,
      diskChanged: result.diskChanged,
      cleanupComplete: true,
      transaction: result.transaction,
    };
  }
  return result;
}
