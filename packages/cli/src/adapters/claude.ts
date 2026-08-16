/**
 * Claude Code 适配器
 *
 * 从 plugin.yaml 生成 .claude-plugin/plugin.json 和相关配置文件。
 *
 * Claude Code 插件结构约定：
 * - .claude-plugin/plugin.json — manifest
 * - skills/<name>/SKILL.md — skill 文件（已在源码中维护，无需生成）
 * - hooks/hooks.json — hook 配置（如果有 hooks 组件）
 * - .mcp.json — MCP server 配置（如果有 mcp 组件）
 * - .lsp.json — LSP server 配置（如果有 lsp 组件）
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginLspTransport, PluginYaml } from '../schema/plugin-yaml.js';
import {
  buildNativeMcpConfig,
  type NativeMcpConfig,
} from './mcp.js';

export interface ClaudeManifest {
  name: string;
  version: string;
  description: string;
  author: { name: string };
}

export interface ClaudeHooksConfig {
  hooks: Record<
    string,
    Array<{
      matcher: string;
      hooks: Array<{
        type: 'command';
        command: string;
        timeout?: number;
      }>;
    }>
  >;
}

export type ClaudeMcpConfig = NativeMcpConfig;

export type ClaudeLspConfig = Record<
  string,
  {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    transport?: PluginLspTransport;
    extensionToLanguage: Record<string, string>;
    workspaceFolder?: string;
    startupTimeout?: number;
    maxRestarts?: number;
    diagnostics?: boolean;
  }
>;

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}

/**
 * 生成 Claude Code 的 .claude-plugin/plugin.json
 */
export function buildClaudeManifest(config: PluginYaml): ClaudeManifest {
  return {
    name: config.name,
    version: config.version,
    description: config.description,
    author: { name: config.author.name },
  };
}

/**
 * 生成 Claude Code 的 hooks/hooks.json（如果有 hooks 组件）
 */
export function buildClaudeHooksConfig(config: PluginYaml): ClaudeHooksConfig | null {
  const hooks = config.components.hooks;
  if (!hooks || hooks.length === 0) return null;

  const hooksMap: ClaudeHooksConfig['hooks'] = {};

  for (const hook of hooks) {
    const entry = {
      matcher: hook.pattern || '*',
      hooks: [
        {
          type: 'command' as const,
          command: hook.command,
          ...(hook.timeout ? { timeout: hook.timeout } : {}),
        },
      ],
    };

    if (!hooksMap[hook.event]) {
      hooksMap[hook.event] = [];
    }
    hooksMap[hook.event].push(entry);
  }

  return { hooks: hooksMap };
}

/**
 * 生成 Claude Code 的 .mcp.json（如果有 mcp 组件）
 */
export function buildClaudeMcpConfig(config: PluginYaml): ClaudeMcpConfig | null {
  return buildNativeMcpConfig(config);
}

/**
 * 生成 Claude Code 的 .lsp.json（如果有 lsp 组件）
 */
export function buildLspConfig(config: PluginYaml): ClaudeLspConfig | null {
  const lsps = config.components.lsp;
  if (!lsps || lsps.length === 0) return null;

  const servers: ClaudeLspConfig = {};

  for (const lsp of lsps) {
    servers[lsp.name] = {
      command: lsp.command,
      ...(isPresent(lsp.args) ? { args: lsp.args } : {}),
      ...(isPresent(lsp.env) ? { env: lsp.env } : {}),
      ...(isPresent(lsp.transport) ? { transport: lsp.transport } : {}),
      extensionToLanguage: lsp.extensionToLanguage,
      ...(isPresent(lsp.workspaceFolder) ? { workspaceFolder: lsp.workspaceFolder } : {}),
      ...(isPresent(lsp.startupTimeout) ? { startupTimeout: lsp.startupTimeout } : {}),
      ...(isPresent(lsp.maxRestarts) ? { maxRestarts: lsp.maxRestarts } : {}),
      ...(isPresent(lsp.diagnostics) ? { diagnostics: lsp.diagnostics } : {}),
    };
  }

  return servers;
}

/**
 * 将 Claude Code 兼容的文件写入插件目录
 */
export function generateClaude(config: PluginYaml, pluginDir: string): void {
  // 1. .claude-plugin/plugin.json
  const claudeDir = join(pluginDir, '.claude-plugin');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, 'plugin.json'),
    JSON.stringify(buildClaudeManifest(config), null, 2) + '\n',
  );

  // 2. hooks/hooks.json
  const hooksConfig = buildClaudeHooksConfig(config);
  const hooksPath = join(pluginDir, 'hooks', 'hooks.json');
  if (hooksConfig) {
    const hooksDir = join(pluginDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify(hooksConfig, null, 2) + '\n',
    );
  } else {
    rmSync(hooksPath, { force: true });
  }

  // 3. .mcp.json
  const mcpConfig = buildClaudeMcpConfig(config);
  const mcpPath = join(pluginDir, '.mcp.json');
  if (mcpConfig) {
    writeFileSync(
      mcpPath,
      JSON.stringify(mcpConfig, null, 2) + '\n',
    );
  } else {
    rmSync(mcpPath, { force: true });
  }

  // 4. .lsp.json
  const lspConfig = buildLspConfig(config);
  const lspPath = join(pluginDir, '.lsp.json');
  if (lspConfig) {
    writeFileSync(
      lspPath,
      JSON.stringify(lspConfig, null, 2) + '\n',
    );
  } else {
    rmSync(lspPath, { force: true });
  }
}
