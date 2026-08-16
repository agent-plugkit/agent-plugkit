# agent-plugkit

`agent-plugkit` is a CLI-first toolkit for building and maintaining AI agent plugin marketplaces.

It lets you keep plugin metadata in one declarative `plugin.yaml`, then generate an [Agent Plugins 1.0](https://agent-plugins.org/specification) portable package, Claude Code and Codex native artifacts, and client marketplace indexes from that source.

## Why

AI coding agent ecosystems now have rules sync tools, Agent Skills, content marketplaces, MCP registries, and platform-native plugin formats. `agent-plugkit` focuses on one narrower job: helping teams operate a structured plugin marketplace repository without hand-editing every platform manifest.

It is not a rules synchronizer like Ruler or LNAI, and it is not a content catalog like wshobson/agents. It is the maintenance toolchain for your own marketplace.

## Install

```bash
npx agent-plugkit --help
```

For a repository that wants a pinned version:

```bash
npm install --save-dev agent-plugkit
```

## Commands

```bash
npx agent-plugkit init-repo [name] --organization "Team Name" [--no-plugkit]
npx agent-plugkit init <plugin-name> --type <skill|mcp|lsp|hook>
npx agent-plugkit add <skill|mcp|lsp|hook> <plugin-name> <component-name>
npx agent-plugkit import-skill <source-dir> [plugin-name] [--description "..."] [--author "..."]
npx agent-plugkit build [plugin-name] --all
npx agent-plugkit index
npx agent-plugkit validate [plugin-name] --all
npx agent-plugkit release-local
npx agent-plugkit install-repo <git-repo|local-path> [--agent <agent>...] [--all]
```

Use `--root <dir>` when running from outside a marketplace repository:

```bash
npx agent-plugkit --root /path/to/marketplace validate --all
```

## Marketplace Shape

```text
.
├── marketplace.yaml
├── plugins/
│   ├── plugkit/
│   │   ├── plugin.yaml
│   │   └── skills/
│   │       ├── setup/
│   │       │   └── SKILL.md
│   │       └── maintain/
│   │           └── SKILL.md
│   └── my-plugin/
│       ├── plugin.yaml
│       ├── plugin.json
│       ├── mcp.json              # only when MCP servers are declared
│       └── skills/
├── .github/plugin/marketplace.json
├── .cursor-plugin/marketplace.json
├── .claude-plugin/marketplace.json
├── .agents/plugins/marketplace.json
└── marketplace.json
```

Each plugin owns a `plugin.yaml`:

```yaml
name: my-plugin
version: "0.1.0"
description: "Describe the plugin"
author:
  name: "Team Name"
category: tooling
tags: []

components:
  skills:
    - name: my-plugin
      path: skills/my-plugin
      description: "Skill description"

platform:
  codex:
    interface:
      displayName: "My Plugin"
      capabilities: ["Interactive", "Write"]
      defaultPrompt:
        - "Help me use My Plugin."
```

The canonical `name` is also the portable package identifier: use 2–64 lowercase letters,
digits, or single hyphens, with an alphanumeric first and last character; consecutive `--` is
rejected before any Agent Plugins manifest is generated.

`platform.codex.interface` is optional. `capabilities` is an array of non-empty strings;
`defaultPrompt` accepts one to three non-empty strings of at most 128 characters each. When these
fields are omitted, the Codex adapter emits `capabilities: []` and a safe
`defaultPrompt: ["Help me use <Display Name>."]` fallback. Optional `author.email` and `author.url`
are omitted from the Codex manifest when they are not declared instead of being written as empty
strings.

Supported components:

- `skills`: Agent Skills instruction directories discovered strictly as `skills/<name>/SKILL.md`; `validate` checks the required frontmatter, directory/name match, and declared/discovered set.
- `mcp`: MCP server metadata. Legacy or explicit `stdio` supports `command`, `args`, `env`, and `cwd`; `streamable-http` and `sse` support `url` and `headers`.
- `hooks`: Claude Code hook configuration. The current Codex ingestion manifest does not accept a `hooks` field, so the Codex adapter deliberately omits it.
- `lsp`: Claude Code LSP configuration. Pair it with a skill when Codex strategy guidance is needed.

Optional portable metadata can be declared as `homepage`, `repository`, and `license` alongside the existing author and tag fields. Transport path, URL, and header safety is validated before delivery; invalid servers are never silently dropped or converted to another transport. MCP `env` and `headers` are visible package data, not portable secret or OAuth mechanisms—do not place credentials in them.

## Agent Plugins and Client Marketplaces

`agent-plugkit build` emits the fixed Agent Plugins 1.0.0 portable contract at each plugin root:

- `plugin.json` with the canonical 1.0.0 schema identifier.
- `skills/<name>/SKILL.md` as the protocol-discovered Skill set.
- `mcp.json` when MCP servers are declared.

Agent Plugins 1.0 standardizes portable Skills and MCP servers. Hooks, LSP configuration, installation sources, registries, and marketplace/update policy remain client-specific. That boundary follows the [Agent Plugins client implementer guidance](https://agent-plugins.org/client-implementers); the client indexes below are distribution adapters, not fields in the portable manifest.

After a repository is available to its intended users, `install-repo` registers its generated
indexes with selected clients:

```bash
npx agent-plugkit install-repo OWNER/REPO
npx agent-plugkit install-repo OWNER/REPO --agent claude --agent codex
npx agent-plugkit install-repo /absolute/path/to/marketplace --all
```

Without `--agent` or `--all`, an interactive terminal shows a numbered multi-select and defaults to
the targets that can currently be handled automatically. Non-interactive callers must pass an
explicit selection. Target IDs are `claude`, `codex`, `copilot`, `vscode`, and `cursor`; repeated
`--agent` values are deduplicated and `--all` includes Cursor.

Client behavior is deliberately adapter-specific:

- Claude Code runs `claude plugin marketplace add <source>` after probing that exact command.
- Codex runs `codex plugin marketplace add <source>` after probing that exact command.
- GitHub Copilot runs `copilot plugin marketplace add <source>` after probing that exact command.
- VS Code atomically updates the current user's JSONC `settings.json`, enables
  `chat.plugins.enabled`, and deduplicates `chat.plugins.marketplaces`. Local directories are stored
  as `file://` URIs. Comments, trailing commas, indentation, unrelated settings, and the existing
  file mode are preserved. Only a safe absolute user configuration root and lossless UTF-8 input
  are accepted. If deduplication cannot retain existing comments, or the file is malformed or
  a revision/guard check detects a concurrent change, registration fails without overwriting it.
  This is a pure Node best-effort transaction rather than filesystem compare-and-swap: an
  uncooperative writer that atomically replaces the path with a new inode after the last observable
  check but before either candidate commit or guard-content recovery rename can still be overwritten.
  Failure output therefore directs users to inspect the current file instead of claiming every
  failure left the original untouched. A local Marketplace cannot contain, equal, or resolve through
  a symlink to the selected VS Code user settings path.
- Cursor remains selectable but returns a manual task: Team/Enterprise administrators use
  Dashboard → Plugins → Add Marketplace → Import from Repo. No private cache, database, or
  undocumented Cursor command is touched.

Accepted sources are an existing local directory, `owner/repo`, an HTTPS Git URL, or an SSH Git
URL. Missing path-like inputs, ambiguous bare values, option-like values, non-HTTPS Web URLs, and
sources containing C0/C1/DEL control characters (including percent-decoded URL controls), dot-only
Git shorthand segments, or embedded URL credentials are rejected before any client action. A local directory must already contain the selected client's generated index;
`install-repo` never builds or repairs it.

Each target is processed in a fixed order and a failure does not stop later targets unless a user or
child-process interrupt occurs. The final text summary uses explicit labels such as `[完成]`,
`[缺少 CLI]`, `[需手动]`, and `[失败]`:

| Exit code | Meaning |
| --- | --- |
| `0` | Every selected target completed registration or VS Code configuration injection |
| `2` | At least one target completed and at least one target is missing, manual, or failed |
| `1` | No target completed, or source/argument preflight failed |
| `130` | The user or a client process interrupted the run |

The generated indexes still support direct client flows when needed:

- GitHub Copilot CLI checks root `marketplace.json` before `.github/plugin/marketplace.json`; `agent-plugkit` emits the same client-compatible bytes at both paths so the legacy root mirror cannot shadow the canonical GitHub index. The Claude path remains a client fallback:

  ```bash
  copilot plugin marketplace add OWNER/REPO
  copilot plugin install PLUGIN_NAME@MARKETPLACE_NAME
  ```

- VS Code can register the same Git marketplace in `settings.json`, then install from the Agent Plugins view or Agent Customizations editor:

  ```json
  {
    "chat.plugins.marketplaces": ["OWNER/REPO"]
  }
  ```

- Cursor Team/Enterprise can use Dashboard → Plugins → Add Marketplace → Import from Repo. Cursor detects the root Agent Plugins `plugin.json` for entries referenced by `.cursor-plugin/marketplace.json`.

`install-repo` performs only current-user Marketplace registration or VS Code configuration. It
does not push or publish a Git repository, build or modify the source, install a missing client CLI,
import into Cursor automatically, or install any plugin from the Marketplace. `release-local` only
creates a checked local directory and tar archive.

## Importing an Existing Skill

`agent-plugkit import-skill <source-dir> [plugin-name]` turns a skill that already exists on disk into a new, single-skill plugin — no template placeholders to fill in by hand.

```bash
npx agent-plugkit import-skill ~/.claude/skills/dataviz
npx agent-plugkit import-skill ~/.claude/skills/dataviz custom-name --description "..." --author "..."
```

- **One skill in, one plugin out.** It always creates a brand-new plugin (`plugins/<name>/`); it does not add a skill to an existing plugin and does not import multiple skills in one call.
- **Two local source shapes are accepted**: a directory containing `SKILL.md` directly, or an existing plugin-shaped directory with a `skills/` subfolder — when that subfolder holds exactly one skill, it is selected automatically. Pointing at a single `SKILL.md` file or a remote git/npm source is not supported.
- **`SKILL.md` is copied byte-for-byte and never rewritten.** `plugin.yaml` metadata (`name`, `description`, `argument-hint`) is derived from the source `SKILL.md` frontmatter, with `[plugin-name]`, `--description`, and `--author` as explicit overrides. Any mismatch between the frontmatter and the derived plugin name is reported as a warning, not silently fixed by editing the source file.
- Like `init` and `add`, it only prints next-step guidance (`build` / `validate`) — it does not run them automatically.

## Generated Artifacts

`agent-plugkit build` writes plugin-level artifacts:

- `plugins/**/plugin.json`
- `plugins/**/mcp.json` (when MCP servers are declared)
- `plugins/**/.claude-plugin/plugin.json`
- `plugins/**/.codex-plugin/plugin.json`
- `plugins/**/.mcp.json`
- `plugins/**/.lsp.json`
- `plugins/**/hooks/hooks.json`

`agent-plugkit index` writes marketplace-level artifacts:

- `.github/plugin/marketplace.json`
- `.cursor-plugin/marketplace.json`
- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`
- `marketplace.json`
- `plugins/CATALOG.md`

Generated files should be regenerated, not edited by hand.

## Recommended Scripts

`agent-plugkit init-repo` writes scripts like these:

```json
{
  "scripts": {
    "mp": "npx agent-plugkit",
    "validate:plugins": "npx agent-plugkit validate --all",
    "build:plugins": "npx agent-plugkit build --all",
    "build:index": "npx agent-plugkit index",
    "build:all": "npm run build:plugins && npm run build:index",
    "ci:local": "npm run build:all && npm run validate:plugins",
    "release:local": "npm run ci:local && npx agent-plugkit release-local"
  }
}
```

## Official Marketplace

Curated plugins and generated client indexes are maintained separately in
[`agent-plugkit/plugkit-marketplace`](https://github.com/agent-plugkit/plugkit-marketplace). This CLI repository does
not contain or build that catalog; its integration tests create isolated temporary marketplaces.

## Development

```bash
npm install
npm run build
npm test
npm run pack:cli
npm run check:public
```

The public contract is the CLI, `marketplace.yaml`, `plugin.yaml`, and generated marketplace artifacts. Internal TypeScript functions are intentionally not documented as a Node library API yet (see [ADR-0001](https://github.com/agent-plugkit/agent-plugkit/blob/main/docs/adr/0001-cli-only-public-contract.md)).

## Project Docs

- [`AGENTS.md`](https://github.com/agent-plugkit/agent-plugkit/blob/main/AGENTS.md) — repository rules, architecture boundaries, and definition of done.
- [`docs/architecture/overview.md`](https://github.com/agent-plugkit/agent-plugkit/blob/main/docs/architecture/overview.md) — layering, invariants, and known debt.
- [`docs/product/`](https://github.com/agent-plugkit/agent-plugkit/tree/main/docs/product) — positioning, roadmap, and risks.
- [`docs/release/`](https://github.com/agent-plugkit/agent-plugkit/tree/main/docs/release) — release plan and gates.
