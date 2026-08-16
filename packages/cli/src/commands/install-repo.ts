import { createInterface } from 'node:readline/promises';
import type { MarketplaceRegistrationRuntime } from '../adapters/marketplace-registration.js';
import {
  executeMarketplaceRegistration,
  inspectMarketplaceRegistration,
  normalizeTargetIds,
} from '../application/marketplace-registration.js';
import {
  AGENT_TARGET_IDS,
  type AgentTargetId,
  type MarketplaceRegistrationInspection,
  type MarketplaceRegistrationReport,
  type TargetInspection,
  type TargetRegistrationResult,
} from '../application/marketplace-registration-contract.js';
import { CommandError } from '../core/errors.js';

export interface InstallRepoOptions {
  readonly agent?: readonly string[];
  readonly all?: boolean;
}

export interface InstallRepoCommandDependencies {
  readonly runtime?: MarketplaceRegistrationRuntime;
  readonly baseDir?: string;
  readonly homeDir?: string;
  readonly interactive?: boolean;
  readonly readSelection?: (signal: AbortSignal) => Promise<string | undefined>;
  readonly write?: (text: string) => void;
}

export interface InstallRepoCommandResult {
  readonly exitCode: 0 | 1 | 2 | 130;
  readonly report?: MarketplaceRegistrationReport;
}

const INSPECTION_LABELS: Record<TargetInspection['status'], string> = {
  ready: '可自动',
  'missing-cli': '缺少 CLI',
  'manual-required': '需手动',
  failed: '不可用',
  interrupted: '中断',
};

const RESULT_LABELS: Record<TargetRegistrationResult['status'], string> = {
  completed: '完成',
  'missing-cli': '缺少 CLI',
  'manual-required': '需手动',
  failed: '失败',
  interrupted: '中断',
};

function defaultWrite(text: string): void {
  process.stdout.write(text);
}

async function defaultReadSelection(
  interruptController: AbortController,
): Promise<string | undefined> {
  if (interruptController.signal.aborted) {
    return undefined;
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const onSigint = (): void => {
    interruptController.abort('SIGINT');
  };
  terminal.on('SIGINT', onSigint);
  try {
    if (interruptController.signal.aborted) {
      return undefined;
    }
    return await terminal.question('> ', { signal: interruptController.signal });
  } catch (error) {
    if (
      interruptController.signal.aborted ||
      (error as Error | undefined)?.name === 'AbortError'
    ) {
      return undefined;
    }
    throw error;
  } finally {
    terminal.removeListener('SIGINT', onSigint);
    terminal.close();
  }
}

export function parseTargetSelection(
  input: string,
  availableTargetIds: readonly AgentTargetId[],
  defaultTargetIds: readonly AgentTargetId[],
): AgentTargetId[] {
  const value = input.trim();
  if (value.length === 0) {
    if (defaultTargetIds.length === 0) {
      throw new CommandError('当前没有默认可自动处理的 agent；请输入明确编号或 all。');
    }
    return normalizeTargetIds(defaultTargetIds);
  }
  if (value.toLowerCase() === 'all') {
    return normalizeTargetIds(availableTargetIds);
  }

  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.some((token) => !/^\d+$/u.test(token))) {
    throw new CommandError('请选择逗号分隔的 agent 编号，或输入 all。');
  }
  const selected: AgentTargetId[] = [];
  for (const token of tokens) {
    const index = Number(token) - 1;
    const target = availableTargetIds[index];
    if (!target) {
      throw new CommandError(`agent 编号超出范围: ${token}`);
    }
    selected.push(target);
  }
  return normalizeTargetIds(selected);
}

function renderPrompt(
  inspection: MarketplaceRegistrationInspection,
  write: (text: string) => void,
): AgentTargetId[] {
  write('请选择要注册 Marketplace 的 agent：\n');
  inspection.targets.forEach((target, index) => {
    write(`  ${index + 1}. ${target.label.padEnd(18)} [${INSPECTION_LABELS[target.status]}]\n`);
  });
  const defaults = inspection.targets
    .filter((target) => target.status === 'ready')
    .map((target) => target.id);
  const defaultNumbers = defaults.map(
    (id) => inspection.targets.findIndex((target) => target.id === id) + 1,
  );
  write(`\n默认：${defaultNumbers.length > 0 ? defaultNumbers.join(',') : '无'}\n`);
  write('输入编号（逗号分隔），输入 all 选择全部，直接回车接受默认：\n');
  return defaults;
}

function formatInvocation(target: TargetInspection): string {
  if (!target.invocation) {
    return target.message;
  }
  return [target.invocation.executable, ...target.invocation.args.map((arg) => JSON.stringify(arg))]
    .join(' ');
}

function renderTargetStart(target: TargetInspection, write: (text: string) => void): void {
  if (target.status === 'ready') {
    write(`→ ${target.label}: ${formatInvocation(target)}\n`);
  }
}

function renderResultLine(
  result: TargetRegistrationResult,
  write: (text: string) => void,
): void {
  write(`  [${RESULT_LABELS[result.status]}] ${result.label}：${result.message}\n`);
  if (result.status !== 'completed' && result.recovery) {
    write(`    下一步：${result.recovery}\n`);
  }
}

function renderReport(
  report: MarketplaceRegistrationReport,
  write: (text: string) => void,
): void {
  const completed = report.results.filter((result) => result.status === 'completed');
  const incomplete = report.results.filter((result) => result.status !== 'completed');
  write('\n注册结果：\n');
  write('已完成：\n');
  if (completed.length === 0) {
    write('  无\n');
  } else {
    completed.forEach((result) => renderResultLine(result, write));
  }
  write('未完成：\n');
  if (incomplete.length === 0) {
    write('  无\n');
  } else {
    incomplete.forEach((result) => renderResultLine(result, write));
  }
  write(`退出码：${report.exitCode}\n`);
}

function selectedInspection(
  inspection: MarketplaceRegistrationInspection,
  targetIds: readonly AgentTargetId[],
): MarketplaceRegistrationInspection {
  const selected = new Set(targetIds);
  return {
    source: inspection.source,
    targets: inspection.targets.filter((target) => selected.has(target.id)),
  };
}

export async function runInstallRepo(
  source: string,
  options: InstallRepoOptions,
  dependencies: InstallRepoCommandDependencies = {},
): Promise<InstallRepoCommandResult> {
  const requested = [...(options.agent ?? [])];
  if (options.all && requested.length > 0) {
    throw new CommandError('不能同时使用 --agent 与 --all。');
  }

  const interactive =
    dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const explicitTargetIds = options.all
    ? [...AGENT_TARGET_IDS]
    : requested.length > 0
      ? normalizeTargetIds(requested)
      : undefined;
  if (!explicitTargetIds && !interactive) {
    throw new CommandError('非交互终端必须显式传入至少一个 --agent，或使用 --all。');
  }

  const write = dependencies.write ?? defaultWrite;
  const interruptController = new AbortController();
  const onSigint = (): void => interruptController.abort('SIGINT');
  const runtime: MarketplaceRegistrationRuntime = {
    ...dependencies.runtime,
    signal: interruptController.signal,
  };
  process.on('SIGINT', onSigint);
  try {
    let inspection = await inspectMarketplaceRegistration(source, {
      baseDir: dependencies.baseDir,
      homeDir: dependencies.homeDir,
      targetIds: explicitTargetIds ?? AGENT_TARGET_IDS,
      runtime,
    });

    if (!explicitTargetIds) {
      const interrupted = inspection.targets.some((target) => target.status === 'interrupted');
      if (interrupted) {
        const report = await executeMarketplaceRegistration(inspection, {
          runtime,
          onTargetResult: (result) => renderResultLine(result, write),
        });
        renderReport(report, write);
        return { exitCode: 130, report };
      }
      const defaultTargetIds = renderPrompt(inspection, write);
      if (interruptController.signal.aborted) {
        write('\n[中断] 用户取消了 Marketplace 注册。\n');
        return { exitCode: 130 };
      }
      const answer = dependencies.readSelection
        ? await dependencies.readSelection(interruptController.signal)
        : await defaultReadSelection(interruptController);
      if (answer === undefined || interruptController.signal.aborted) {
        write('\n[中断] 用户取消了 Marketplace 注册。\n');
        return { exitCode: 130 };
      }
      const selected = parseTargetSelection(
        answer,
        inspection.targets.map((target) => target.id),
        defaultTargetIds,
      );
      inspection = selectedInspection(inspection, selected);
    }

    write(`Marketplace 来源：${inspection.source.displayValue}\n`);
    const report = await executeMarketplaceRegistration(inspection, {
      runtime,
      onTargetStart: (target) => renderTargetStart(target, write),
      onTargetResult: (result) => renderResultLine(result, write),
    });
    renderReport(report, write);
    return { exitCode: report.exitCode, report };
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
