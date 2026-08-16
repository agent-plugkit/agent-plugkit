import yaml from 'js-yaml';
import type {
  PluginComponents,
  PluginHook,
  PluginLsp,
  PluginMcp,
  PluginSkill,
  PluginYaml,
} from '../schema/plugin-yaml.js';

export const COMPONENT_TYPES = ['skill', 'mcp', 'lsp', 'hook'] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

const SKILL_TEMPLATE = `---
name: {{SKILL_NAME}}
description: "TODO: 填写 skill 描述"
---

# {{SKILL_NAME}}

## 何时使用

说明什么情况下应使用这个 Skill。

## 要完成什么

说明用户最终会得到什么结果。

## 如何执行

1. 说明第一步。
2. 说明第二步。

## 需要什么输入

列出开始前需要用户提供的信息；不需要时说明“无需额外输入”。
`;

const LSP_SKILL_TEMPLATE = `---
name: {{SKILL_NAME}}
description: "Use semantic language server support for code navigation, references, hover, and diagnostics."
---

# {{SKILL_NAME}}

Use this plugin when the user asks for semantic code lookup in a project handled by this language server.

Platform boundary:
- Claude Code consumes the generated .lsp.json LSP config and can use native language server support.
- Codex receives this skill as strategy guidance only. Use MCP or other semantic tools if this plugin also provides them.
- If no semantic tool is available in Codex, fall back to repository and text-search tools.

Use semantic tools, when available, for:
- Workspace symbols
- Document symbols
- Go to definition
- Find references
- Hover/type information
- Diagnostics

Use text search when the user asks for literal text, comments, generated files, or cross-language repository structure.
`;

export interface PluginScaffoldFile {
  readonly relativePath: string;
  readonly bytes: Buffer;
  readonly mode: number;
}

export function isComponentType(value: string): value is ComponentType {
  return COMPONENT_TYPES.includes(value as ComponentType);
}

export function isPluginName(value: string): boolean {
  return PLUGIN_NAME_PATTERN.test(value);
}

export function skillEntry(
  name: string,
  description = 'TODO: 填写 skill 描述',
  argumentHint?: string,
): PluginSkill {
  return {
    name,
    path: `skills/${name}`,
    description,
    ...(argumentHint ? { 'argument-hint': argumentHint } : {}),
  };
}

function mcpEntry(name: string): PluginMcp {
  return {
    name,
    command: 'npx',
    args: ['-y', `${name}`],
    description: 'TODO: 填写 MCP server 描述',
  };
}

function lspEntry(name: string): PluginLsp {
  return {
    name,
    command: `${name}-language-server`,
    extensionToLanguage: {
      '.example': 'example',
    },
    startupTimeout: 30000,
    maxRestarts: 3,
    diagnostics: true,
  };
}

function hookEntry(name: string): PluginHook {
  return {
    event: 'PreToolUse',
    pattern: 'Write|Edit',
    command: `./hooks/${name}.sh`,
  };
}

export function addedComponentEntry(
  type: ComponentType,
  name: string,
): PluginComponents {
  switch (type) {
    case 'skill':
      return { skills: [skillEntry(name)] };
    case 'mcp':
      return { mcp: [mcpEntry(name)] };
    case 'lsp':
      return { lsp: [lspEntry(name)] };
    case 'hook':
      return { hooks: [hookEntry(name)] };
  }
}

function initialPluginComponents(
  type: ComponentType,
  name: string,
): PluginComponents {
  switch (type) {
    case 'mcp':
      return {
        skills: [skillEntry(name)],
        mcp: [mcpEntry(`${name}-server`)],
      };
    case 'lsp':
      return {
        skills: [skillEntry(name, 'Use semantic language server support')],
        lsp: [lspEntry(name)],
      };
    case 'hook':
      return {
        hooks: [hookEntry(name)],
      };
    case 'skill':
      return {
        skills: [skillEntry(name)],
      };
  }
}

export function createInitialPluginConfig(
  name: string,
  type: ComponentType,
): PluginYaml {
  return {
    name,
    version: '0.1.0',
    description: 'TODO: 填写插件描述',
    author: {
      name: 'Agent Plugkit Maintainers',
    },
    category: 'general',
    tags: [],
    components: initialPluginComponents(type, name),
  };
}

export function dumpPluginYaml(config: PluginYaml): string {
  return yaml.dump(config, {
    noRefs: true,
    lineWidth: 100,
    sortKeys: false,
  });
}

function scaffoldFile(
  relativePath: string,
  contents: string,
  mode = 0o644,
): PluginScaffoldFile {
  return {
    relativePath,
    bytes: Buffer.from(contents, 'utf8'),
    mode,
  };
}

export function createInitialComponentScaffold(
  type: ComponentType,
  name: string,
): readonly PluginScaffoldFile[] {
  if (type === 'skill' || type === 'mcp') {
    return [
      scaffoldFile(
        `skills/${name}/SKILL.md`,
        SKILL_TEMPLATE.replaceAll('{{SKILL_NAME}}', name),
      ),
    ];
  }
  if (type === 'lsp') {
    return [
      scaffoldFile(
        `skills/${name}/SKILL.md`,
        LSP_SKILL_TEMPLATE.replaceAll('{{SKILL_NAME}}', name),
      ),
    ];
  }
  return [
    scaffoldFile(
      `hooks/${name}.sh`,
      '#!/bin/bash\n# TODO: 实现 hook 逻辑\nexit 0\n',
      0o755,
    ),
  ];
}

export function createAddedComponentScaffold(
  type: ComponentType,
  name: string,
): readonly PluginScaffoldFile[] {
  if (type === 'skill') {
    return [
      scaffoldFile(
        `skills/${name}/SKILL.md`,
        SKILL_TEMPLATE.replaceAll('{{SKILL_NAME}}', name),
      ),
    ];
  }
  if (type === 'hook') {
    return [
      scaffoldFile(
        `hooks/${name}.sh`,
        '#!/bin/bash\n# TODO: 实现 hook 逻辑\nexit 0\n',
        0o755,
      ),
    ];
  }
  return [];
}

export function createPluginScaffold(
  name: string,
  type: ComponentType,
): readonly PluginScaffoldFile[] {
  return [
    scaffoldFile(
      'plugin.yaml',
      dumpPluginYaml(createInitialPluginConfig(name, type)),
    ),
    ...createInitialComponentScaffold(type, name),
  ];
}
