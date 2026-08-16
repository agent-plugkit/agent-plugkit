import type { PluginYaml } from '../schema/plugin-yaml.js';
import { isStdioMcp } from './mcp.js';

export const AGENT_PLUGINS_VERSION = '1.0.0';
export const AGENT_PLUGIN_SCHEMA_ID =
  `https://agent-plugins.org/schemas/${AGENT_PLUGINS_VERSION}/plugin.schema.json` as const;
export const AGENT_PLUGIN_MCP_SCHEMA_ID =
  `https://agent-plugins.org/schemas/${AGENT_PLUGINS_VERSION}/mcp.schema.json` as const;

export interface AgentPluginManifest {
  $schema: typeof AGENT_PLUGIN_SCHEMA_ID;
  name: string;
  version?: string;
  description?: string;
  author?: {
    name: string;
    email?: string;
    url?: string;
  };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

export interface AgentPluginMcpConfig {
  $schema: typeof AGENT_PLUGIN_MCP_SCHEMA_ID;
  mcpServers: Record<
    string,
    | {
        type: 'stdio';
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
      }
    | {
        type: 'streamable-http' | 'sse';
        url: string;
        headers?: Record<string, string>;
      }
  >;
}

export function buildAgentPluginManifest(config: PluginYaml): AgentPluginManifest {
  return {
    $schema: AGENT_PLUGIN_SCHEMA_ID,
    name: config.name,
    version: config.version,
    description: config.description,
    author: {
      name: config.author.name,
      ...(typeof config.author.email === 'string'
        ? { email: config.author.email }
        : {}),
      ...(typeof config.author.url === 'string'
        ? { url: config.author.url }
        : {}),
    },
    ...(typeof config.homepage === 'string'
      ? { homepage: config.homepage }
      : {}),
    ...(typeof config.repository === 'string'
      ? { repository: config.repository }
      : {}),
    ...(typeof config.license === 'string' ? { license: config.license } : {}),
    ...(config.tags ? { keywords: config.tags } : {}),
  };
}

export function buildAgentPluginMcpConfig(
  config: PluginYaml,
): AgentPluginMcpConfig | null {
  const mcps = config.components.mcp;
  if (!mcps || mcps.length === 0) return null;

  const servers: AgentPluginMcpConfig['mcpServers'] = {};
  for (const mcp of mcps) {
    if (isStdioMcp(mcp)) {
      servers[mcp.name] = {
        type: 'stdio',
        command: mcp.command,
        ...(mcp.args ? { args: mcp.args } : {}),
        ...(mcp.env ? { env: mcp.env } : {}),
        ...(mcp.cwd ? { cwd: mcp.cwd } : {}),
      };
      continue;
    }

    servers[mcp.name] = {
      type: mcp.type,
      url: mcp.url,
      ...(mcp.headers ? { headers: mcp.headers } : {}),
    };
  }

  return {
    $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
    mcpServers: servers,
  };
}
