import {
  accessSync,
  constants,
  type Dirent,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { isIP } from 'node:net';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  buildClaudeHooksConfig,
  buildClaudeManifest,
  buildClaudeMcpConfig,
  buildLspConfig,
} from '../adapters/claude.js';
import { buildCodexManifest } from '../adapters/codex.js';
import {
  buildAgentPluginManifest,
  buildAgentPluginMcpConfig,
} from '../adapters/agent-plugins.js';
import { isStdioMcp } from '../adapters/mcp.js';
import type { PluginYaml } from '../schema/plugin-yaml.js';
import {
  AuthorizedPathError,
  type AuthorizedRoot,
  authorizeExistingDirectory,
  resolveAuthorizedPath,
} from '../infrastructure/authorized-path.js';
import { readMarketplaceMetadata } from './marketplace.js';
import { parsePluginYamlSource } from './plugin-source.js';
import { readSkillDocument } from './skill-document.js';
import type {
  GeneratedFreshness,
  ReferenceValidity,
  ScanWorkspaceHealthRequest,
  ScanWorkspaceHealthResult,
  SourceValidity,
  WorkspaceHealthDiagnostic,
  WorkspaceHealthDimension,
  WorkspaceHealthIssue,
  WorkspaceHealthIssueScope,
  WorkspaceHealthRecommendedAction,
  WorkspaceHealthSnapshot,
  WorkspacePluginHealth,
  WorkspaceValidationDiagnostic,
} from './workspace-health-contract.js';

interface ScanDependencies {
  readonly now?: () => Date;
  readonly readDirectory?: (path: string) => readonly Dirent[];
  readonly beforeGeneratedRead?: (path: string) => void;
}

interface MutablePluginHealth {
  readonly id: string;
  readonly directoryName: string;
  displayName: string;
  canonicalName?: string;
  version?: string;
  componentCount: number;
  componentKinds: Array<'Skill' | 'MCP' | 'Hook' | 'LSP'>;
  platforms: Array<'Agent Plugins' | 'Claude Code' | 'Codex'>;
  source: SourceValidity;
  references: ReferenceValidity;
  generated: GeneratedFreshness;
  readonly issueIds: string[];
  readonly diagnosticRefs: string[];
}

interface IssueCopy {
  readonly dimension: WorkspaceHealthDimension;
  readonly severity: 'blocking' | 'attention';
  readonly scope: WorkspaceHealthIssueScope;
  readonly code: string;
  readonly diagnosticMessage: string;
  readonly title: string;
  readonly summary: string;
  readonly impact: string;
  readonly nextAction: string;
}

class HealthCollector {
  readonly issues: WorkspaceHealthIssue[] = [];
  readonly diagnostics: WorkspaceHealthDiagnostic[] = [];
  readonly validationDiagnostics: WorkspaceValidationDiagnostic[] = [];

  add(
    copy: IssueCopy,
    plugin?: MutablePluginHealth,
    options: { readonly includeInValidation?: boolean } = {},
  ): WorkspaceHealthIssue {
    const diagnosticId = `diagnostic-${String(this.diagnostics.length + 1).padStart(3, '0')}`;
    const issueId = `issue-${String(this.issues.length + 1).padStart(3, '0')}`;
    this.diagnostics.push({
      id: diagnosticId,
      code: copy.code,
      message: copy.diagnosticMessage,
    });
    const issue: WorkspaceHealthIssue = {
      id: issueId,
      dimension: copy.dimension,
      severity: copy.severity,
      scope: copy.scope,
      title: copy.title,
      summary: copy.summary,
      impact: copy.impact,
      nextAction: copy.nextAction,
      diagnosticRef: diagnosticId,
    };
    this.issues.push(issue);
    if (plugin !== undefined) {
      plugin.issueIds.push(issueId);
      plugin.diagnosticRefs.push(diagnosticId);
      if (options.includeInValidation !== false) {
        this.addValidationDiagnostic(
          plugin,
          copy.code,
          copy.diagnosticMessage,
        );
      }
    }
    return issue;
  }

  addValidationDiagnostic(
    plugin: MutablePluginHealth,
    code: string,
    message: string,
  ): void {
    this.validationDiagnostics.push({
      pluginDirectoryName: plugin.directoryName,
      code,
      message,
    });
  }
}

function mapAuthorizationFailure(
  error: AuthorizedPathError,
): Extract<ScanWorkspaceHealthResult, { status: 'unavailable' }> {
  const code =
    error.code === 'NOT_A_DIRECTORY'
      ? 'NOT_A_DIRECTORY'
      : error.code === 'UNSAFE_SYMLINK'
        ? 'UNSAFE_SYMLINK'
        : error.code === 'PATH_UNAVAILABLE'
          ? 'PATH_UNAVAILABLE'
          : 'PATH_NOT_FOUND';
  return {
    status: 'unavailable',
    error: {
      code,
      title:
        code === 'UNSAFE_SYMLINK'
          ? '不能检查这个链接目录'
          : code === 'NOT_A_DIRECTORY'
            ? '请选择一个文件夹'
            : '无法检查这个位置',
      message:
        code === 'UNSAFE_SYMLINK'
          ? '所选位置使用了符号链接，无法确认它仍在授权范围内。'
          : '系统当前无法只读检查所选文件夹。',
      impact: '检查已停止，没有创建、修复、格式化或生成任何文件。',
      nextAction: '请检查文件夹位置与权限后重试，或重新选择其他文件夹。',
      technicalDetail: error.message,
    },
  };
}

function unavailableFromUnexpectedFailure(
  error: unknown,
): Extract<ScanWorkspaceHealthResult, { status: 'unavailable' }> {
  return {
    status: 'unavailable',
    error: {
      code: 'PATH_UNAVAILABLE',
      title: '检查过程中无法继续读取',
      message: '文件夹内容在检查期间发生变化，或系统暂时无法读取必要内容。',
      impact: '检查已停止，没有创建、修复、格式化或生成任何文件。',
      nextAction: '请确认文件夹仍可访问，然后重新检查。',
      technicalDetail:
        error instanceof Error ? error.message : String(error),
    },
  };
}

function diagnostic(
  collector: HealthCollector,
  plugin: MutablePluginHealth,
  copy: Omit<IssueCopy, 'scope'> & {
    readonly scope: Omit<WorkspaceHealthIssueScope, 'pluginId'>;
  },
  options: { readonly includeInValidation?: boolean } = {},
): WorkspaceHealthIssue {
  return collector.add(
    {
      ...copy,
      scope: {
        ...copy.scope,
        pluginId: plugin.id,
      },
    },
    plugin,
    options,
  );
}

function unavailableSourceProblem(
  collector: HealthCollector,
  plugin: MutablePluginHealth,
  code: string,
  rawMessage: string,
  copy: {
    readonly title: string;
    readonly summary: string;
    readonly field?: string;
    readonly relativePath?: string;
  },
): WorkspaceHealthIssue {
  plugin.source = 'invalid';
  if (plugin.references === 'valid') {
    plugin.references = 'unknown';
  }
  plugin.generated = 'unknown';
  return diagnostic(collector, plugin, {
    dimension: 'source',
    severity: 'blocking',
    code,
    diagnosticMessage: rawMessage,
    scope: {
      kind: copy.field
        ? 'field'
        : copy.relativePath
          ? 'path'
          : 'plugin',
      label: plugin.displayName,
      ...(copy.field === undefined ? {} : { field: copy.field }),
      ...(copy.relativePath === undefined
        ? {}
        : { relativePath: copy.relativePath }),
    },
    title: copy.title,
    summary: copy.summary,
    impact: '客户端无法可靠判断这个插件的组件与生成结果。',
    nextAction: '请在外部编辑器中修正源信息，然后重新检查。',
  });
}

function semanticSourceProblem(
  collector: HealthCollector,
  plugin: MutablePluginHealth,
  code: string,
  rawMessage: string,
  copy: {
    readonly title: string;
    readonly summary: string;
    readonly field?: string;
    readonly relativePath?: string;
  },
  options: { readonly includeInValidation?: boolean } = {},
): WorkspaceHealthIssue {
  plugin.source = 'invalid';
  plugin.generated = 'unknown';
  return diagnostic(
    collector,
    plugin,
    {
      dimension: 'source',
      severity: 'blocking',
      code,
      diagnosticMessage: rawMessage,
      scope: {
        kind: copy.field
          ? 'field'
          : copy.relativePath
            ? 'path'
            : 'plugin',
        label: plugin.displayName,
        ...(copy.field === undefined ? {} : { field: copy.field }),
        ...(copy.relativePath === undefined
          ? {}
          : { relativePath: copy.relativePath }),
      },
      title: copy.title,
      summary: copy.summary,
      impact:
        '客户端仍会独立检查本地内容，但不会把平台生成结果判为最新。',
      nextAction: '请在外部编辑器中修正源信息，然后重新检查。',
    },
    options,
  );
}

function referenceProblem(
  collector: HealthCollector,
  plugin: MutablePluginHealth,
  code: string,
  rawMessage: string,
  title: string,
  summary: string,
  relativePath: string,
): void {
  plugin.references = 'invalid';
  diagnostic(collector, plugin, {
    dimension: 'reference',
    severity: 'blocking',
    code,
    diagnosticMessage: rawMessage,
    scope: {
      kind: 'path',
      label: plugin.displayName,
      relativePath,
    },
    title,
    summary,
    impact: '这个插件引用的本地内容当前不能安全使用。',
    nextAction: '请在外部编辑器中修正引用位置或补齐对应内容，然后重新检查。',
  });
}

function generatedProblem(
  collector: HealthCollector,
  plugin: MutablePluginHealth,
  state: 'missing' | 'stale',
  code: string,
  rawMessage: string,
  displayLabel: string,
  relativePath: string,
  includeInHealth = true,
): void {
  if (!includeInHealth) {
    collector.addValidationDiagnostic(plugin, code, rawMessage);
    return;
  }
  if (state === 'stale' || plugin.generated !== 'stale') {
    plugin.generated = state;
  }
  diagnostic(collector, plugin, {
    dimension: 'generated',
    severity: 'attention',
    code,
    diagnosticMessage: rawMessage,
    scope: {
      kind: 'path',
      label: plugin.displayName,
      relativePath,
    },
    title:
      state === 'missing'
        ? `${displayLabel}还没有生成`
        : `${displayLabel}需要更新`,
    summary:
      state === 'missing'
        ? `“${plugin.displayName}”缺少这项平台结果。`
        : `“${plugin.displayName}”的这项平台结果与当前源信息不一致。`,
    impact: '源信息仍然有效，但使用这项生成结果可能得到缺失或过期内容。',
    nextAction: '请先查看问题范围；当前只读检查不会自动生成或改写文件。',
  });
}

function newPlugin(directoryName: string): MutablePluginHealth {
  return {
    id: `plugin:${directoryName}`,
    directoryName,
    displayName: directoryName,
    componentCount: 0,
    componentKinds: [],
    platforms: [],
    source: 'valid',
    references: 'valid',
    generated: 'fresh',
    issueIds: [],
    diagnosticRefs: [],
  };
}

function listComponentKinds(
  config: PluginYaml,
): Array<'Skill' | 'MCP' | 'Hook' | 'LSP'> {
  const kinds: Array<'Skill' | 'MCP' | 'Hook' | 'LSP'> = [];
  if (config.components.skills?.length) kinds.push('Skill');
  if (config.components.mcp?.length) kinds.push('MCP');
  if (config.components.hooks?.length) kinds.push('Hook');
  if (config.components.lsp?.length) kinds.push('LSP');
  return kinds;
}

function componentCount(config: PluginYaml): number {
  return (
    (config.components.skills?.length ?? 0) +
    (config.components.mcp?.length ?? 0) +
    (config.components.hooks?.length ?? 0) +
    (config.components.lsp?.length ?? 0)
  );
}

export function isPluginLocalPathReference(value: string): boolean {
  return (
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('/') ||
    value.startsWith('hooks/') ||
    value.startsWith('mcp/') ||
    value.startsWith('skills/')
  );
}

function resolvePluginReference(
  authorization: AuthorizedRoot,
  plugin: MutablePluginHealth,
  collector: HealthCollector,
  configuredPath: string,
  label: string,
): string | undefined {
  try {
    return resolveAuthorizedPath(authorization, configuredPath);
  } catch (error) {
    if (!(error instanceof AuthorizedPathError)) throw error;
    const rawMessage =
      error.code === 'ABSOLUTE_PATH'
        ? `${label} 不应使用绝对路径: ${configuredPath}`
        : error.code === 'OUTSIDE_AUTHORIZED_ROOT'
          ? `${label} 越过插件目录: ${configuredPath}`
          : error.code === 'UNSAFE_SYMLINK'
            ? `${label} 不允许使用符号链接: ${configuredPath}`
            : `${label} 无法确认授权范围: ${configuredPath}`;
    referenceProblem(
      collector,
      plugin,
      `REFERENCE_${error.code}`,
      rawMessage,
      '组件引用超出安全范围',
      `“${plugin.displayName}”中的本地引用无法在已授权插件范围内确认。`,
      configuredPath,
    );
    return undefined;
  }
}

function validateExecutable(
  path: string,
  displayPath: string,
  plugin: MutablePluginHealth,
  collector: HealthCollector,
): void {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      referenceProblem(
        collector,
        plugin,
        'HOOK_NOT_FILE',
        `Hook 脚本不是文件: ${displayPath}`,
        'Hook 内容不是可运行文件',
        `“${plugin.displayName}”引用的 Hook 位置不是文件。`,
        displayPath,
      );
      return;
    }
    accessSync(path, constants.X_OK);
  } catch {
    referenceProblem(
      collector,
      plugin,
      'HOOK_NOT_EXECUTABLE',
      `Hook 脚本不可执行: ${displayPath}`,
      'Hook 文件当前不能运行',
      `“${plugin.displayName}”引用的 Hook 文件没有可执行权限。`,
      displayPath,
    );
  }
}

const AGENT_SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function validatePortableSkills(
  authorization: AuthorizedRoot,
  config: PluginYaml,
  plugin: MutablePluginHealth,
  collector: HealthCollector,
): void {
  const declaredDirectories = new Set<string>();

  for (const skill of config.components.skills ?? []) {
    const portableMatch = /^skills\/([^/]+)$/.exec(skill.path);
    if (portableMatch === null) {
      referenceProblem(
        collector,
        plugin,
        'SKILL_PATH_NOT_PORTABLE',
        `Agent Plugins Skill 必须是 skills/ 下的直接子目录: ${skill.path}`,
        'Skill 不在可移植发现位置',
        `“${skill.name}”不会被 Agent Plugins 客户端从固定位置发现。`,
        skill.path,
      );
      continue;
    }

    const directoryName = portableMatch[1]!;
    if (declaredDirectories.has(directoryName)) {
      referenceProblem(
        collector,
        plugin,
        'SKILL_DECLARATION_DUPLICATE',
        `Skill 目录被重复声明: ${skill.path}`,
        'Skill 目录被重复声明',
        `“${directoryName}”只能映射到一个可移植 Skill。`,
        skill.path,
      );
    }
    declaredDirectories.add(directoryName);

    if (skill.name !== directoryName) {
      referenceProblem(
        collector,
        plugin,
        'SKILL_NAME_MISMATCH',
        `Skill 声明名称 (${skill.name}) 与父目录 (${directoryName}) 不一致`,
        'Skill 名称与文件夹不一致',
        `“${skill.name}”不能以“${directoryName}”作为 Agent Skills 父目录。`,
        `${skill.path}/SKILL.md`,
      );
    }

    const document = readSkillDocument({
      pluginDirectory: authorization.canonicalPath,
      skillDirectory: skill.path,
    });
    if (document.status === 'unavailable') {
      if (document.problem.code === 'SKILL_UNAVAILABLE') {
        referenceProblem(
          collector,
          plugin,
          'SKILL_DOCUMENT_UNAVAILABLE',
          `SKILL.md 无法作为普通文本文件读取: ${skill.path}/SKILL.md: ${document.problem.message}`,
          'Skill 正文当前无法读取',
          `“${skill.name}”的正文尚未完成 Agent Skills 契约检查。`,
          `${skill.path}/SKILL.md`,
        );
      }
      continue;
    }
    if (document.status === 'uninterpretable') {
      referenceProblem(
        collector,
        plugin,
        document.problem.code === 'INVALID_ENCODING'
          ? 'SKILL_ENCODING_INVALID'
          : 'SKILL_FRONTMATTER_INVALID',
        `SKILL.md 无法解释: ${skill.path}/SKILL.md: ${document.problem.message}`,
        'Skill 正文无法按 Agent Skills 读取',
        `“${skill.name}”的正文编码或 frontmatter 无效。`,
        `${skill.path}/SKILL.md`,
      );
      continue;
    }

    const frontmatter = document.document.draft.frontmatter;
    if (frontmatter.name.length === 0) {
      referenceProblem(
        collector,
        plugin,
        'SKILL_NAME_REQUIRED',
        `SKILL.md frontmatter 缺少 name: ${skill.path}/SKILL.md`,
        'Skill 缺少名称',
        `“${skill.name}”的 frontmatter 必须声明 name。`,
        `${skill.path}/SKILL.md`,
      );
    } else {
      if (!AGENT_SKILL_NAME_PATTERN.test(frontmatter.name)) {
        referenceProblem(
          collector,
          plugin,
          'SKILL_NAME_INVALID',
          `SKILL.md name 不符合 Agent Skills 命名规则: ${frontmatter.name}`,
          'Skill 名称不符合可移植格式',
          `“${frontmatter.name}”必须使用 1–64 位小写字母、数字或单连字符。`,
          `${skill.path}/SKILL.md`,
        );
      }
      if (frontmatter.name !== directoryName) {
        referenceProblem(
          collector,
          plugin,
          'SKILL_NAME_MISMATCH',
          `SKILL.md name (${frontmatter.name}) 与父目录 (${directoryName}) 不一致`,
          'Skill 名称与文件夹不一致',
          `“${frontmatter.name}”必须与父目录“${directoryName}”完全相同。`,
          `${skill.path}/SKILL.md`,
        );
      }
    }
    if (frontmatter.description.trim().length === 0) {
      referenceProblem(
        collector,
        plugin,
        'SKILL_DESCRIPTION_REQUIRED',
        `SKILL.md frontmatter 缺少 description: ${skill.path}/SKILL.md`,
        'Skill 缺少说明',
        `“${skill.name}”的 frontmatter 必须声明非空 description。`,
        `${skill.path}/SKILL.md`,
      );
    } else if (Array.from(frontmatter.description).length > 1024) {
      referenceProblem(
        collector,
        plugin,
        'SKILL_DESCRIPTION_TOO_LONG',
        `SKILL.md description 超过 1024 字符: ${skill.path}/SKILL.md`,
        'Skill 说明过长',
        `“${skill.name}”的 description 超出 Agent Skills 上限。`,
        `${skill.path}/SKILL.md`,
      );
    }
  }

  let skillsDirectory: string;
  try {
    skillsDirectory = resolveAuthorizedPath(authorization, 'skills');
  } catch (error) {
    referenceProblem(
      collector,
      plugin,
      'SKILL_DISCOVERY_UNSAFE',
      error instanceof Error ? error.message : String(error),
      'Skill 发现目录不安全',
      `“${plugin.displayName}”的 skills/ 无法在授权范围内扫描。`,
      'skills',
    );
    return;
  }
  if (!existsSync(skillsDirectory)) return;
  if (!lstatSync(skillsDirectory).isDirectory()) {
    referenceProblem(
      collector,
      plugin,
      'SKILLS_NOT_DIRECTORY',
      'Agent Plugins skills 位置不是目录: skills',
      'Skill 发现位置不是文件夹',
      `“${plugin.displayName}”无法从固定 skills/ 位置发现组件。`,
      'skills',
    );
    return;
  }

  for (const entry of readdirSync(skillsDirectory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      referenceProblem(
        collector,
        plugin,
        'SKILL_DISCOVERY_SYMLINK',
        `Agent Plugins Skill 目录不允许使用符号链接: skills/${entry.name}`,
        'Skill 发现位置使用了链接',
        `“${entry.name}”无法确认仍在插件包内。`,
        `skills/${entry.name}`,
      );
      continue;
    }
    if (!entry.isDirectory()) continue;
    const documentPath = join(skillsDirectory, entry.name, 'SKILL.md');
    if (!existsSync(documentPath)) continue;
    if (!declaredDirectories.has(entry.name)) {
      referenceProblem(
        collector,
        plugin,
        'SKILL_UNDECLARED',
        `发现未在 plugin.yaml 声明的 Agent Plugins Skill: skills/${entry.name}/SKILL.md`,
        '发现未声明的 Skill',
        `“${entry.name}”会被协议发现，但不在 canonical 组件声明中。`,
        `skills/${entry.name}/SKILL.md`,
      );
    }
  }
}

function pathSegmentsRemainContained(path: string): boolean {
  if (path.includes('\\')) return false;
  let depth = 0;
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (depth === 0) return false;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return true;
}

function validPortableCommand(command: string): boolean {
  if (command.startsWith('./')) {
    return !command.includes('${') && pathSegmentsRemainContained(command.slice(2));
  }
  return (
    command.length > 0 &&
    command !== '.' &&
    command !== '..' &&
    !/[\s/\\]/u.test(command) &&
    !command.includes('${')
  );
}

function validPortableCwd(cwd: string): boolean {
  if (cwd.startsWith('./')) return pathSegmentsRemainContained(cwd.slice(2));
  for (const prefix of ['${PLUGIN_ROOT}', '${PLUGIN_DATA}'] as const) {
    if (cwd === prefix) return true;
    if (cwd.startsWith(`${prefix}/`)) {
      return pathSegmentsRemainContained(cwd.slice(prefix.length + 1));
    }
  }
  return false;
}

function pluginRootCwdReference(cwd: string): string | undefined {
  if (cwd.startsWith('./')) return cwd;
  if (cwd === '${PLUGIN_ROOT}') return '.';
  if (cwd.startsWith('${PLUGIN_ROOT}/')) {
    return `./${cwd.slice('${PLUGIN_ROOT}/'.length)}`;
  }
  return undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (unwrapped === 'localhost') return true;
  const family = isIP(unwrapped);
  if (family === 4) return unwrapped.startsWith('127.');
  return family === 6 && (unwrapped === '::1' || unwrapped === '0:0:0:0:0:0:0:1');
}

function validatePortableMcp(
  authorization: AuthorizedRoot,
  config: PluginYaml,
  plugin: MutablePluginHealth,
  collector: HealthCollector,
): void {
  const names = new Set<string>();
  for (const mcp of config.components.mcp ?? []) {
    if (names.has(mcp.name)) {
      semanticSourceProblem(
        collector,
        plugin,
        'MCP_DUPLICATE_NAME',
        `MCP server name 重复: ${mcp.name}`,
        {
          title: 'MCP server 名称重复',
          summary: `“${plugin.displayName}”中有多个 server 使用“${mcp.name}”。`,
          field: 'components.mcp.name',
        },
      );
    }
    names.add(mcp.name);

    if (isStdioMcp(mcp)) {
      if (!validPortableCommand(mcp.command)) {
        semanticSourceProblem(
          collector,
          plugin,
          'MCP_COMMAND_INVALID',
          `MCP command 必须是单个 bare executable 或 ./ 相对路径: ${mcp.command}`,
          {
            title: 'MCP 启动命令不可移植',
            summary: `“${mcp.name}”的 command 不是 Agent Plugins 允许的单个 token。`,
            field: 'components.mcp.command',
          },
        );
      }
      if (typeof mcp.cwd === 'string') {
        if (!validPortableCwd(mcp.cwd)) {
          semanticSourceProblem(
            collector,
            plugin,
            'MCP_CWD_UNSAFE',
            `MCP cwd 形式无效或越出协议根目录: ${mcp.cwd}`,
            {
              title: 'MCP 工作目录不安全',
              summary: `“${mcp.name}”的 cwd 不能安全解析到 PLUGIN_ROOT 或 PLUGIN_DATA。`,
              field: 'components.mcp.cwd',
            },
          );
        } else {
          const configuredPath = pluginRootCwdReference(mcp.cwd);
          if (configuredPath !== undefined) {
            const cwd = resolvePluginReference(
              authorization,
              plugin,
              collector,
              configuredPath,
              'MCP cwd',
            );
            if (cwd !== undefined && !existsSync(cwd)) {
              referenceProblem(
                collector,
                plugin,
                'MCP_CWD_MISSING',
                `MCP cwd 不存在: ${mcp.cwd}`,
                '找不到 MCP 工作目录',
                `“${mcp.name}”的插件内工作目录不存在。`,
                mcp.cwd,
              );
            } else if (cwd !== undefined && !lstatSync(cwd).isDirectory()) {
              referenceProblem(
                collector,
                plugin,
                'MCP_CWD_NOT_DIRECTORY',
                `MCP cwd 不是目录: ${mcp.cwd}`,
                'MCP 工作目录不是文件夹',
                `“${mcp.name}”的 cwd 不能作为进程工作目录。`,
                mcp.cwd,
              );
            }
          }
        }
      }
      for (const key of Object.keys(mcp.env ?? {})) {
        if (key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA') {
          semanticSourceProblem(
            collector,
            plugin,
            'MCP_ENV_RESERVED',
            `MCP env 不得覆盖客户端保留变量: ${key}`,
            {
              title: 'MCP 环境变量占用了保留名称',
              summary: `“${mcp.name}”必须由客户端提供 ${key}。`,
              field: 'components.mcp.env',
            },
          );
        }
      }
      continue;
    }

    let url: URL;
    try {
      url = new URL(mcp.url);
    } catch {
      semanticSourceProblem(
        collector,
        plugin,
        'MCP_REMOTE_URL_INVALID',
        `远端 MCP URL 不是绝对 URL: ${mcp.url}`,
        {
          title: '远端 MCP URL 无效',
          summary: `“${mcp.name}”必须使用绝对 HTTP 或 HTTPS URL。`,
          field: 'components.mcp.url',
        },
      );
      continue;
    }
    const httpProtocol = url.protocol === 'http:' || url.protocol === 'https:';
    if (
      !httpProtocol ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    ) {
      semanticSourceProblem(
        collector,
        plugin,
        'MCP_REMOTE_URL_INVALID',
        `远端 MCP URL 必须是无 userinfo/fragment 的绝对 HTTP(S) URL: ${mcp.url}`,
        {
          title: '远端 MCP URL 无效',
          summary: `“${mcp.name}”的 URL 包含协议不允许的部分。`,
          field: 'components.mcp.url',
        },
      );
    } else if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
      semanticSourceProblem(
        collector,
        plugin,
        'MCP_REMOTE_URL_INSECURE',
        `非 loopback 远端 MCP URL 必须使用 HTTPS: ${mcp.url}`,
        {
          title: '远端 MCP 连接不安全',
          summary: `“${mcp.name}”只能对 localhost 或 loopback IP 使用 HTTP。`,
          field: 'components.mcp.url',
        },
      );
    }

    const headerNames = new Set<string>();
    for (const [name, value] of Object.entries(mcp.headers ?? {})) {
      const normalized = name.toLowerCase();
      if (headerNames.has(normalized)) {
        semanticSourceProblem(
          collector,
          plugin,
          'MCP_HEADER_DUPLICATE',
          `HTTP header 名称按大小写折叠后重复: ${name}`,
          {
            title: '远端 MCP header 重复',
            summary: `“${mcp.name}”包含大小写不同但语义相同的 header。`,
            field: 'components.mcp.headers',
          },
        );
      }
      headerNames.add(normalized);
      try {
        validateHeaderName(name);
        validateHeaderValue(name, value);
      } catch {
        semanticSourceProblem(
          collector,
          plugin,
          'MCP_HEADER_INVALID',
          `HTTP header 字段无效: ${name}`,
          {
            title: '远端 MCP header 无效',
            summary: `“${mcp.name}”包含不能作为 HTTP header 发送的名称或值。`,
            field: 'components.mcp.headers',
          },
        );
      }
    }
  }
}

function validateLocalReferences(
  authorization: AuthorizedRoot,
  config: PluginYaml,
  plugin: MutablePluginHealth,
  collector: HealthCollector,
): void {
  validatePortableSkills(authorization, config, plugin, collector);
  for (const skill of config.components.skills ?? []) {
    const skillDirectory = resolvePluginReference(
      authorization,
      plugin,
      collector,
      skill.path,
      'Skill 路径',
    );
    if (skillDirectory === undefined) continue;
    if (!existsSync(skillDirectory)) {
      referenceProblem(
        collector,
        plugin,
        'SKILL_DIRECTORY_MISSING',
        `Skill 目录不存在: ${skill.path}`,
        '找不到 Skill 内容',
        `“${skill.name}”引用的内容文件夹不存在。`,
        skill.path,
      );
      continue;
    }
    if (!statSync(skillDirectory).isDirectory()) {
      referenceProblem(
        collector,
        plugin,
        'SKILL_PATH_NOT_DIRECTORY',
        `Skill 路径不是目录: ${skill.path}`,
        'Skill 位置不是文件夹',
        `“${skill.name}”引用的位置不能作为 Skill 内容文件夹。`,
        skill.path,
      );
      continue;
    }
    const skillMarkdown = resolvePluginReference(
      authorization,
      plugin,
      collector,
      `${skill.path}/SKILL.md`,
      'Skill 内容路径',
    );
    if (skillMarkdown !== undefined) {
      if (!existsSync(skillMarkdown)) {
        referenceProblem(
          collector,
          plugin,
          'SKILL_DOCUMENT_MISSING',
          `SKILL.md 不存在: ${skill.path}/SKILL.md`,
          '找不到 Skill 正文',
          `“${skill.name}”的内容文件夹中没有正文。`,
          `${skill.path}/SKILL.md`,
        );
      } else if (!lstatSync(skillMarkdown).isFile()) {
        referenceProblem(
          collector,
          plugin,
          'SKILL_DOCUMENT_NOT_FILE',
          `SKILL.md 不是普通文件: ${skill.path}/SKILL.md`,
          'Skill 正文不是普通文件',
          `“${skill.name}”的 SKILL.md 不能作为 Agent Skills 正文读取。`,
          `${skill.path}/SKILL.md`,
        );
      }
    }
  }

  validatePortableMcp(authorization, config, plugin, collector);

  for (const hook of config.components.hooks ?? []) {
    const script = resolvePluginReference(
      authorization,
      plugin,
      collector,
      hook.command,
      'Hook 脚本路径',
    );
    if (script === undefined) continue;
    if (!existsSync(script)) {
      referenceProblem(
        collector,
        plugin,
        'HOOK_MISSING',
        `Hook 脚本不存在: ${hook.command}`,
        '找不到 Hook 文件',
        `“${plugin.displayName}”引用的 Hook 文件不存在。`,
        hook.command,
      );
      continue;
    }
    validateExecutable(script, hook.command, plugin, collector);
  }

  for (const mcp of config.components.mcp ?? []) {
    if (!isStdioMcp(mcp)) continue;
    if (isPluginLocalPathReference(mcp.command)) {
      const command = resolvePluginReference(
        authorization,
        plugin,
        collector,
        mcp.command,
        'MCP command 路径',
      );
      if (command !== undefined && !existsSync(command)) {
        referenceProblem(
          collector,
          plugin,
          'MCP_COMMAND_MISSING',
          `MCP command 文件不存在: ${mcp.command}`,
          '找不到 MCP 启动文件',
          `“${mcp.name}”引用的本地启动文件不存在。`,
          mcp.command,
        );
      } else if (command !== undefined && !lstatSync(command).isFile()) {
        referenceProblem(
          collector,
          plugin,
          'MCP_COMMAND_NOT_FILE',
          `MCP command 不是普通文件: ${mcp.command}`,
          'MCP 启动目标不是文件',
          `“${mcp.name}”的插件内 command 不能作为可执行文件启动。`,
          mcp.command,
        );
      }
    }
    for (const argument of mcp.args ?? []) {
      if (!isPluginLocalPathReference(argument)) continue;
      const path = resolvePluginReference(
        authorization,
        plugin,
        collector,
        argument,
        'MCP args 路径',
      );
      if (path !== undefined && !existsSync(path)) {
        referenceProblem(
          collector,
          plugin,
          'MCP_ARGUMENT_MISSING',
          `MCP args 引用的文件不存在: ${argument}`,
          '找不到 MCP 使用的本地文件',
          `“${mcp.name}”的一项启动输入不存在。`,
          argument,
        );
      }
    }
  }

  const seenLspNames = new Set<string>();
  for (const lsp of config.components.lsp ?? []) {
    if (seenLspNames.has(lsp.name)) {
      semanticSourceProblem(
        collector,
        plugin,
        'LSP_DUPLICATE_NAME',
        `LSP server name 重复: ${lsp.name}`,
        {
          title: '语言服务名称重复',
          summary: `“${plugin.displayName}”中有多个语言服务使用“${lsp.name}”。`,
          field: 'components.lsp.name',
        },
      );
    }
    seenLspNames.add(lsp.name);
    if (
      lsp.transport != null &&
      lsp.transport !== 'stdio' &&
      lsp.transport !== 'socket'
    ) {
      semanticSourceProblem(
        collector,
        plugin,
        'LSP_TRANSPORT_INVALID',
        `LSP transport 仅支持 stdio 或 socket: ${lsp.name}`,
        {
          title: '语言服务连接方式不可用',
          summary: `“${lsp.name}”使用了当前不支持的连接方式。`,
          field: 'components.lsp.transport',
        },
      );
    }
    if (lsp.startupTimeout != null && lsp.startupTimeout < 0) {
      semanticSourceProblem(
        collector,
        plugin,
        'LSP_TIMEOUT_INVALID',
        `LSP startupTimeout 不能为负数: ${lsp.name}`,
        {
          title: '语言服务启动时间无效',
          summary: `“${lsp.name}”的启动等待时间不能小于零。`,
          field: 'components.lsp.startupTimeout',
        },
      );
    }
    if (lsp.maxRestarts != null && lsp.maxRestarts < 0) {
      semanticSourceProblem(
        collector,
        plugin,
        'LSP_RESTARTS_INVALID',
        `LSP maxRestarts 不能为负数: ${lsp.name}`,
        {
          title: '语言服务重试次数无效',
          summary: `“${lsp.name}”的重试次数不能小于零。`,
          field: 'components.lsp.maxRestarts',
        },
      );
    }
    for (const [extension, languageId] of Object.entries(
      lsp.extensionToLanguage,
    )) {
      if (!extension.startsWith('.')) {
        semanticSourceProblem(
          collector,
          plugin,
          'LSP_EXTENSION_INVALID',
          `LSP extensionToLanguage 扩展名必须以 \\. 开头: ${extension}`,
          {
            title: '文件扩展名格式无效',
            summary: `“${lsp.name}”中的“${extension}”不是可识别的文件扩展名。`,
            field: 'components.lsp.extensionToLanguage',
          },
        );
      }
      if (languageId.trim().length === 0) {
        semanticSourceProblem(
          collector,
          plugin,
          'LSP_LANGUAGE_ID_EMPTY',
          `LSP extensionToLanguage language id 不能为空: ${extension}`,
          {
            title: '语言标识不能为空',
            summary: `“${lsp.name}”中的“${extension}”还没有语言标识。`,
            field: 'components.lsp.extensionToLanguage',
          },
        );
      }
    }
    if (isPluginLocalPathReference(lsp.command)) {
      const command = resolvePluginReference(
        authorization,
        plugin,
        collector,
        lsp.command,
        'LSP command 路径',
      );
      if (command !== undefined && !existsSync(command)) {
        referenceProblem(
          collector,
          plugin,
          'LSP_COMMAND_MISSING',
          `LSP command 文件不存在: ${lsp.command}`,
          '找不到语言服务启动文件',
          `“${lsp.name}”引用的本地启动文件不存在。`,
          lsp.command,
        );
      }
    }
    for (const argument of lsp.args ?? []) {
      if (!isPluginLocalPathReference(argument)) continue;
      const path = resolvePluginReference(
        authorization,
        plugin,
        collector,
        argument,
        'LSP args 路径',
      );
      if (path !== undefined && !existsSync(path)) {
        referenceProblem(
          collector,
          plugin,
          'LSP_ARGUMENT_MISSING',
          `LSP args 引用的文件不存在: ${argument}`,
          '找不到语言服务使用的本地文件',
          `“${lsp.name}”的一项启动输入不存在。`,
          argument,
        );
      }
    }
  }
}

function readGeneratedJson(
  path: string,
  beforeGeneratedRead?: (path: string) => void,
): unknown {
  beforeGeneratedRead?.(path);
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function validateGeneratedFile(
  authorization: AuthorizedRoot,
  plugin: MutablePluginHealth,
  collector: HealthCollector,
  relativePath: string,
  expected: unknown | null,
  displayLabel: string,
  diagnosticLabel: string,
  includeInHealth: boolean,
  beforeGeneratedRead?: (path: string) => void,
): void {
  let path: string;
  try {
    path = resolveAuthorizedPath(authorization, relativePath);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    generatedProblem(
      collector,
      plugin,
      'stale',
      'GENERATED_UNSAFE_PATH',
      `${diagnosticLabel} 无法确认授权范围: ${relativePath}: ${message}`,
      displayLabel,
      relativePath,
      includeInHealth,
    );
    return;
  }
  if (!existsSync(path)) {
    if (expected !== null) {
      generatedProblem(
        collector,
        plugin,
        'missing',
        'GENERATED_MISSING',
        `${diagnosticLabel} 缺失，请重新运行 build: ${path}`,
        displayLabel,
        relativePath,
        includeInHealth,
      );
    }
    return;
  }
  if (expected === null) {
    generatedProblem(
      collector,
      plugin,
      'stale',
      'GENERATED_OBSOLETE',
      `${diagnosticLabel} 已过期，请删除或重新运行 build: ${path}`,
      displayLabel,
      relativePath,
      includeInHealth,
    );
    return;
  }
  let actual: unknown;
  try {
    actual = readGeneratedJson(path, beforeGeneratedRead);
  } catch (error) {
    generatedProblem(
      collector,
      plugin,
      'stale',
      'GENERATED_INVALID_JSON',
      `生成文件不是有效 JSON: ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      displayLabel,
      relativePath,
      includeInHealth,
    );
    return;
  }
  if (!isDeepStrictEqual(actual, expected)) {
    generatedProblem(
      collector,
      plugin,
      'stale',
      'GENERATED_STALE',
      `${diagnosticLabel} 与 plugin.yaml 派生结果不一致，请重新运行 build: ${path}`,
      displayLabel,
      relativePath,
      includeInHealth,
    );
  }
}

function validateGeneratedFiles(
  authorization: AuthorizedRoot,
  config: PluginYaml,
  plugin: MutablePluginHealth,
  collector: HealthCollector,
  includeInHealth: boolean,
  beforeGeneratedRead?: (path: string) => void,
): void {
  validateGeneratedFile(
    authorization,
    plugin,
    collector,
    'plugin.json',
    buildAgentPluginManifest(config),
    'Agent Plugins manifest',
    'Agent Plugins manifest',
    includeInHealth,
    beforeGeneratedRead,
  );
  validateGeneratedFile(
    authorization,
    plugin,
    collector,
    'mcp.json',
    buildAgentPluginMcpConfig(config),
    'Agent Plugins MCP 配置',
    'Agent Plugins MCP 配置',
    includeInHealth,
    beforeGeneratedRead,
  );
  validateGeneratedFile(
    authorization,
    plugin,
    collector,
    '.claude-plugin/plugin.json',
    buildClaudeManifest(config),
    'Claude Code 平台结果',
    'Claude manifest',
    includeInHealth,
    beforeGeneratedRead,
  );
  validateGeneratedFile(
    authorization,
    plugin,
    collector,
    '.codex-plugin/plugin.json',
    buildCodexManifest(config),
    'Codex 平台结果',
    'Codex manifest',
    includeInHealth,
    beforeGeneratedRead,
  );
  validateGeneratedFile(
    authorization,
    plugin,
    collector,
    '.mcp.json',
    buildClaudeMcpConfig(config),
    'MCP 配置',
    'MCP 配置',
    includeInHealth,
    beforeGeneratedRead,
  );
  validateGeneratedFile(
    authorization,
    plugin,
    collector,
    'hooks/hooks.json',
    buildClaudeHooksConfig(config),
    'Hooks 配置',
    'Hooks 配置',
    includeInHealth,
    beforeGeneratedRead,
  );
  validateGeneratedFile(
    authorization,
    plugin,
    collector,
    '.lsp.json',
    buildLspConfig(config),
    'LSP 配置',
    'LSP 配置',
    includeInHealth,
    beforeGeneratedRead,
  );
}

function scanPlugin(
  workspaceAuthorization: AuthorizedRoot,
  directoryName: string,
  collector: HealthCollector,
  options: {
    readonly inspectGenerated: boolean;
    readonly beforeGeneratedRead?: (path: string) => void;
  },
): MutablePluginHealth {
  const plugin = newPlugin(directoryName);
  if (
    directoryName.length === 0 ||
    directoryName === '.' ||
    directoryName === '..' ||
    directoryName.includes('/') ||
    directoryName.includes('\\')
  ) {
    unavailableSourceProblem(
      collector,
      plugin,
      'PLUGIN_NAME_UNSAFE',
      `插件目录不存在: plugins/${directoryName}`,
      {
        title: '插件名称不能作为安全文件夹定位',
        summary: '所请求的插件名称不是 Marketplace 内的单个文件夹名称。',
        relativePath: `plugins/${directoryName}`,
      },
    );
    return plugin;
  }
  let pluginDirectory: string;
  try {
    pluginDirectory = resolveAuthorizedPath(
      workspaceAuthorization,
      `plugins/${directoryName}`,
    );
  } catch (error) {
    unavailableSourceProblem(
      collector,
      plugin,
      'PLUGIN_UNSAFE_PATH',
      `插件目录无法确认授权范围: plugins/${directoryName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        title: '插件位置不安全',
        summary: `“${directoryName}”不能在当前授权范围内安全读取。`,
        relativePath: `plugins/${directoryName}`,
      },
    );
    return plugin;
  }
  if (!existsSync(pluginDirectory)) {
    unavailableSourceProblem(
      collector,
      plugin,
      'PLUGIN_DIRECTORY_MISSING',
      `插件目录不存在: plugins/${directoryName}`,
      {
        title: '找不到插件文件夹',
        summary: `“${directoryName}”的文件夹已经移动或不存在。`,
        relativePath: `plugins/${directoryName}`,
      },
    );
    return plugin;
  }
  if (!lstatSync(pluginDirectory).isDirectory()) {
    unavailableSourceProblem(
      collector,
      plugin,
      'PLUGIN_NOT_DIRECTORY',
      `插件目录不存在: plugins/${directoryName}`,
      {
        title: '插件位置不是文件夹',
        summary: `“${directoryName}”的位置不能作为插件文件夹。`,
        relativePath: `plugins/${directoryName}`,
      },
    );
    return plugin;
  }

  let pluginAuthorization: AuthorizedRoot;
  try {
    pluginAuthorization = authorizeExistingDirectory(pluginDirectory);
  } catch (error) {
    unavailableSourceProblem(
      collector,
      plugin,
      'PLUGIN_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
      {
        title: '插件暂时无法读取',
        summary: `系统当前无法安全读取“${directoryName}”。`,
        relativePath: `plugins/${directoryName}`,
      },
    );
    return plugin;
  }

  let yamlPath: string;
  try {
    yamlPath = resolveAuthorizedPath(pluginAuthorization, 'plugin.yaml');
  } catch (error) {
    unavailableSourceProblem(
      collector,
      plugin,
      'PLUGIN_SOURCE_UNSAFE',
      error instanceof Error ? error.message : String(error),
      {
        title: '插件源信息使用了不安全的链接',
        summary: `“${directoryName}”的基础信息无法在授权范围内读取。`,
        relativePath: 'plugin.yaml',
      },
    );
    return plugin;
  }
  if (!existsSync(yamlPath)) {
    unavailableSourceProblem(
      collector,
      plugin,
      'PLUGIN_SOURCE_MISSING',
      `plugin.yaml not found: ${yamlPath}`,
      {
        title: '找不到插件基础信息',
        summary: `“${directoryName}”中没有插件声明。`,
        relativePath: 'plugin.yaml',
      },
    );
    return plugin;
  }

  let raw: string;
  try {
    raw = readFileSync(yamlPath, 'utf-8');
  } catch (error) {
    unavailableSourceProblem(
      collector,
      plugin,
      'PLUGIN_SOURCE_UNREADABLE',
      error instanceof Error ? error.message : String(error),
      {
        title: '插件基础信息暂时无法读取',
        summary: `系统无法读取“${directoryName}”的插件声明。`,
        relativePath: 'plugin.yaml',
      },
    );
    return plugin;
  }
  const parsed = parsePluginYamlSource(raw);
  if (parsed.status === 'invalid-yaml') {
    unavailableSourceProblem(
      collector,
      plugin,
      'PLUGIN_YAML_INVALID',
      parsed.message,
      {
        title: '插件基础信息无法解析',
        summary: `“${directoryName}”的插件声明不是可识别的 YAML。`,
        relativePath: 'plugin.yaml',
      },
    );
    return plugin;
  }
  if (parsed.status === 'invalid-schema') {
    const diagnosticRef = collector.add(
      {
        dimension: 'source',
        severity: 'blocking',
        scope: {
          kind: 'plugin',
          label: plugin.displayName,
          pluginId: plugin.id,
        },
        code: 'PLUGIN_SCHEMA_INVALID',
        diagnosticMessage: parsed.message,
        title: '插件基础信息需要修正',
        summary: `“${directoryName}”有 ${parsed.issues.length} 项基础信息不符合当前格式。`,
        impact: '客户端无法可靠判断这个插件的组件与生成结果。',
        nextAction: '请在外部编辑器中修正标出的字段，然后重新检查。',
      },
      plugin,
    ).diagnosticRef;
    plugin.source = 'invalid';
    plugin.references = 'unknown';
    plugin.generated = 'unknown';
    for (const schemaIssue of parsed.issues) {
      const issueId = `issue-${String(collector.issues.length + 1).padStart(3, '0')}`;
      collector.issues.push({
        id: issueId,
        dimension: 'source',
        severity: 'blocking',
        scope: {
          kind: 'field',
          label: plugin.displayName,
          pluginId: plugin.id,
          field: schemaIssue.instancePath,
          relativePath: 'plugin.yaml',
        },
        title: '字段内容不符合当前格式',
        summary: `${schemaIssue.instancePath}：${schemaIssue.message}`,
        impact: '这个字段会阻止客户端可靠理解该插件。',
        nextAction: '请在外部编辑器中修正该字段，然后重新检查。',
        diagnosticRef,
      });
      plugin.issueIds.push(issueId);
    }
    return plugin;
  }

  const config = parsed.value;
  plugin.canonicalName = config.name;
  plugin.displayName =
    config.platform?.codex?.interface?.displayName ?? config.name;
  plugin.version = config.version;
  plugin.componentKinds = listComponentKinds(config);
  plugin.componentCount = componentCount(config);
  plugin.platforms = ['Agent Plugins', 'Claude Code', 'Codex'];
  let deferredNameMismatch:
    | { readonly code: string; readonly message: string }
    | undefined;
  if (config.name !== directoryName) {
    const message = `plugin.yaml 中的 name (${config.name}) 与目录名 (${directoryName}) 不一致`;
    semanticSourceProblem(
      collector,
      plugin,
      'PLUGIN_NAME_MISMATCH',
      message,
      {
        title: '插件名称与文件夹不一致',
        summary: `“${plugin.displayName}”的内部名称与所在文件夹不同。`,
        field: 'name',
      },
      { includeInValidation: false },
    );
    deferredNameMismatch = {
      code: 'PLUGIN_NAME_MISMATCH',
      message,
    };
  }

  validateLocalReferences(
    pluginAuthorization,
    config,
    plugin,
    collector,
  );
  if (options.inspectGenerated) {
    validateGeneratedFiles(
      pluginAuthorization,
      config,
      plugin,
      collector,
      plugin.source === 'valid',
      options.beforeGeneratedRead,
    );
  } else {
    plugin.generated = 'not-applicable';
  }
  if (deferredNameMismatch !== undefined) {
    collector.addValidationDiagnostic(
      plugin,
      deferredNameMismatch.code,
      deferredNameMismatch.message,
    );
  }
  return plugin;
}

function pluginNamesForRequest(
  authorization: AuthorizedRoot,
  requestedNames: readonly string[] | undefined,
  collector: HealthCollector,
  readDirectory: (path: string) => readonly Dirent[],
): string[] {
  if (requestedNames !== undefined) return [...requestedNames];
  let pluginsDirectory: string;
  try {
    pluginsDirectory = resolveAuthorizedPath(authorization, 'plugins');
  } catch (error) {
    collector.add({
      dimension: 'source',
      severity: 'blocking',
      scope: {
        kind: 'path',
        label: '插件目录',
        relativePath: 'plugins',
      },
      code: 'PLUGINS_DIRECTORY_UNSAFE',
      diagnosticMessage:
        error instanceof Error ? error.message : String(error),
      title: '插件目录不安全',
      summary: '插件目录无法在当前授权范围内读取。',
      impact: '客户端无法列出或检查这个 Marketplace 中的插件。',
      nextAction: '请移除链接或修正插件目录后重新检查。',
    });
    return [];
  }
  if (!existsSync(pluginsDirectory)) return [];
  if (!lstatSync(pluginsDirectory).isDirectory()) {
    collector.add({
      dimension: 'source',
      severity: 'blocking',
      scope: {
        kind: 'path',
        label: '插件目录',
        relativePath: 'plugins',
      },
      code: 'PLUGINS_NOT_DIRECTORY',
      diagnosticMessage: 'plugins 不是目录',
      title: '插件位置不是文件夹',
      summary: 'Marketplace 的插件位置不能作为文件夹读取。',
      impact: '客户端无法列出或检查插件。',
      nextAction: '请在外部修正 plugins 位置后重新检查。',
    });
    return [];
  }

  const names: string[] = [];
  for (const entry of readDirectory(pluginsDirectory)) {
    if (entry.isSymbolicLink()) {
      collector.add({
        dimension: 'reference',
        severity: 'blocking',
        scope: {
          kind: 'path',
          label: entry.name,
          relativePath: `plugins/${entry.name}`,
        },
        code: 'PLUGIN_DIRECTORY_SYMLINK',
        diagnosticMessage: `插件目录不允许使用符号链接: plugins/${entry.name}`,
        title: '插件文件夹使用了不安全的链接',
        summary: `“${entry.name}”无法确认仍在授权的 Marketplace 内。`,
        impact: '客户端不会跟随这个链接读取插件内容。',
        nextAction: '请把插件内容放回 Marketplace 内的真实文件夹后重新检查。',
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    names.push(entry.name);
  }
  return names.sort();
}

function aggregateGenerated(
  plugins: readonly MutablePluginHealth[],
): GeneratedFreshness {
  if (plugins.length === 0) return 'not-applicable';
  if (plugins.some((plugin) => plugin.generated === 'stale')) return 'stale';
  if (plugins.some((plugin) => plugin.generated === 'missing')) return 'missing';
  if (plugins.some((plugin) => plugin.generated === 'unknown')) return 'unknown';
  return 'fresh';
}

function aggregateReferences(
  plugins: readonly MutablePluginHealth[],
  issues: readonly WorkspaceHealthIssue[],
): ReferenceValidity {
  if (issues.some((issue) => issue.dimension === 'reference')) return 'invalid';
  if (plugins.some((plugin) => plugin.references === 'unknown')) return 'unknown';
  return 'valid';
}

function recommend(
  issues: readonly WorkspaceHealthIssue[],
  pluginCount: number,
): WorkspaceHealthRecommendedAction {
  const source = issues.find((issue) => issue.dimension === 'source');
  if (source !== undefined) {
    return {
      kind: 'review-source',
      label: '查看首要源信息问题',
      description: '先理解阻止客户端读取插件的第一项问题。',
      issueId: source.id,
    };
  }
  const reference = issues.find((issue) => issue.dimension === 'reference');
  if (reference !== undefined) {
    return {
      kind: 'review-reference',
      label: '查看首要本地内容问题',
      description: '先确认缺失或越界的本地内容，再继续维护。',
      issueId: reference.id,
    };
  }
  const generated = issues.find((issue) => issue.dimension === 'generated');
  if (generated !== undefined) {
    return {
      kind: 'review-generated',
      label: '查看需要更新的生成结果',
      description: '源内容仍然有效；先核对受影响的平台结果。',
      issueId: generated.id,
    };
  }
  if (pluginCount === 0) {
    return {
      kind: 'prepare-first-plugin',
      label: '了解第一个插件的维护入口',
      description:
        '当前 Marketplace 可以使用；本次只读检查只说明后续入口，不会提前创建内容。',
    };
  }
  return {
    kind: 'review-evidence',
    label: '查看本次检查依据',
    description: '确认源信息、本地内容和插件生成结果的只读检查范围。',
  };
}

function scanWorkspaceHealthUnsafe(
  request: ScanWorkspaceHealthRequest,
  dependencies: ScanDependencies = {},
): ScanWorkspaceHealthResult {
  const authorization = authorizeExistingDirectory(request.directory);

  const collector = new HealthCollector();
  let marketplaceValidity: SourceValidity = 'valid';
  let marketplace: {
    name: string;
    description?: string;
    organization?: string;
  };
  try {
    marketplace = readMarketplaceMetadata(authorization.canonicalPath);
  } catch (error) {
    marketplaceValidity = 'invalid';
    marketplace = { name: basename(authorization.canonicalPath) };
    collector.add({
      dimension: 'source',
      severity: 'blocking',
      scope: {
        kind: 'path',
        label: 'Marketplace 信息',
        relativePath: 'marketplace.yaml',
      },
      code: existsSync(join(authorization.canonicalPath, 'marketplace.yaml'))
        ? 'MARKETPLACE_INVALID'
        : 'MARKETPLACE_MISSING',
      diagnosticMessage:
        error instanceof Error ? error.message : String(error),
      title: existsSync(join(authorization.canonicalPath, 'marketplace.yaml'))
        ? 'Marketplace 基础信息无法读取'
        : '这里还不是可识别的 Marketplace',
      summary: existsSync(join(authorization.canonicalPath, 'marketplace.yaml'))
        ? 'marketplace.yaml 存在，但其中的基础信息不是有效格式。'
        : '所选文件夹中没有 marketplace.yaml。',
      impact: '这个位置可以继续只读检查，但不会被标记为有效的活动 Marketplace。',
      nextAction: '请在外部修正 Marketplace 基础信息，然后重新检查。',
    });
  }

  const discoveredNames = pluginNamesForRequest(
    authorization,
    request.workspaceOnly ? undefined : request.pluginNames,
    collector,
    dependencies.readDirectory ??
      ((path) => readdirSync(path, { withFileTypes: true })),
  );
  const names = request.workspaceOnly ? [] : discoveredNames;
  const mutablePlugins = names.map((name) =>
    scanPlugin(authorization, name, collector, {
      inspectGenerated: request.scope !== 'source-and-references',
      beforeGeneratedRead: dependencies.beforeGeneratedRead,
    }),
  );
  const sourceIssueIds = collector.issues
    .filter((issue) => issue.dimension === 'source')
    .map((issue) => issue.id);
  const referenceIssueIds = collector.issues
    .filter((issue) => issue.dimension === 'reference')
    .map((issue) => issue.id);
  const generatedIssueIds = collector.issues
    .filter((issue) => issue.dimension === 'generated')
    .map((issue) => issue.id);
  const source: SourceValidity =
    sourceIssueIds.length > 0 ? 'invalid' : 'valid';
  const references = aggregateReferences(
    mutablePlugins,
    collector.issues,
  );
  const generated = aggregateGenerated(mutablePlugins);
  const overall =
    source === 'invalid' || references === 'invalid'
      ? 'invalid'
      : generated === 'missing' || generated === 'stale'
        ? 'stale'
        : mutablePlugins.length === 0
          ? 'empty'
          : 'ready';
  const platforms = Array.from(
    new Set(mutablePlugins.flatMap((plugin) => plugin.platforms)),
  ) as Array<'Agent Plugins' | 'Claude Code' | 'Codex'>;

  const snapshot: WorkspaceHealthSnapshot = {
    overall,
    workspace: {
      path: authorization.canonicalPath,
      name: marketplace.name,
      ...(marketplace.description === undefined
        ? {}
        : { description: marketplace.description }),
      ...(marketplace.organization === undefined
        ? {}
        : { organization: marketplace.organization }),
      marketplaceValidity,
    },
    dimensions: {
      source: { state: source, issueIds: sourceIssueIds },
      references: { state: references, issueIds: referenceIssueIds },
      generated: { state: generated, issueIds: generatedIssueIds },
    },
    summary: {
      pluginCount: mutablePlugins.length,
      componentCount: mutablePlugins.reduce(
        (sum, plugin) => sum + plugin.componentCount,
        0,
      ),
      platformCount: platforms.length,
      platforms,
    },
    plugins: mutablePlugins.map(
      (plugin): WorkspacePluginHealth => ({
        id: plugin.id,
        directoryName: plugin.directoryName,
        displayName: plugin.displayName,
        ...(plugin.canonicalName === undefined
          ? {}
          : { canonicalName: plugin.canonicalName }),
        ...(plugin.version === undefined ? {} : { version: plugin.version }),
        componentCount: plugin.componentCount,
        componentKinds: plugin.componentKinds,
        platforms: plugin.platforms,
        source: plugin.source,
        references: plugin.references,
        generated: plugin.generated,
        issueIds: plugin.issueIds,
        diagnosticRefs: Array.from(new Set(plugin.diagnosticRefs)),
      }),
    ),
    issues: collector.issues,
    diagnostics: collector.diagnostics,
    recommendedAction: recommend(collector.issues, mutablePlugins.length),
    checkedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    access: 'read-only',
    generatedScope: 'plugin-manifests',
  };
  return {
    status: 'scanned',
    snapshot,
    validationDiagnostics: collector.validationDiagnostics,
  };
}

export function scanWorkspaceHealth(
  request: ScanWorkspaceHealthRequest,
  dependencies: ScanDependencies = {},
): ScanWorkspaceHealthResult {
  try {
    return scanWorkspaceHealthUnsafe(request, dependencies);
  } catch (error) {
    return error instanceof AuthorizedPathError
      ? mapAuthorizationFailure(error)
      : unavailableFromUnexpectedFailure(error);
  }
}
