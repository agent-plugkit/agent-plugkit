#!/usr/bin/env tsx
/// <reference types="node" />

/**
 * prebuild 脚本 — 从 CLI 自有资源读取 plugkit 内容并生成 TypeScript 常量文件
 *
 * 运行时机：npm run build 的 prebuild 阶段
 * 输入：
 * - resources/plugkit/plugin.yaml
 * - resources/plugkit/skills/setup/SKILL.md
 * - resources/plugkit/skills/maintain/SKILL.md
 * 输出：packages/cli/src/generated/skill-content.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..');
const resourceRoot = join(cliRoot, 'resources', 'plugkit');

const PLUGKIT_PLUGIN_SOURCE = join(resourceRoot, 'plugin.yaml');

const SETUP_SOURCE = join(resourceRoot, 'skills', 'setup', 'SKILL.md');

const MAINTAIN_SOURCE = join(resourceRoot, 'skills', 'maintain', 'SKILL.md');

const OUTPUT_DIR = join(cliRoot, 'src', 'generated');
const OUTPUT_FILE = join(OUTPUT_DIR, 'skill-content.ts');

for (const source of [PLUGKIT_PLUGIN_SOURCE, SETUP_SOURCE, MAINTAIN_SOURCE]) {
  if (!existsSync(source)) {
    console.error(`✗ 源文件不存在: ${source}`);
    process.exit(1);
  }
}

const pluginYaml = readFileSync(PLUGKIT_PLUGIN_SOURCE, 'utf-8');
const setupSkillContent = readFileSync(SETUP_SOURCE, 'utf-8');
const maintainSkillContent = readFileSync(MAINTAIN_SOURCE, 'utf-8');

if (!pluginYaml.trim() || !setupSkillContent.trim() || !maintainSkillContent.trim()) {
  console.error('✗ plugkit 官方插件源文件不能为空');
  process.exit(1);
}

// 使用 JSON.stringify 安全转义，避免模板字面量中的特殊字符问题
const tsContent = `// 此文件由 scripts/generate-skill.ts 自动生成，请勿手动编辑
// 源头:
// - resources/plugkit/plugin.yaml
// - resources/plugkit/skills/setup/SKILL.md
// - resources/plugkit/skills/maintain/SKILL.md

export const PLUGKIT_PLUGIN_YAML: string = ${JSON.stringify(pluginYaml)};
export const PLUGKIT_SETUP_SKILL: string = ${JSON.stringify(setupSkillContent)};
export const PLUGKIT_MAINTAIN_SKILL: string = ${JSON.stringify(maintainSkillContent)};
`;

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(OUTPUT_FILE, tsContent);

console.log(`✓ 已生成 ${OUTPUT_FILE}`);
