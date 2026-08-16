import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildClaudeHooksConfig,
  buildClaudeManifest,
  buildClaudeMcpConfig,
  buildLspConfig,
} from "../adapters/claude.js";
import { buildCodexManifest } from "../adapters/codex.js";
import {
  buildAgentPluginManifest,
  buildAgentPluginMcpConfig,
} from "../adapters/agent-plugins.js";
import {
  buildClaudeMarketplace,
  buildCodexMarketplace,
  buildCursorMarketplace,
  buildGithubCopilotMarketplace,
  buildMarketplaceCatalog,
} from "../adapters/marketplace.js";
import {
  commitAuthorizedArtifactGroup,
  documentRevision,
  type AtomicArtifactGroupCommitDependencies,
  type AtomicArtifactGroupCommitResult,
  type AtomicArtifactMutation,
  type AtomicArtifactExpectation,
} from "../infrastructure/document-commit.js";
import {
  authorizeExistingDirectory,
  resolveAuthorizedPath,
} from "../infrastructure/authorized-path.js";
import {
  loadAllPlugins,
  loadMarketplaceMetadata,
  loadPluginYaml,
  resolveRepoContext,
} from "../utils/helpers.js";

export type ArtifactPlatform =
  | "agent-plugins"
  | "claude-code"
  | "codex"
  | "cursor"
  | "github-copilot"
  | "shared";
export type ArtifactType =
  | "plugin-manifest"
  | "mcp-config"
  | "hook-config"
  | "lsp-config"
  | "marketplace-index"
  | "compatibility-mirror"
  | "catalog";
export type ArtifactFreshness = "missing" | "stale" | "fresh";

export interface WorkspaceArtifactFact {
  readonly id: string;
  readonly source: {
    readonly kind: "plugin" | "marketplace";
    readonly id: string;
    readonly label: string;
  };
  readonly platform: ArtifactPlatform;
  readonly type: ArtifactType;
  readonly relativePath: string;
  readonly freshness: ArtifactFreshness;
}

interface PlannedArtifact {
  readonly source: WorkspaceArtifactFact["source"];
  readonly platform: ArtifactPlatform;
  readonly type: ArtifactType;
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

type PlannedAbsentArtifact = Omit<PlannedArtifact, "bytes">;

export interface PluginBuildPlan {
  readonly kind: "plugin-build";
  readonly workspaceDirectory: string;
  readonly pluginName: string;
  readonly expectations: readonly AtomicArtifactExpectation[];
  readonly mutations: readonly AtomicArtifactMutation[];
  readonly artifacts: readonly PlannedArtifact[];
  readonly absentArtifacts: readonly PlannedAbsentArtifact[];
}

export interface MarketplaceIndexPlan {
  readonly kind: "marketplace-index";
  readonly workspaceDirectory: string;
  readonly pluginCount: number;
  readonly expectations: readonly AtomicArtifactExpectation[];
  readonly mutations: readonly AtomicArtifactMutation[];
  readonly artifacts: readonly PlannedArtifact[];
}

export type ArtifactCommitResult = AtomicArtifactGroupCommitResult;

export type WorkspaceArtifactInventoryResult =
  | {
      readonly status: "inspected";
      readonly overall: ArtifactFreshness;
      readonly artifacts: readonly WorkspaceArtifactFact[];
    }
  | {
      readonly status: "unavailable";
      readonly message: string;
    };

const encoder = new TextEncoder();

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function textBytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function revision(
  workspaceDirectory: string,
  relativePath: string,
): string | "missing" {
  const authorization = authorizeExistingDirectory(workspaceDirectory);
  const path = resolveAuthorizedPath(authorization, relativePath);
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`生成计划目标不是普通文件：${relativePath}`);
  }
  return documentRevision(readFileSync(path));
}

function expectation(
  workspaceDirectory: string,
  relativePath: string,
): AtomicArtifactExpectation {
  return {
    relativePath,
    revision: revision(workspaceDirectory, relativePath),
  };
}

function write(
  relativePath: string,
  bytes: Uint8Array,
): AtomicArtifactMutation {
  return { relativePath, action: "write", bytes, mode: 0o644 };
}

function remove(relativePath: string): AtomicArtifactMutation {
  return { relativePath, action: "delete" };
}

function pluginArtifact(
  pluginName: string,
  relativePath: string,
  bytes: Uint8Array,
  platform: ArtifactPlatform,
  type: ArtifactType,
): PlannedArtifact {
  return {
    ...pluginArtifactIdentity(
      pluginName,
      relativePath,
      platform,
      type,
    ),
    bytes,
  };
}

function pluginArtifactIdentity(
  pluginName: string,
  relativePath: string,
  platform: ArtifactPlatform,
  type: ArtifactType,
): PlannedAbsentArtifact {
  return {
    source: {
      kind: "plugin",
      id: `plugin:${pluginName}`,
      label: pluginName,
    },
    platform,
    type,
    relativePath,
  };
}

export function planPluginBuild(
  workspaceDirectory: string,
  pluginName: string,
): PluginBuildPlan {
  const context = resolveRepoContext(workspaceDirectory);
  const pluginDirectory = join(context.pluginsDir, pluginName);
  const config = loadPluginYaml(pluginDirectory);
  const prefix = `plugins/${pluginName}`;
  const claudeManifestPath = `${prefix}/.claude-plugin/plugin.json`;
  const hookPath = `${prefix}/hooks/hooks.json`;
  const mcpPath = `${prefix}/.mcp.json`;
  const lspPath = `${prefix}/.lsp.json`;
  const codexManifestPath = `${prefix}/.codex-plugin/plugin.json`;
  const agentPluginManifestPath = `${prefix}/plugin.json`;
  const agentPluginMcpPath = `${prefix}/mcp.json`;
  const claudeManifest = jsonBytes(buildClaudeManifest(config));
  const codexManifest = jsonBytes(buildCodexManifest(config));
  const agentPluginManifest = jsonBytes(buildAgentPluginManifest(config));
  const hooks = buildClaudeHooksConfig(config);
  const mcp = buildClaudeMcpConfig(config);
  const agentPluginMcp = buildAgentPluginMcpConfig(config);
  const lsp = buildLspConfig(config);
  const mutations: AtomicArtifactMutation[] = [
    write(agentPluginManifestPath, agentPluginManifest),
    agentPluginMcp === null
      ? remove(agentPluginMcpPath)
      : write(agentPluginMcpPath, jsonBytes(agentPluginMcp)),
    write(claudeManifestPath, claudeManifest),
    hooks === null ? remove(hookPath) : write(hookPath, jsonBytes(hooks)),
    mcp === null ? remove(mcpPath) : write(mcpPath, jsonBytes(mcp)),
    lsp === null ? remove(lspPath) : write(lspPath, jsonBytes(lsp)),
    write(codexManifestPath, codexManifest),
  ];
  const artifacts: PlannedArtifact[] = [
    pluginArtifact(
      pluginName,
      agentPluginManifestPath,
      agentPluginManifest,
      "agent-plugins",
      "plugin-manifest",
    ),
    ...(agentPluginMcp === null
      ? []
      : [
          pluginArtifact(
            pluginName,
            agentPluginMcpPath,
            jsonBytes(agentPluginMcp),
            "agent-plugins",
            "mcp-config",
          ),
        ]),
    pluginArtifact(
      pluginName,
      claudeManifestPath,
      claudeManifest,
      "claude-code",
      "plugin-manifest",
    ),
    ...(hooks === null
      ? []
      : [
          pluginArtifact(
            pluginName,
            hookPath,
            jsonBytes(hooks),
            "claude-code",
            "hook-config",
          ),
        ]),
    ...(mcp === null
      ? []
      : [
          pluginArtifact(
            pluginName,
            mcpPath,
            jsonBytes(mcp),
            "shared",
            "mcp-config",
          ),
        ]),
    ...(lsp === null
      ? []
      : [
          pluginArtifact(
            pluginName,
            lspPath,
            jsonBytes(lsp),
            "claude-code",
            "lsp-config",
          ),
        ]),
    pluginArtifact(
      pluginName,
      codexManifestPath,
      codexManifest,
      "codex",
      "plugin-manifest",
    ),
  ];
  const absentArtifacts: PlannedAbsentArtifact[] = [
    ...(agentPluginMcp === null
      ? [
          pluginArtifactIdentity(
            pluginName,
            agentPluginMcpPath,
            "agent-plugins",
            "mcp-config",
          ),
        ]
      : []),
    ...(hooks === null
      ? [
          pluginArtifactIdentity(
            pluginName,
            hookPath,
            "claude-code",
            "hook-config",
          ),
        ]
      : []),
    ...(mcp === null
      ? [
          pluginArtifactIdentity(
            pluginName,
            mcpPath,
            "shared",
            "mcp-config",
          ),
        ]
      : []),
    ...(lsp === null
      ? [
          pluginArtifactIdentity(
            pluginName,
            lspPath,
            "claude-code",
            "lsp-config",
          ),
        ]
      : []),
  ];
  return {
    kind: "plugin-build",
    workspaceDirectory: context.rootDir,
    pluginName,
    expectations: [
      expectation(context.rootDir, `${prefix}/plugin.yaml`),
      ...mutations.map((item) =>
        expectation(context.rootDir, item.relativePath),
      ),
    ],
    mutations,
    artifacts,
    absentArtifacts,
  };
}

export function commitPluginBuildPlan(
  plan: PluginBuildPlan,
  dependencies: AtomicArtifactGroupCommitDependencies = {},
): ArtifactCommitResult {
  return commitAuthorizedArtifactGroup(
    {
      directory: plan.workspaceDirectory,
      expectations: plan.expectations,
      mutations: plan.mutations,
    },
    dependencies,
  );
}

export function planMarketplaceIndex(
  workspaceDirectory: string,
): MarketplaceIndexPlan {
  const context = resolveRepoContext(workspaceDirectory);
  const plugins = loadAllPlugins(context).map(({ name, config }) => ({
    directoryName: name,
    config,
  }));
  const marketplace = loadMarketplaceMetadata(context);
  if (plugins.length === 0) {
    return {
      kind: "marketplace-index",
      workspaceDirectory: context.rootDir,
      pluginCount: 0,
      expectations: [
        expectation(context.rootDir, "marketplace.yaml"),
      ],
      mutations: [],
      artifacts: [],
    };
  }
  const claudePath = ".claude-plugin/marketplace.json";
  const codexPath = ".agents/plugins/marketplace.json";
  const githubCopilotPath = ".github/plugin/marketplace.json";
  const cursorPath = ".cursor-plugin/marketplace.json";
  const mirrorPath = "marketplace.json";
  const catalogPath = "plugins/CATALOG.md";
  const claude = jsonBytes(buildClaudeMarketplace(marketplace, plugins));
  const codex = jsonBytes(buildCodexMarketplace(marketplace, plugins));
  const githubCopilot = jsonBytes(
    buildGithubCopilotMarketplace(marketplace, plugins),
  );
  const cursor = jsonBytes(buildCursorMarketplace(marketplace, plugins));
  const catalog = textBytes(buildMarketplaceCatalog(plugins));
  const source = {
    kind: "marketplace" as const,
    id: "marketplace",
    label: marketplace.name,
  };
  const artifacts: PlannedArtifact[] = [
    {
      source,
      platform: "claude-code",
      type: "marketplace-index",
      relativePath: claudePath,
      bytes: claude,
    },
    {
      source,
      platform: "codex",
      type: "marketplace-index",
      relativePath: codexPath,
      bytes: codex,
    },
    {
      source,
      platform: "github-copilot",
      type: "marketplace-index",
      relativePath: githubCopilotPath,
      bytes: githubCopilot,
    },
    {
      source,
      platform: "cursor",
      type: "marketplace-index",
      relativePath: cursorPath,
      bytes: cursor,
    },
    {
      source,
      platform: "github-copilot",
      type: "compatibility-mirror",
      relativePath: mirrorPath,
      bytes: githubCopilot,
    },
    {
      source,
      platform: "shared",
      type: "catalog",
      relativePath: catalogPath,
      bytes: catalog,
    },
  ];
  const mutations = artifacts.map((artifact) =>
    write(artifact.relativePath, artifact.bytes),
  );
  return {
    kind: "marketplace-index",
    workspaceDirectory: context.rootDir,
    pluginCount: plugins.length,
    expectations: [
      expectation(context.rootDir, "marketplace.yaml"),
      ...plugins.map((plugin) =>
        expectation(
          context.rootDir,
          `plugins/${plugin.directoryName}/plugin.yaml`,
        ),
      ),
      ...mutations.map((item) =>
        expectation(context.rootDir, item.relativePath),
      ),
    ],
    mutations,
    artifacts,
  };
}

export function commitMarketplaceIndexPlan(
  plan: MarketplaceIndexPlan,
  dependencies: AtomicArtifactGroupCommitDependencies = {},
): ArtifactCommitResult {
  if (plan.pluginCount === 0) {
    return {
      status: "verified",
      changedPaths: [],
      diskChanged: false,
      rolledBack: false,
      cleanupComplete: true,
    };
  }
  return commitAuthorizedArtifactGroup(
    {
      directory: plan.workspaceDirectory,
      expectations: plan.expectations,
      mutations: plan.mutations,
    },
    dependencies,
  );
}

export function artifactIdFor(
  scopeId: string,
  relativePath: string,
): string {
  return createHash("sha256")
    .update(scopeId)
    .update("\0")
    .update(relativePath)
    .digest("hex");
}

function inspectPlanArtifacts(
  workspaceDirectory: string,
  scopeId: string,
  artifacts: readonly PlannedArtifact[],
): WorkspaceArtifactFact[] {
  const authorization = authorizeExistingDirectory(workspaceDirectory);
  return artifacts.map((artifact) => {
    const path = resolveAuthorizedPath(
      authorization,
      artifact.relativePath,
    );
    let freshness: ArtifactFreshness = "missing";
    if (existsSync(path)) {
      const stat = lstatSync(path);
      freshness =
        stat.isFile() &&
        Buffer.from(artifact.bytes).equals(readFileSync(path))
          ? "fresh"
          : "stale";
    }
    return {
      id: artifactIdFor(scopeId, artifact.relativePath),
      source: artifact.source,
      platform: artifact.platform,
      type: artifact.type,
      relativePath: artifact.relativePath,
      freshness,
    };
  });
}

function inspectExpectedAbsentArtifacts(
  workspaceDirectory: string,
  scopeId: string,
  artifacts: readonly PlannedAbsentArtifact[],
): WorkspaceArtifactFact[] {
  const authorization = authorizeExistingDirectory(workspaceDirectory);
  return artifacts.flatMap((artifact) => {
    const path = resolveAuthorizedPath(
      authorization,
      artifact.relativePath,
    );
    if (!existsSync(path)) return [];
    return [
      {
        id: artifactIdFor(scopeId, artifact.relativePath),
        source: artifact.source,
        platform: artifact.platform,
        type: artifact.type,
        relativePath: artifact.relativePath,
        freshness: "stale" as const,
      },
    ];
  });
}

export function inspectWorkspaceArtifacts(
  workspaceDirectory: string,
): WorkspaceArtifactInventoryResult {
  try {
    const context = resolveRepoContext(workspaceDirectory);
    const pluginPlans = loadAllPlugins(context).map(({ name }) =>
      planPluginBuild(context.rootDir, name),
    );
    const indexPlan = planMarketplaceIndex(context.rootDir);
    const artifacts = [
      ...pluginPlans.flatMap((plan) =>
        [
          ...inspectPlanArtifacts(
            context.rootDir,
            `inventory:${plan.pluginName}`,
            plan.artifacts,
          ),
          ...inspectExpectedAbsentArtifacts(
            context.rootDir,
            `inventory:${plan.pluginName}`,
            plan.absentArtifacts,
          ),
        ],
      ),
      ...inspectPlanArtifacts(
        context.rootDir,
        "inventory:marketplace",
        indexPlan.artifacts,
      ),
    ];
    const overall: ArtifactFreshness = artifacts.some(
      (artifact) => artifact.freshness === "stale",
    )
      ? "stale"
      : artifacts.some((artifact) => artifact.freshness === "missing")
        ? "missing"
        : "fresh";
    return { status: "inspected", overall, artifacts };
  } catch (error) {
    return {
      status: "unavailable",
      message:
        error instanceof Error
          ? `无法检查生成物：${error.message}`
          : "无法检查生成物。",
    };
  }
}

export function operationArtifactsFromPlan(
  operationId: string,
  workspaceDirectory: string,
  plan: PluginBuildPlan | MarketplaceIndexPlan,
): WorkspaceArtifactFact[] {
  return inspectPlanArtifacts(
    workspaceDirectory,
    operationId,
    plan.artifacts,
  );
}
