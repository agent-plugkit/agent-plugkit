/**
 * Codex 适配器
 *
 * 从 plugin.yaml 生成 .codex-plugin/plugin.json 和 marketplace.json 条目。
 *
 * Codex 插件结构约定：
 * - .codex-plugin/plugin.json — manifest（比 Claude Code 多 interface 字段）
 * - skills/ — skill 文件（同上，无需生成）
 * - .mcp.json — MCP 配置（格式与 Claude Code 相同）
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginYaml } from '../schema/plugin-yaml.js';
import { toTitleCase } from '../utils/helpers.js';
import { buildNativeMcpConfig } from './mcp.js';

export interface CodexManifest {
  name: string;
  version: string;
  description: string;
  author: {
    name: string;
    email?: string;
    url?: string;
  };
  interface: {
    displayName: string;
    shortDescription: string;
    longDescription: string;
    category: string;
    developerName: string;
    capabilities: string[];
    defaultPrompt: string[];
  };
  skills?: string;
  mcpServers?: string;
}

export interface CodexMarketplaceEntry {
  name: string;
  source: { source: 'local'; path: string };
  interface: { displayName: string };
  policy: {
    installation: 'AVAILABLE';
    authentication: 'ON_INSTALL';
  };
  category: string;
}

/**
 * 生成 Codex 的 .codex-plugin/plugin.json
 *
 * 如果 plugin.yaml 中没有显式指定 platform.codex.interface，
 * 则从 name 和 description 自动推导。
 */
export function buildCodexManifest(config: PluginYaml): CodexManifest {
  const iface = config.platform?.codex?.interface;
  const displayName = iface?.displayName || toTitleCase(config.name);

  const manifest: CodexManifest = {
    name: config.name,
    version: config.version,
    description: config.description,
    author: {
      name: config.author.name,
      ...(config.author.email ? { email: config.author.email } : {}),
      ...(config.author.url ? { url: config.author.url } : {}),
    },
    interface: {
      displayName,
      shortDescription: iface?.shortDescription || config.description,
      longDescription: iface?.longDescription || config.description,
      category: iface?.category || config.category || 'General',
      developerName: iface?.developerName || config.author.name,
      capabilities: iface?.capabilities ?? [],
      defaultPrompt: iface?.defaultPrompt ?? [`Help me use ${displayName}.`],
    },
  };

  // skills 引用
  const skills = config.components.skills;
  if (skills && skills.length > 0) {
    manifest.skills = './skills/';
  }

  // MCP 引用
  const mcps = config.components.mcp;
  if (mcps && mcps.length > 0) {
    manifest.mcpServers = './.mcp.json';
  }

  return manifest;
}

/**
 * 生成 marketplace.json 中的一个条目
 */
export function buildMarketplaceEntry(
  config: PluginYaml,
  relativePath: string,
): CodexMarketplaceEntry {
  const iface = config.platform?.codex?.interface;

  return {
    name: config.name,
    source: { source: 'local', path: relativePath },
    interface: {
      displayName: iface?.displayName || toTitleCase(config.name),
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: iface?.category || config.category || 'General',
  };
}

/**
 * 将 Codex 兼容的文件写入插件目录
 */
export function generateCodex(config: PluginYaml, pluginDir: string): void {
  // .codex-plugin/plugin.json
  const codexDir = join(pluginDir, '.codex-plugin');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, 'plugin.json'),
    JSON.stringify(buildCodexManifest(config), null, 2) + '\n',
  );

  // .mcp.json（Codex 的 MCP 格式与 Claude Code 相同）
  const mcpPath = join(pluginDir, '.mcp.json');
  const mcpConfig = buildNativeMcpConfig(config);
  if (mcpConfig) {
    writeFileSync(
      mcpPath,
      JSON.stringify(mcpConfig, null, 2) + '\n',
    );
  } else {
    rmSync(mcpPath, { force: true });
  }
}
