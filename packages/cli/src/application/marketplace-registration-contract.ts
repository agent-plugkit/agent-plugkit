export const AGENT_TARGET_IDS = [
  'claude',
  'codex',
  'copilot',
  'vscode',
  'cursor',
] as const;

export type AgentTargetId = (typeof AGENT_TARGET_IDS)[number];

export interface LocalMarketplaceSource {
  readonly kind: 'local';
  readonly input: string;
  readonly displayValue: string;
  readonly clientValue: string;
  readonly vscodeValue: string;
  readonly localPath: string;
}

export interface GitMarketplaceSource {
  readonly kind: 'git';
  readonly input: string;
  readonly displayValue: string;
  readonly clientValue: string;
  readonly vscodeValue: string;
}

export type MarketplaceRegistrationSource = LocalMarketplaceSource | GitMarketplaceSource;

export interface RegistrationInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export type TargetInspectionStatus =
  | 'ready'
  | 'missing-cli'
  | 'manual-required'
  | 'failed'
  | 'interrupted';

export interface TargetInspection {
  readonly id: AgentTargetId;
  readonly label: string;
  readonly status: TargetInspectionStatus;
  readonly message: string;
  readonly recovery: string;
  readonly invocation?: RegistrationInvocation;
  readonly settingsPath?: string;
}

export type TargetRegistrationStatus =
  | 'completed'
  | 'missing-cli'
  | 'manual-required'
  | 'failed'
  | 'interrupted';

export interface TargetRegistrationResult {
  readonly id: AgentTargetId;
  readonly label: string;
  readonly status: TargetRegistrationStatus;
  readonly message: string;
  readonly recovery?: string;
  readonly invocation?: RegistrationInvocation;
}

export interface MarketplaceRegistrationInspection {
  readonly source: MarketplaceRegistrationSource;
  readonly targets: readonly TargetInspection[];
}

export interface MarketplaceRegistrationReport {
  readonly source: MarketplaceRegistrationSource;
  readonly results: readonly TargetRegistrationResult[];
  readonly exitCode: 0 | 1 | 2 | 130;
}

export function isAgentTargetId(value: string): value is AgentTargetId {
  return (AGENT_TARGET_IDS as readonly string[]).includes(value);
}
