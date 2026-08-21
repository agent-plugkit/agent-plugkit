import type { PluginYaml } from "../schema/plugin-yaml.js";
import type { MarketplaceMetadata } from "../application/marketplace.js";
import { toTitleCase } from "../utils/helpers.js";
import { buildMarketplaceEntry } from "./codex.js";

export interface MarketplacePluginSource {
  readonly directoryName: string;
  readonly config: PluginYaml;
}

function buildPortableClientMarketplace(
  marketplace: MarketplaceMetadata,
  plugins: readonly MarketplacePluginSource[],
): unknown {
  const displayName = toTitleCase(marketplace.name);
  return {
    name: marketplace.name,
    owner: {
      name: marketplace.organization || displayName,
    },
    ...(marketplace.description === undefined
      ? {}
      : { metadata: { description: marketplace.description } }),
    plugins: plugins.map(({ directoryName, config }) => ({
      name: config.name,
      source: `./plugins/${directoryName}`,
      description: config.description,
      version: config.version,
      author: {
        name: config.author.name,
        ...(typeof config.author.email === "string"
          ? { email: config.author.email }
          : {}),
        ...(typeof config.author.url === "string"
          ? { url: config.author.url }
          : {}),
      },
    })),
  };
}

export function buildGithubCopilotMarketplace(
  marketplace: MarketplaceMetadata,
  plugins: readonly MarketplacePluginSource[],
): unknown {
  return buildPortableClientMarketplace(marketplace, plugins);
}

export function buildCursorMarketplace(
  marketplace: MarketplaceMetadata,
  plugins: readonly MarketplacePluginSource[],
): unknown {
  return buildPortableClientMarketplace(marketplace, plugins);
}

export function buildClaudeMarketplace(
  marketplace: MarketplaceMetadata,
  plugins: readonly MarketplacePluginSource[],
): unknown {
  const displayName = toTitleCase(marketplace.name);
  return {
    name: marketplace.name,
    owner: {
      name: marketplace.organization || displayName,
    },
    ...(marketplace.description === undefined
      ? {}
      : { description: marketplace.description }),
    plugins: plugins.map(({ directoryName, config }) => ({
      name: config.name,
      source: `./plugins/${directoryName}`,
      description: config.description,
      version: config.version,
      author: {
        name: config.author.name,
        ...(typeof config.author.email === "string"
          ? { email: config.author.email }
          : {}),
      },
      ...(config.category === undefined ? {} : { category: config.category }),
      ...(config.tags?.length ? { tags: config.tags } : {}),
      ...(config.components.lsp?.length
        ? { lspServers: "./.lsp.json" }
        : {}),
    })),
  };
}

export function buildCodexMarketplace(
  marketplace: MarketplaceMetadata,
  plugins: readonly MarketplacePluginSource[],
): unknown {
  return {
    name: marketplace.name,
    interface: {
      displayName: toTitleCase(marketplace.name),
    },
    plugins: plugins.map(({ directoryName, config }) =>
      buildMarketplaceEntry(config, `./plugins/${directoryName}`),
    ),
  };
}

/**
 * Grok Build marketplace index (`.grok-plugin/marketplace.json`).
 * Local sources use `{ type: "local", path }` per xAI plugin-marketplace catalog format.
 */
export function buildGrokMarketplace(
  marketplace: MarketplaceMetadata,
  plugins: readonly MarketplacePluginSource[],
): unknown {
  const displayName = toTitleCase(marketplace.name);
  return {
    name: marketplace.name,
    ...(marketplace.description === undefined
      ? {}
      : { description: marketplace.description }),
    owner: {
      name: marketplace.organization || displayName,
    },
    plugins: plugins.map(({ directoryName, config }) => ({
      name: config.name,
      source: {
        type: 'local',
        path: `./plugins/${directoryName}`,
      },
      description: config.description,
      version: config.version,
      author: {
        name: config.author.name,
        ...(typeof config.author.email === 'string'
          ? { email: config.author.email }
          : {}),
        ...(typeof config.author.url === 'string'
          ? { url: config.author.url }
          : {}),
      },
      ...(config.category === undefined ? {} : { category: config.category }),
      ...(config.tags?.length ? { tags: config.tags, keywords: config.tags } : {}),
      ...(typeof config.homepage === 'string'
        ? { homepage: config.homepage }
        : {}),
    })),
  };
}

function componentLabels(config: PluginYaml): string[] {
  const labels: string[] = [];
  if (config.components.skills?.length) labels.push("Skill");
  if (config.components.mcp?.length) labels.push("MCP");
  if (config.components.lsp?.length) labels.push("LSP");
  if (config.components.hooks?.length) labels.push("Hook");
  return labels;
}

export function buildMarketplaceCatalog(
  plugins: readonly MarketplacePluginSource[],
): string {
  const rows = plugins
    .map(({ directoryName, config }) => {
      const labels = componentLabels(config);
      const suffix = labels.length ? ` [${labels.join(", ")}]` : "";
      return `- **${directoryName}** (v${config.version})${suffix}: ${config.description}`;
    })
    .join("\n");
  return `# 插件目录\n\n${rows}\n\n_由 CLI 自动生成，请勿手动编辑。_\n`;
}
