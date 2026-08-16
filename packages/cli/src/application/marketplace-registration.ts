import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getMarketplaceRegistrationAdapter,
  MARKETPLACE_REGISTRATION_ADAPTERS,
  type MarketplaceRegistrationRuntime,
} from '../adapters/marketplace-registration.js';
import { CommandError } from '../core/errors.js';
import {
  AGENT_TARGET_IDS,
  isAgentTargetId,
  type AgentTargetId,
  type MarketplaceRegistrationInspection,
  type MarketplaceRegistrationReport,
  type MarketplaceRegistrationSource,
  type TargetInspection,
  type TargetRegistrationResult,
} from './marketplace-registration-contract.js';

export interface NormalizeMarketplaceSourceOptions {
  readonly baseDir?: string;
  readonly homeDir?: string;
}

const GITHUB_SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const SCP_SSH_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:][^\s]*$/;
const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function assertNoTerminalControlCharacters(value: string, label: string): void {
  if (TERMINAL_CONTROL_CHARACTERS.test(value)) {
    throw new CommandError(`${label}不能包含 C0、C1 或 DEL 控制字符。`);
  }
}

function assertNoEncodedTerminalControlCharacters(value: string, label: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new CommandError(`${label}包含无效的百分号编码。`);
  }
  assertNoTerminalControlCharacters(decoded, `解码后的${label}`);
}

function appendPathWithoutNormalizing(baseDir: string, relativePath: string): string {
  return `${baseDir}${baseDir.endsWith(sep) ? '' : sep}${relativePath}`;
}

function expandHomePath(value: string, homeDir: string): string {
  if (value === '~') {
    return resolve(homeDir);
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return appendPathWithoutNormalizing(resolve(homeDir), value.slice(2));
  }
  return value;
}

function looksLikeLocalPath(value: string): boolean {
  return (
    value === '.' ||
    value === '..' ||
    value === '~' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~/') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\') ||
    value.startsWith('~\\') ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function normalizeLocalSource(
  input: string,
  candidatePath: string,
): MarketplaceRegistrationSource {
  const stat = lstatSync(candidatePath);
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new CommandError(`Marketplace 本地来源不是目录: ${candidatePath}`);
  }

  const localPath = realpathSync(candidatePath);
  assertNoTerminalControlCharacters(localPath, '解析后的 Marketplace 本地路径');
  if (!lstatSync(localPath).isDirectory()) {
    throw new CommandError(`Marketplace 本地来源不是目录: ${candidatePath}`);
  }

  return {
    kind: 'local',
    input,
    displayValue: localPath,
    clientValue: localPath,
    vscodeValue: pathToFileURL(localPath).href,
    localPath,
  };
}

function normalizeHttpsSource(input: string, parsed: URL): MarketplaceRegistrationSource {
  if (parsed.protocol !== 'https:') {
    throw new CommandError(`Git URL 只接受 HTTPS 或 SSH: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new CommandError('Git URL 不能包含内嵌凭据；请使用客户端已有的认证配置。');
  }
  if (!parsed.hostname || parsed.pathname.split('/').filter(Boolean).length < 2) {
    throw new CommandError('HTTPS Git URL 必须包含主机、owner 与 repository 路径。');
  }
  if (parsed.search || parsed.hash) {
    throw new CommandError('Git URL 不能包含 query 或 fragment。');
  }
  return {
    kind: 'git',
    input,
    displayValue: input,
    clientValue: input,
    vscodeValue: input,
  };
}

function normalizeSshSource(input: string, parsed: URL): MarketplaceRegistrationSource {
  if (parsed.password) {
    throw new CommandError('SSH Git URL 不能包含内嵌密码。');
  }
  if (!parsed.hostname || parsed.pathname.split('/').filter(Boolean).length < 2) {
    throw new CommandError('SSH Git URL 必须包含主机、owner 与 repository 路径。');
  }
  if (parsed.search || parsed.hash) {
    throw new CommandError('SSH Git URL 不能包含 query 或 fragment。');
  }
  return {
    kind: 'git',
    input,
    displayValue: input,
    clientValue: input,
    vscodeValue: input,
  };
}

export function normalizeMarketplaceSource(
  sourceInput: string,
  options: NormalizeMarketplaceSourceOptions = {},
): MarketplaceRegistrationSource {
  assertNoTerminalControlCharacters(sourceInput, 'Marketplace 来源');
  if (sourceInput.length === 0 || sourceInput !== sourceInput.trim()) {
    throw new CommandError('Marketplace 来源不能为空，也不能包含首尾空白。');
  }
  if (sourceInput.startsWith('-')) {
    throw new CommandError('Marketplace 来源不能以 - 开头。');
  }

  const baseDir = resolve(options.baseDir ?? process.env.INIT_CWD ?? process.cwd());
  const expanded = expandHomePath(sourceInput, options.homeDir ?? homedir());
  const localCandidate = isAbsolute(expanded)
    ? expanded
    : appendPathWithoutNormalizing(baseDir, expanded);
  assertNoTerminalControlCharacters(localCandidate, '解析后的 Marketplace 本地路径');
  if (existsSync(localCandidate)) {
    return normalizeLocalSource(sourceInput, localCandidate);
  }
  if (looksLikeLocalPath(sourceInput)) {
    throw new CommandError(`Marketplace 本地路径不存在: ${localCandidate}`);
  }

  const shorthand = GITHUB_SHORTHAND.exec(sourceInput);
  if (shorthand) {
    if (shorthand[1] === '.' || shorthand[1] === '..' || shorthand[2] === '.' || shorthand[2] === '..') {
      throw new CommandError('GitHub owner/repo 的 owner 与 repository 不能是 . 或 ..。');
    }
    return {
      kind: 'git',
      input: sourceInput,
      displayValue: sourceInput,
      clientValue: sourceInput,
      vscodeValue: sourceInput,
    };
  }

  if (SCP_SSH_URL.test(sourceInput)) {
    assertNoEncodedTerminalControlCharacters(sourceInput, 'SCP SSH Git URL');
    return {
      kind: 'git',
      input: sourceInput,
      displayValue: sourceInput,
      clientValue: sourceInput,
      vscodeValue: sourceInput,
    };
  }

  if (sourceInput.includes('://')) {
    assertNoEncodedTerminalControlCharacters(sourceInput, 'Marketplace Git URL');
    let parsed: URL;
    try {
      parsed = new URL(sourceInput);
    } catch {
      throw new CommandError('Marketplace Git URL 格式无效。');
    }
    if (parsed.protocol === 'ssh:') {
      return normalizeSshSource(sourceInput, parsed);
    }
    return normalizeHttpsSource(sourceInput, parsed);
  }

  throw new CommandError(
    '无法识别来源；请传入已存在的本地目录、owner/repo、HTTPS Git URL 或 SSH Git URL。',
  );
}

export interface InspectMarketplaceRegistrationOptions extends NormalizeMarketplaceSourceOptions {
  readonly targetIds?: readonly string[];
  readonly runtime?: MarketplaceRegistrationRuntime;
}

export interface ExecuteMarketplaceRegistrationOptions {
  readonly runtime?: MarketplaceRegistrationRuntime;
  readonly onTargetStart?: (inspection: TargetInspection) => void;
  readonly onTargetResult?: (result: TargetRegistrationResult) => void;
}

export function normalizeTargetIds(values: readonly string[]): AgentTargetId[] {
  const requested = new Set<AgentTargetId>();
  for (const value of values) {
    if (!isAgentTargetId(value)) {
      throw new CommandError(
        `未知 agent: ${value}。可选值: ${AGENT_TARGET_IDS.join(', ')}`,
      );
    }
    requested.add(value);
  }
  const normalized = AGENT_TARGET_IDS.filter((id) => requested.has(id));
  if (normalized.length === 0) {
    throw new CommandError('至少选择一个 agent。');
  }
  return normalized;
}

export async function inspectMarketplaceRegistration(
  sourceInput: string,
  options: InspectMarketplaceRegistrationOptions = {},
): Promise<MarketplaceRegistrationInspection> {
  const source = normalizeMarketplaceSource(sourceInput, options);
  const targetIds = normalizeTargetIds(options.targetIds ?? AGENT_TARGET_IDS);
  const selected = new Set(targetIds);
  const targets: TargetInspection[] = [];
  let interrupted = false;
  for (const adapter of MARKETPLACE_REGISTRATION_ADAPTERS) {
    if (!selected.has(adapter.id)) {
      continue;
    }
    if (!interrupted && options.runtime?.signal?.aborted) {
      targets.push({
        id: adapter.id,
        label: adapter.label,
        status: 'interrupted',
        message: '因用户中断未执行能力探测或注册。',
        recovery: '确认客户端状态后重新运行命令。',
      });
      interrupted = true;
      continue;
    }
    if (interrupted) {
      targets.push({
        id: adapter.id,
        label: adapter.label,
        status: 'interrupted',
        message: '因前序目标中断未执行能力探测或注册。',
        recovery: '确认中断目标的客户端状态后重新运行命令。',
      });
      continue;
    }
    const inspection = await adapter.inspect(source, options.runtime);
    targets.push(inspection);
    if (inspection.status === 'interrupted') {
      interrupted = true;
    }
  }
  return { source, targets };
}

function resultFromInspection(target: TargetInspection): TargetRegistrationResult {
  return {
    id: target.id,
    label: target.label,
    status: target.status === 'ready' ? 'failed' : target.status,
    message: target.message,
    recovery: target.recovery,
    ...(target.invocation ? { invocation: target.invocation } : {}),
  };
}

function interruptedBeforeRegistrationResult(
  target: TargetInspection,
  message: string,
): TargetRegistrationResult {
  return {
    id: target.id,
    label: target.label,
    status: 'interrupted',
    message,
    recovery: '确认中断目标的客户端状态后重新运行命令。',
    ...(target.invocation ? { invocation: target.invocation } : {}),
  };
}

export function marketplaceRegistrationExitCode(
  results: readonly TargetRegistrationResult[],
): 0 | 1 | 2 | 130 {
  if (results.some((result) => result.status === 'interrupted')) {
    return 130;
  }
  const completed = results.filter((result) => result.status === 'completed').length;
  if (completed === results.length && results.length > 0) {
    return 0;
  }
  if (completed > 0) {
    return 2;
  }
  return 1;
}

export async function executeMarketplaceRegistration(
  inspection: MarketplaceRegistrationInspection,
  options: ExecuteMarketplaceRegistrationOptions = {},
): Promise<MarketplaceRegistrationReport> {
  const preflightInterruptedIndex = inspection.targets.findIndex(
    (target) => target.status === 'interrupted',
  );
  if (preflightInterruptedIndex >= 0) {
    const results = inspection.targets.map((target, index) => {
      if (index < preflightInterruptedIndex && target.status === 'ready') {
        return interruptedBeforeRegistrationResult(
          target,
          `因能力探测阶段中断未执行注册。预检状态：${target.message}`,
        );
      }
      return resultFromInspection(target);
    });
    results.forEach((result) => options.onTargetResult?.(result));
    return {
      source: inspection.source,
      results,
      exitCode: 130,
    };
  }

  const results: TargetRegistrationResult[] = [];
  for (const [index, target] of inspection.targets.entries()) {
    if (options.runtime?.signal?.aborted) {
      for (const remaining of inspection.targets.slice(index)) {
        const skipped = remaining.status === 'ready'
          ? interruptedBeforeRegistrationResult(
              remaining,
              `因用户中断未执行注册。预检状态：${remaining.message}`,
            )
          : resultFromInspection(remaining);
        results.push(skipped);
        options.onTargetResult?.(skipped);
      }
      break;
    }
    options.onTargetStart?.(target);
    const adapter = getMarketplaceRegistrationAdapter(target.id);
    const result = await adapter.execute(inspection.source, target, options.runtime);
    results.push(result);
    options.onTargetResult?.(result);
    if (result.status === 'interrupted') {
      for (const remaining of inspection.targets.slice(index + 1)) {
        const skipped = remaining.status === 'ready'
          ? interruptedBeforeRegistrationResult(
              remaining,
              `因前序目标中断未执行注册。预检状态：${remaining.message}`,
            )
          : resultFromInspection(remaining);
        results.push(skipped);
        options.onTargetResult?.(skipped);
      }
      break;
    }
  }
  return {
    source: inspection.source,
    results,
    exitCode: marketplaceRegistrationExitCode(results),
  };
}
