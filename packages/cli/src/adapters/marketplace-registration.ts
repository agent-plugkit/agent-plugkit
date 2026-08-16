import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  AgentTargetId,
  MarketplaceRegistrationSource,
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
}

interface NativeAdapterDefinition {
  readonly id: 'claude' | 'codex' | 'copilot';
  readonly label: string;
  readonly executable: string;
  readonly localIndexCandidates: readonly string[];
  readonly missingRecovery: string;
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
      const executed = await runnerFor(runtime).run({
        executable: invocation.executable,
        args: invocation.args,
        captureOutput: false,
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
      return {
        id: definition.id,
        label: definition.label,
        status: 'failed',
        message: `原生 CLI 注册失败: ${processFailureMessage(executed)}`,
        recovery: '检查来源、客户端认证与 CLI 输出后重试。',
        invocation,
      };
    },
  };
}

const claudeAdapter = nativeAdapter({
  id: 'claude',
  label: 'Claude Code',
  executable: 'claude',
  localIndexCandidates: ['.claude-plugin/marketplace.json'],
  missingRecovery: '安装或升级 Claude Code CLI，确认 plugin marketplace add 可用后重试。',
});

const codexAdapter = nativeAdapter({
  id: 'codex',
  label: 'Codex',
  executable: 'codex',
  localIndexCandidates: ['.agents/plugins/marketplace.json'],
  missingRecovery: '安装或升级 Codex CLI，确认 plugin marketplace add 可用后重试。',
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
