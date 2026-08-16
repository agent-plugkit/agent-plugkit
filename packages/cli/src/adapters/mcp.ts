import type {
  PluginMcp,
  PluginMcpRemote,
  PluginMcpStdio,
  PluginYaml,
} from '../schema/plugin-yaml.js';

export type NativeMcpServer =
  | {
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: PluginMcpRemote['type'];
      url: string;
      headers?: Record<string, string>;
    };

export interface NativeMcpConfig {
  mcpServers: Record<string, NativeMcpServer>;
}

export function isStdioMcp(mcp: PluginMcp): mcp is PluginMcpStdio {
  return mcp.type === undefined || mcp.type === 'stdio';
}

export function buildNativeMcpConfig(config: PluginYaml): NativeMcpConfig | null {
  const mcps = config.components.mcp;
  if (!mcps || mcps.length === 0) return null;

  const servers: NativeMcpConfig['mcpServers'] = {};
  for (const mcp of mcps) {
    if (isStdioMcp(mcp)) {
      servers[mcp.name] = {
        ...(mcp.type === 'stdio' ? { type: mcp.type } : {}),
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

  return { mcpServers: servers };
}
