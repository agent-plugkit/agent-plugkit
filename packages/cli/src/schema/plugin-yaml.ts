/**
 * plugin.yaml JSON Schema 定义
 *
 * 这是 marketplace 的核心数据模型。所有 plugin.yaml 都必须符合此 schema。
 * 生成 Agent Plugins portable 与平台原生产物时，也基于此 schema 做字段映射。
 */

import type { JSONSchemaType } from 'ajv';

// ── 类型定义 ──────────────────────────────────────────────

export interface PluginSkill {
  name: string;
  path: string;
  description?: string;
  'argument-hint'?: string;
}

interface PluginMcpBase {
  name: string;
  description?: string;
}

export interface PluginMcpStdio extends PluginMcpBase {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface PluginMcpRemote extends PluginMcpBase {
  type: 'streamable-http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type PluginMcp = PluginMcpStdio | PluginMcpRemote;

export type PluginLspTransport = 'stdio' | 'socket';

export interface PluginLsp {
  name: string;
  command: string;
  args?: string[] | null;
  env?: Record<string, string> | null;
  transport?: PluginLspTransport | null;
  extensionToLanguage: Record<string, string>;
  workspaceFolder?: string | null;
  startupTimeout?: number | null;
  maxRestarts?: number | null;
  diagnostics?: boolean | null;
}

export interface PluginHook {
  event: string;
  pattern?: string;
  command: string;
  timeout?: number;
}

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface CodexInterface {
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  category?: string;
  developerName?: string;
  capabilities?: string[];
  defaultPrompt?: string[];
}

export interface PlatformOverrides {
  codex?: {
    interface?: CodexInterface;
  };
}

export interface PluginComponents {
  skills?: PluginSkill[];
  mcp?: PluginMcp[];
  lsp?: PluginLsp[];
  hooks?: PluginHook[];
}

export interface PluginYaml {
  name: string;
  version: string;
  description: string;
  author: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  category?: string;
  tags?: string[];
  components: PluginComponents;
  platform?: PlatformOverrides;
}

// ── JSON Schema ──────────────────────────────────────────

export const pluginYamlSchema: JSONSchemaType<PluginYaml> = {
  type: 'object',
  required: ['name', 'version', 'description', 'author', 'components'],
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      pattern: '^(?!.*--)[a-z0-9][a-z0-9-]*[a-z0-9]$',
      minLength: 2,
      maxLength: 64,
    },
    version: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+',
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
    },
    author: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        email: { type: 'string', nullable: true },
        url: { type: 'string', nullable: true },
      },
    },
    homepage: {
      type: 'string',
      nullable: true,
    },
    repository: {
      type: 'string',
      nullable: true,
    },
    license: {
      type: 'string',
      nullable: true,
    },
    category: {
      type: 'string',
      nullable: true,
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
    },
    components: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: {
        skills: {
          type: 'array',
          nullable: true,
          items: {
            type: 'object',
            required: ['name', 'path'],
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              description: { type: 'string', nullable: true },
              'argument-hint': { type: 'string', nullable: true },
            },
          },
        },
        mcp: {
          type: 'array',
          nullable: true,
          items: {
            oneOf: [
              {
                type: 'object',
                required: ['name', 'command'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  type: {
                    type: 'string',
                    enum: ['stdio'],
                    nullable: true,
                  },
                  command: { type: 'string' },
                  args: {
                    type: 'array',
                    items: { type: 'string' },
                    nullable: true,
                  },
                  env: {
                    type: 'object',
                    nullable: true,
                    required: [],
                    additionalProperties: { type: 'string' },
                  },
                  cwd: { type: 'string', nullable: true },
                  description: { type: 'string', nullable: true },
                },
              },
              {
                type: 'object',
                required: ['name', 'type', 'url'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  type: {
                    type: 'string',
                    enum: ['streamable-http', 'sse'],
                  },
                  url: { type: 'string' },
                  headers: {
                    type: 'object',
                    nullable: true,
                    required: [],
                    additionalProperties: { type: 'string' },
                  },
                  description: { type: 'string', nullable: true },
                },
              },
            ],
          } as JSONSchemaType<PluginMcp>,
        },
        lsp: {
          type: 'array',
          nullable: true,
          items: {
            type: 'object',
            required: ['name', 'command', 'extensionToLanguage'],
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              command: { type: 'string' },
              args: {
                type: 'array',
                items: { type: 'string' },
                nullable: true,
              },
              env: {
                type: 'object',
                nullable: true,
                required: [],
                additionalProperties: { type: 'string' },
              },
              transport: {
                type: 'string',
                enum: ['stdio', 'socket', null],
                nullable: true,
              },
              extensionToLanguage: {
                type: 'object',
                required: [],
                additionalProperties: { type: 'string' },
              },
              workspaceFolder: { type: 'string', nullable: true },
              startupTimeout: { type: 'number', nullable: true },
              maxRestarts: { type: 'number', nullable: true },
              diagnostics: { type: 'boolean', nullable: true },
            },
          },
        },
        hooks: {
          type: 'array',
          nullable: true,
          items: {
            type: 'object',
            required: ['event', 'command'],
            additionalProperties: false,
            properties: {
              event: { type: 'string' },
              pattern: { type: 'string', nullable: true },
              command: { type: 'string' },
              timeout: { type: 'number', nullable: true },
            },
          },
        },
      },
    },
    platform: {
      type: 'object',
      nullable: true,
      required: [],
      additionalProperties: false,
      properties: {
        codex: {
          type: 'object',
          nullable: true,
          required: [],
          additionalProperties: false,
          properties: {
            interface: {
              type: 'object',
              nullable: true,
              required: [],
              additionalProperties: false,
              properties: {
                displayName: { type: 'string', nullable: true },
                shortDescription: { type: 'string', nullable: true },
                longDescription: { type: 'string', nullable: true },
                category: { type: 'string', nullable: true },
                developerName: { type: 'string', nullable: true },
                capabilities: {
                  type: 'array',
                  nullable: true,
                  items: {
                    type: 'string',
                    minLength: 1,
                    pattern: '\\S',
                  },
                },
                defaultPrompt: {
                  type: 'array',
                  nullable: true,
                  minItems: 1,
                  maxItems: 3,
                  items: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128,
                    pattern: '\\S',
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
