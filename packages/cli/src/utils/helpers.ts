/**
 * 共享工具函数
 *
 * 提供 plugin.yaml 加载、校验、路径解析等通用能力。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PluginYaml } from '../schema/plugin-yaml.js';
import { parsePluginYamlSource } from '../application/plugin-source.js';
import {
  readMarketplaceMetadata,
  type MarketplaceMetadata,
} from '../application/marketplace.js';

export type { MarketplaceMetadata } from '../application/marketplace.js';

export interface PluginRepoContext {
  rootDir: string;
  pluginsDir: string;
  marketplaceYamlPath: string;
  distDir: string;
}

export function resolveInvocationPath(pathArg: string): string {
  return resolve(process.env.INIT_CWD || process.cwd(), pathArg);
}

export function findMarketplaceRoot(startDir = process.cwd()): string | undefined {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, 'marketplace.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function resolveRepoContext(
  rootArg?: string,
  options: { allowMissingMarketplace?: boolean } = {},
): PluginRepoContext {
  const rootDir = rootArg ? resolveInvocationPath(rootArg) : findMarketplaceRoot();

  if (!rootDir) {
    throw new Error(
      'marketplace.yaml not found. Run `agent-plugkit init-repo` first or pass `--root <dir>`.',
    );
  }

  const marketplaceYamlPath = join(rootDir, 'marketplace.yaml');
  if (!options.allowMissingMarketplace && !existsSync(marketplaceYamlPath)) {
    throw new Error(
      `marketplace.yaml not found: ${marketplaceYamlPath}. Run \`agent-plugkit --root ${rootDir} init-repo\` first.`,
    );
  }

  return {
    rootDir,
    pluginsDir: join(rootDir, 'plugins'),
    marketplaceYamlPath,
    distDir: join(rootDir, 'dist'),
  };
}

/**
 * 加载并校验一个 plugin.yaml
 */
export function loadPluginYaml(pluginDir: string): PluginYaml {
  const yamlPath = join(pluginDir, 'plugin.yaml');

  if (!existsSync(yamlPath)) {
    throw new Error(`plugin.yaml not found: ${yamlPath}`);
  }

  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = parsePluginYamlSource(raw);
  if (parsed.status !== 'valid') {
    throw new Error(parsed.message);
  }
  return parsed.value;
}

/**
 * 加载 marketplace.yaml。该文件是所有客户端 marketplace index 的元数据来源。
 */
export function loadMarketplaceMetadata(context: PluginRepoContext): MarketplaceMetadata {
  return readMarketplaceMetadata(context.rootDir);
}

/**
 * 获取所有插件目录名
 */
export function listPluginNames(context: PluginRepoContext): string[] {
  if (!existsSync(context.pluginsDir)) {
    return [];
  }

  return readdirSync(context.pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(context.pluginsDir, d.name, 'plugin.yaml')))
    .map((d) => d.name);
}

/**
 * 加载所有插件
 */
export function loadAllPlugins(
  context: PluginRepoContext,
): Array<{ name: string; dir: string; config: PluginYaml }> {
  return listPluginNames(context).map((name) => {
    const dir = join(context.pluginsDir, name);
    return { name, dir, config: loadPluginYaml(dir) };
  });
}

/**
 * 将 kebab-case 名称转为 Title Case
 * 例如 "plugkit-maintain" → "Plugkit Maintain"
 */
export function toTitleCase(kebab: string): string {
  return kebab
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
