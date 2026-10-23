import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  AgentTargetId,
  MarketplaceRegistrationSource,
  PluginInstallResult,
  RegistrationInvocation,
  TargetInspection,
  TargetRegistrationResult,
} from '../application/marketplace-registration-contract.js';
import {
  systemProcessRunner,
  type ProcessResult,
  type ProcessRunner,
} from '../infrastructure/process-runner.js';
import {
  inspectVscodeUserSettings,
  updateVscodeMarketplaceSettings,
  type VscodeSettingsInspection,
  type VscodeSettingsUpdateRequest,
  type VscodeSettingsUpdateResult,
} from '../infrastructure/vscode-user-settings.js';

export interface MarketplaceRegistrationRuntime {
  readonly processRunner?: ProcessRunner;
  readonly signal?: AbortSignal;
  readonly inspectVscode?: (
    runner: ProcessRunner,
    signal?: AbortSignal,
  ) => VscodeSettingsInspection | Promise<VscodeSettingsInspection>;
  readonly updateVscode?: (
    request: VscodeSettingsUpdateRequest,
  ) => VscodeSettingsUpdateResult;
}

export interface MarketplaceRegistrationAdapter {
  readonly id: AgentTargetId;
  readonly label: string;
  inspect(
    source: MarketplaceRegistrationSource,
    runtime?: MarketplaceRegistrationRuntime,
  ): Promise<TargetInspection>;
  execute(
    source: MarketplaceRegistrationSource,
    inspection: TargetInspection,
    runtime?: MarketplaceRegistrationRuntime,
  ): Promise<TargetRegistrationResult>;
  /** Present only when the client CLI exposes a documented plugin install command. */
  installPlugins?(
    source: MarketplaceRegistrationSource,
    plugins: readonly string[],
    runtime?: MarketplaceRegistrationRuntime,
    onInvocation?: (invocation: RegistrationInvocation) => void,
  ): Promise<PluginInstallResult[]>;
}

interface NativeAdapterDefinition {
  readonly id: 'claude' | 'codex' | 'copilot' | 'grok';
  readonly label: string;
  readonly executable: string;
  readonly localIndexCandidates: readonly string[];
  readonly missingRecovery: string;
  /** argv prefix before `<plugin>@<marketplace>`, e.g. `plugin install`. */
  readonly pluginInstallArgs?: readonly string[];
}

/** Shared fallback when a client still fails add after list preflight. */
const ALREADY_REGISTERED_PATTERNS = [
  /already configured/i,
  /already added/i,
  /already on disk/i,
] as const;

const SOURCE_CANDIDATE_KEYS = new Set([
  'path',
  'url',
  'repo',
  'root',
  'source',
  'repository',
]);

/**
 * Normalize a marketplace source string so local paths and GitHub shorthand /
 * HTTPS / SSH forms of the same repo can be compared across client list JSON.
 */
export function normalizeMarketplaceSourceKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const githubHttps = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?(?:#.*)?$/i,
  );
  if (githubHttps) {
    return `github:${githubHttps[1].toLowerCase()}/${githubHttps[2].toLowerCase()}`;
  }
  const githubSsh = trimmed.match(
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i,
  );
  if (githubSsh) {
    return `github:${githubSsh[1].toLowerCase()}/${githubSsh[2].toLowerCase()}`;
  }
  const shorthand = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#.*)?$/);
  if (
    shorthand &&
    !trimmed.includes(':') &&
    !trimmed.startsWith('.') &&
    !trimmed.startsWith('/') &&
    !/^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return `github:${shorthand[1].toLowerCase()}/${shorthand[2].toLowerCase()}`;
  }
  if (
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    try {
      return `local:${realpathSync(resolve(trimmed))}`;
    } catch {
      return `local:${resolve(trimmed)}`;
    }
  }
  // Only the protocol and hostname are case-insensitive on ordinary Git hosts.
  // Repository paths and SSH usernames may identify distinct sources by case.
  const withoutGit = (path: string): string => path.replace(/\/$/, '').replace(/\.git$/i, '');
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = withoutGit(url.pathname);
    return `other:${url.href}`;
  } catch {
    const scp = trimmed.match(/^([^@/]+@)([^:/]+):(.+)$/);
    if (scp) {
      return `other:${scp[1]}${scp[2].toLowerCase()}:${withoutGit(scp[3])}`;
    }
    return `other:${withoutGit(trimmed)}`;
  }
}

function collectMarketplaceSourceCandidates(
  value: unknown,
  out: string[],
  parentKey?: string,
): void {
  if (typeof value === 'string') {
    if (
      parentKey === undefined ||
      SOURCE_CANDIDATE_KEYS.has(parentKey) ||
      parentKey.endsWith('Path') ||
      parentKey.endsWith('Url') ||
      parentKey.endsWith('Repo')
    ) {
      if (value.trim().length > 0) {
        out.push(value);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMarketplaceSourceCandidates(item, out, parentKey);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectMarketplaceSourceCandidates(child, out, key);
    }
  }
}

function wantedSourceKeys(source: MarketplaceRegistrationSource): Set<string> {
  // Application normalization already resolved relative paths against INIT_CWD
  // (or its explicit baseDir). Reinterpreting input here loses that identity.
  if (source.kind === 'local') {
    return new Set([normalizeMarketplaceSourceKey(source.localPath)]);
  }
  return new Set(
    [source.clientValue, source.displayValue, source.input]
      .map((value) => normalizeMarketplaceSourceKey(value))
      .filter((value) => value.length > 0),
  );
}

function candidatesMatch(candidates: readonly string[], wanted: ReadonlySet<string>): boolean {
  return candidates.some((candidate) => {
    const key = normalizeMarketplaceSourceKey(candidate);
    return key.length > 0 && wanted.has(key);
  });
}

/** True when list --json output already contains the registration source. */
export function marketplaceListContainsSource(
  listJsonText: string,
  source: MarketplaceRegistrationSource,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listJsonText);
  } catch {
    return false;
  }
  const candidates: string[] = [];
  collectMarketplaceSourceCandidates(parsed, candidates);
  return candidatesMatch(candidates, wantedSourceKeys(source));
}

const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve the client-side marketplace name for a registered source from list --json output.
 * Matching is by source path/URL/repo, never by name, mirroring the registration precheck.
 */
export function marketplaceNameFromList(
  listJsonText: string,
  source: MarketplaceRegistrationSource,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listJsonText);
  } catch {
    return undefined;
  }
  const wanted = wantedSourceKeys(source);
  const visit = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) {
          return found;
        }
      }
      return undefined;
    }
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.name === 'string' && MARKETPLACE_NAME.test(record.name)) {
      const candidates: string[] = [];
      for (const [key, child] of Object.entries(record)) {
        if (key !== 'name') {
          collectMarketplaceSourceCandidates(child, candidates, key);
        }
      }
      if (candidatesMatch(candidates, wanted)) {
        return record.name;
      }
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return visit(parsed);
}

function runnerFor(runtime?: MarketplaceRegistrationRuntime): ProcessRunner {
  return runtime?.processRunner ?? systemProcessRunner;
}

function localIndexFailure(
  source: MarketplaceRegistrationSource,
  candidates: readonly string[],
): string | undefined {
  if (source.kind !== 'local') {
    return undefined;
  }
  const available = candidates.some((relativePath) => {
    try {
      return lstatSync(join(source.localPath, relativePath)).isFile();
    } catch {
      return false;
    }
  });
  if (available) {
    return undefined;
  }
  return `本地 Marketplace 缺少目标索引: ${candidates.join(' 或 ')}`;
}

function failedLocalInspection(
  id: AgentTargetId,
  label: string,
  message: string,
): TargetInspection {
  return {
    id,
    label,
    status: 'failed',
    message,
    recovery: '先在来源 Marketplace 中运行 build/index/validate，再重新注册。',
  };
}

function pathIsInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== '..' &&
      !isAbsolute(relativePath))
  );
}

function canonicalizePotentialPath(path: string): string | undefined {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(cursor), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return undefined;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        return undefined;
      }
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function vscodeSourceBoundaryFailure(
  source: MarketplaceRegistrationSource,
  settingsPath: string,
): TargetInspection | undefined {
  if (source.kind !== 'local') {
    return undefined;
  }
  const lexicalSettingsPath = resolve(settingsPath);
  const canonicalSettingsPath = canonicalizePotentialPath(settingsPath);
  const overlaps =
    pathIsInside(source.localPath, lexicalSettingsPath) ||
    (canonicalSettingsPath !== undefined &&
      pathIsInside(source.localPath, canonicalSettingsPath));
  if (!overlaps && canonicalSettingsPath !== undefined) {
    return undefined;
  }
  return {
    id: 'vscode',
    label: 'VS Code',
    status: 'failed',
    message: overlaps
      ? 'VS Code 用户配置路径与本地 Marketplace 来源重叠；为保持来源只读，没有写入配置。'
      : '无法安全确认 VS Code 用户配置路径不在本地 Marketplace 来源内；没有写入配置。',
    recovery: '将 Marketplace 移出 VS Code 用户配置目录，或修正 HOME/XDG/APPDATA 后重试。',
  };
}

function resultFromInspection(inspection: TargetInspection): TargetRegistrationResult {
  return {
    id: inspection.id,
    label: inspection.label,
    status: inspection.status === 'ready' ? 'failed' : inspection.status,
    message:
      inspection.status === 'ready'
        ? `${inspection.label} 注册未执行。`
        : inspection.message,
    recovery: inspection.recovery,
    ...(inspection.invocation ? { invocation: inspection.invocation } : {}),
  };
}

function processFailureMessage(result: ProcessResult): string {
  if (result.status !== 'failed') {
    return '';
  }
  const detail = result.stderr.trim() || result.stdout.trim() || result.message;
  return `${detail}${result.exitCode === null ? '' : ` (exit ${result.exitCode})`}`;
}

function nativePluginInstaller(
  definition: NativeAdapterDefinition,
  pluginInstallArgs: readonly string[],
): NonNullable<MarketplaceRegistrationAdapter['installPlugins']> {
  return async (source, plugins, runtime, onInvocation) => {
    const pluginResult = (
      plugin: string,
      result: Omit<PluginInstallResult, 'id' | 'label' | 'plugin'>,
    ): PluginInstallResult => ({
      id: definition.id,
      label: definition.label,
      plugin,
      ...result,
    });
    const manualCommand = (plugin: string, marketplace = '<marketplace>'): string =>
      [definition.executable, ...pluginInstallArgs, `${plugin}@${marketplace}`].join(' ');

    const listed = await runnerFor(runtime).run({
      executable: definition.executable,
      args: ['plugin', 'marketplace', 'list', '--json'],
      captureOutput: true,
      signal: runtime?.signal,
    });
    if (listed.status !== 'completed') {
      return plugins.map((plugin) => {
        if (listed.status === 'interrupted') {
          return pluginResult(plugin, {
            status: 'interrupted',
            message: `插件安装前 list 被 ${listed.signal} 中断；未安装 ${plugin}。`,
            recovery: '确认客户端状态后重新运行命令。',
          });
        }
        if (listed.status === 'missing') {
          return pluginResult(plugin, {
            status: 'missing-cli',
            message: `未找到 ${definition.executable} CLI；未安装 ${plugin}。`,
            recovery: definition.missingRecovery,
          });
        }
        return pluginResult(plugin, {
          status: 'failed',
          message: `无法读取已注册 Marketplace 列表: ${processFailureMessage(listed)}`,
          recovery: `确认 Marketplace 已注册后手动运行: ${manualCommand(plugin)}`,
        });
      });
    }
    const marketplace = marketplaceNameFromList(listed.stdout, source);
    if (!marketplace) {
      return plugins.map((plugin) =>
        pluginResult(plugin, {
          status: 'failed',
          message: `plugin marketplace list --json 中没有找到来源 ${source.displayValue} 对应的 Marketplace 名称；未安装 ${plugin}。`,
          recovery: `运行 ${definition.executable} plugin marketplace list 查看名称后手动运行: ${manualCommand(plugin)}`,
        }),
      );
    }

    const results: PluginInstallResult[] = [];
    let interrupted = false;
    for (const plugin of plugins) {
      const invocation = {
        executable: definition.executable,
        args: [...pluginInstallArgs, `${plugin}@${marketplace}`],
      };
      if (interrupted || runtime?.signal?.aborted) {
        results.push(
          pluginResult(plugin, {
            status: 'interrupted',
            message: `因中断未安装 ${plugin}@${marketplace}。`,
            recovery: '确认客户端状态后重新运行命令。',
            invocation,
          }),
        );
        continue;
      }
      onInvocation?.(invocation);
      const executed = await runnerFor(runtime).run({
        executable: invocation.executable,
        args: invocation.args,
        captureOutput: true,
        signal: runtime?.signal,
      });
      if (executed.status === 'completed') {
        results.push(
          pluginResult(plugin, {
            status: 'completed',
            message: `插件 ${plugin}@${marketplace} 已通过原生 CLI 安装。`,
            invocation,
          }),
        );
      } else if (executed.status === 'missing') {
        results.push(
          pluginResult(plugin, {
            status: 'missing-cli',
            message: `执行前未找到 ${definition.executable} CLI；未安装 ${plugin}。`,
            recovery: definition.missingRecovery,
            invocation,
          }),
        );
      } else if (executed.status === 'interrupted') {
        interrupted = true;
        results.push(
          pluginResult(plugin, {
            status: 'interrupted',
            message: `插件安装被 ${executed.signal} 中断。`,
            recovery: '确认客户端状态后重新运行命令。',
            invocation,
          }),
        );
      } else {
        results.push(
          pluginResult(plugin, {
            status: 'failed',
            message: `原生 CLI 安装插件失败: ${processFailureMessage(executed)}`,
            recovery: `确认插件名存在于 Marketplace ${marketplace} 后重试: ${manualCommand(plugin, marketplace)}`,
            invocation,
          }),
        );
      }
    }
    return results;
  };
}

function nativeAdapter(definition: NativeAdapterDefinition): MarketplaceRegistrationAdapter {
  const probeArgs = ['plugin', 'marketplace', 'add', '--help'] as const;
  return {
    id: definition.id,
    label: definition.label,
    async inspect(source, runtime): Promise<TargetInspection> {
      const localFailure = localIndexFailure(source, definition.localIndexCandidates);
      if (localFailure) {
        return failedLocalInspection(definition.id, definition.label, localFailure);
      }
      const probe = await runnerFor(runtime).run({
        executable: definition.executable,
        args: probeArgs,
        captureOutput: true,
        signal: runtime?.signal,
      });
      const invocation = {
        executable: definition.executable,
        args: ['plugin', 'marketplace', 'add', source.clientValue],
      } as const;
      if (probe.status === 'missing') {
        return {
          id: definition.id,
          label: definition.label,
          status: 'missing-cli',
          message: `未找到 ${definition.executable} CLI。`,
          recovery: definition.missingRecovery,
          invocation,
        };
      }
      if (probe.status === 'interrupted') {
        return {
          id: definition.id,
          label: definition.label,
          status: 'interrupted',
          message: `${definition.label} 能力探测被 ${probe.signal} 中断。`,
          recovery: '重新运行命令。',
          invocation,
        };
      }
      if (probe.status === 'failed') {
        return {
          id: definition.id,
          label: definition.label,
          status: 'failed',
          message: `${definition.executable} CLI 不支持 plugin marketplace add: ${processFailureMessage(probe)}`,
          recovery: definition.missingRecovery,
          invocation,
        };
      }
      return {
        id: definition.id,
        label: definition.label,
        status: 'ready',
        message: `${definition.label} 可通过原生 CLI 注册。`,
        recovery: definition.missingRecovery,
        invocation,
      };
    },
    async execute(source, inspection, runtime): Promise<TargetRegistrationResult> {
      const localFailure = localIndexFailure(source, definition.localIndexCandidates);
      if (localFailure) {
        return resultFromInspection(
          failedLocalInspection(definition.id, definition.label, localFailure),
        );
      }
      if (inspection.status !== 'ready') {
        return resultFromInspection(inspection);
      }
      const invocation = inspection.invocation ?? {
        executable: definition.executable,
        args: ['plugin', 'marketplace', 'add', source.clientValue],
      };
      const listed = await runnerFor(runtime).run({
        executable: definition.executable,
        args: ['plugin', 'marketplace', 'list', '--json'],
        captureOutput: true,
        signal: runtime?.signal,
      });
      if (listed.status === 'interrupted') {
        return {
          id: definition.id,
          label: definition.label,
          status: 'interrupted',
          message: `注册前 list 被 ${listed.signal} 中断。`,
          recovery: '确认客户端状态后重新运行命令。',
          invocation,
        };
      }
      if (listed.status === 'missing') {
        return {
          id: definition.id,
          label: definition.label,
          status: 'missing-cli',
          message: `执行前未找到 ${definition.executable} CLI。`,
          recovery: definition.missingRecovery,
          invocation,
        };
      }
      if (
        listed.status === 'completed' &&
        marketplaceListContainsSource(listed.stdout, source)
      ) {
        return {
          id: definition.id,
          label: definition.label,
          status: 'completed',
          message: 'Marketplace 已注册（list 预检命中）。',
          invocation,
        };
      }
      const executed = await runnerFor(runtime).run({
        executable: invocation.executable,
        args: invocation.args,
        captureOutput: true,
        signal: runtime?.signal,
      });
      if (executed.status === 'completed') {
        return {
          id: definition.id,
          label: definition.label,
          status: 'completed',
          message: 'Marketplace 已通过原生 CLI 注册。',
          invocation,
        };
      }
      if (executed.status === 'missing') {
        return {
          id: definition.id,
          label: definition.label,
          status: 'missing-cli',
          message: `执行前未找到 ${definition.executable} CLI。`,
          recovery: definition.missingRecovery,
          invocation,
        };
      }
      if (executed.status === 'interrupted') {
        return {
          id: definition.id,
          label: definition.label,
          status: 'interrupted',
          message: `注册被 ${executed.signal} 中断。`,
          recovery: '确认客户端状态后重新运行命令。',
          invocation,
        };
      }
      const failureText = `${executed.stdout}\n${executed.stderr}\n${executed.message}`;
      if (ALREADY_REGISTERED_PATTERNS.some((pattern) => pattern.test(failureText))) {
        return {
          id: definition.id,
          label: definition.label,
          status: 'completed',
          message: 'Marketplace 已注册（来源已存在）。',
          invocation,
        };
      }
      return {
        id: definition.id,
        label: definition.label,
        status: 'failed',
        message: `原生 CLI 注册失败: ${processFailureMessage(executed)}`,
        recovery: '检查来源、客户端认证与 CLI 输出后重试。',
        invocation,
      };
    },
    ...(definition.pluginInstallArgs
      ? { installPlugins: nativePluginInstaller(definition, definition.pluginInstallArgs) }
      : {}),
  };
}

const claudeAdapter = nativeAdapter({
  id: 'claude',
  label: 'Claude Code',
  executable: 'claude',
  localIndexCandidates: ['.claude-plugin/marketplace.json'],
  missingRecovery:
    '安装或升级 Claude Code CLI（例如 npm install -g @anthropic-ai/claude-code），确认 claude plugin marketplace add 可用后重试。',
  pluginInstallArgs: ['plugin', 'install'],
});

const codexAdapter = nativeAdapter({
  id: 'codex',
  label: 'Codex',
  executable: 'codex',
  localIndexCandidates: ['.agents/plugins/marketplace.json'],
  missingRecovery:
    '安装或升级 Codex CLI（例如 npm install -g @openai/codex），确认 codex plugin marketplace add 可用后重试。',
  pluginInstallArgs: ['plugin', 'add'],
});

const grokAdapter = nativeAdapter({
  id: 'grok',
  label: 'Grok Build',
  executable: 'grok',
  localIndexCandidates: ['.grok-plugin/marketplace.json'],
  missingRecovery: '安装或升级 Grok Build CLI，确认 plugin marketplace add 可用后重试。',
});

const copilotAdapter = nativeAdapter({
  id: 'copilot',
  label: 'GitHub Copilot',
  executable: 'copilot',
  localIndexCandidates: ['marketplace.json', '.github/plugin/marketplace.json'],
  missingRecovery: '安装或升级 GitHub Copilot CLI，确认 plugin marketplace add 可用后重试。',
});

const vscodeAdapter: MarketplaceRegistrationAdapter = {
  id: 'vscode',
  label: 'VS Code',
  async inspect(source, runtime): Promise<TargetInspection> {
    const localFailure = localIndexFailure(source, [
      'marketplace.json',
      '.github/plugin/marketplace.json',
    ]);
    if (localFailure) {
      return failedLocalInspection('vscode', 'VS Code', localFailure);
    }
    const inspected = runtime?.inspectVscode
      ? await runtime.inspectVscode(runnerFor(runtime), runtime.signal)
      : await inspectVscodeUserSettings(runnerFor(runtime), {
          ...(runtime?.signal ? { signal: runtime.signal } : {}),
        });
    if (inspected.status === 'interrupted') {
      return {
        id: 'vscode',
        label: 'VS Code',
        status: 'interrupted',
        message: `VS Code 探测被 ${inspected.signal} 中断。`,
        recovery: '重新运行命令。',
      };
    }
    if (inspected.status === 'unavailable') {
      return {
        id: 'vscode',
        label: 'VS Code',
        status: 'failed',
        message: inspected.message,
        recovery: '安装官方 VS Code，或先启动一次以创建用户配置目录后重试。',
      };
    }
    const sourceBoundaryFailure = vscodeSourceBoundaryFailure(
      source,
      inspected.settingsPath,
    );
    if (sourceBoundaryFailure) {
      return sourceBoundaryFailure;
    }
    return {
      id: 'vscode',
      label: 'VS Code',
      status: 'ready',
      message: `将更新用户配置: ${inspected.settingsPath}`,
      recovery: '修复用户 settings.json 或组织策略后重试。',
      settingsPath: inspected.settingsPath,
    };
  },
  async execute(source, inspection, runtime): Promise<TargetRegistrationResult> {
    const localFailure = localIndexFailure(source, [
      'marketplace.json',
      '.github/plugin/marketplace.json',
    ]);
    if (localFailure) {
      return resultFromInspection(failedLocalInspection('vscode', 'VS Code', localFailure));
    }
    if (inspection.status !== 'ready' || !inspection.settingsPath) {
      return resultFromInspection(inspection);
    }
    const sourceBoundaryFailure = vscodeSourceBoundaryFailure(
      source,
      inspection.settingsPath,
    );
    if (sourceBoundaryFailure) {
      return resultFromInspection(sourceBoundaryFailure);
    }
    const updated = (runtime?.updateVscode ?? updateVscodeMarketplaceSettings)({
      settingsPath: inspection.settingsPath,
      source: source.vscodeValue,
    });
    if (updated.status === 'failed') {
      return {
        id: 'vscode',
        label: 'VS Code',
        status: 'failed',
        message: updated.message,
        recovery: '检查当前 settings.json 并修复 JSONC、权限或并发冲突后重试；并发恢复为最佳努力，不能保证保留无条件 rename 窗口内的新 inode 写入。',
      };
    }
    return {
      id: 'vscode',
      label: 'VS Code',
      status: 'completed',
      message: updated.changed
        ? '用户配置已注入；请重新加载 VS Code 窗口。组织策略可能覆盖用户设置。'
        : '用户配置已包含该 Marketplace；请在需要时重新加载 VS Code 窗口。',
    };
  },
};

const cursorAdapter: MarketplaceRegistrationAdapter = {
  id: 'cursor',
  label: 'Cursor',
  async inspect(source): Promise<TargetInspection> {
    const localFailure = localIndexFailure(source, ['.cursor-plugin/marketplace.json']);
    if (localFailure) {
      return failedLocalInspection('cursor', 'Cursor', localFailure);
    }
    return {
      id: 'cursor',
      label: 'Cursor',
      status: 'manual-required',
      message: 'Cursor 当前需要通过 Dashboard 手工导入。',
      recovery:
        'Cursor Team/Enterprise 管理员进入 Dashboard → Plugins → Add Marketplace → Import from Repo。',
    };
  },
  async execute(_source, inspection): Promise<TargetRegistrationResult> {
    if (inspection.status === 'failed' || inspection.status === 'interrupted') {
      return resultFromInspection(inspection);
    }
    return {
      id: 'cursor',
      label: 'Cursor',
      status: 'manual-required',
      message:
        'Dashboard → Plugins → Add Marketplace → Import from Repo；需要 Cursor Team/Enterprise 且由管理员操作。',
      recovery:
        '满足组织版本和管理员权限后，在 Cursor Dashboard 中导入同一 Git 仓库或本地来源。',
    };
  },
};

export const MARKETPLACE_REGISTRATION_ADAPTERS: readonly MarketplaceRegistrationAdapter[] = [
  claudeAdapter,
  codexAdapter,
  grokAdapter,
  copilotAdapter,
  vscodeAdapter,
  cursorAdapter,
];

export function getMarketplaceRegistrationAdapter(
  id: AgentTargetId,
): MarketplaceRegistrationAdapter {
  const adapter = MARKETPLACE_REGISTRATION_ADAPTERS.find((candidate) => candidate.id === id);
  if (!adapter) {
    throw new Error(`Unknown marketplace registration adapter: ${id}`);
  }
  return adapter;
}
