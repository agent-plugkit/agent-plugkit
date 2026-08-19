# AGENTS.md

本仓库只维护 `AGENTS.md` 这一份 Agent 规则与项目上下文；`CLAUDE.md` 是指向本文件的同目录软链接，不要复制出第二份内容。

## 产品与边界

本项目帮助：AI agent plugin marketplace 的维护者，以 `plugin.yaml` 单一事实来源生成 Agent Plugins 1.0 可移植包、Claude Code / Codex 原生 manifest、Copilot/VS Code / Cursor / Grok Build 等客户端 marketplace index 和本地发布包，为已就绪来源执行多客户端 Marketplace 注册，并提供脚手架与验证闭环。

非目标：不做规则同步器（Ruler/LNAI 方向）、不做内容型插件市场、第一阶段不公开 Node library API。长期路线见 `docs/product/idea-brief.md`。

## 项目形态与架构

- 项目形态：npm workspaces monorepo，当前唯一产品入口是 TypeScript ESM CLI。
- 根 `package.json` 是 private 编排器；公开 npm 包完整位于 `packages/cli/`。
- CLI 入口层：`packages/cli/src/cli.ts`——commander 与 `process.exit` 只允许出现在这一层。
- 命令编排：`packages/cli/src/commands/`，每个命令一个 `run*` 函数，通过 `CommandError`（`packages/cli/src/core/errors.ts`）抛领域错误。
- 数据模型权威：`packages/cli/src/schema/plugin-yaml.ts`（TypeScript 类型 + Ajv schema 同源维护）。
- 平台适配：`packages/cli/src/adapters/`；新增平台必须走新 adapter，不修改调用方对现有平台的理解。
- 仓库上下文：`packages/cli/src/utils/helpers.ts`（定位 marketplace.yaml、加载配置、枚举插件）。
- `packages/cli/resources/plugkit/` 是 `init-repo` 内置 plugkit 内容的 CLI 权威源；`packages/cli/src/generated/` 由构建脚本生成，不入库、不手改。
- 官方插件市场独立维护在 `agent-plugkit/plugkit-marketplace`；本仓库不得重新引入其内容副本或跨仓库构建依赖。
- 细节、进程边界与质量门见 `docs/architecture/overview.md`。

## 当前交互表面

- 当前唯一产品入口是 CLI；终端呈现的权威规则位于 `docs/design/terminal-interaction.md`。
- 公开仓库只保留当前产品、架构、质量和发布事实；内部计划、执行报告、候选取证与已失效材料不得入库。

## 仓库规则

- 公开契约是 CLI 命令、`marketplace.yaml`/`plugin.yaml` schema 和生成物格式；变更它们先评估兼容性并同步 README 与架构文档（见 ADR-0001）。
- 所有平台生成物必须能从 `plugin.yaml` 重新推导；不要手工编辑根 `plugin.json`/`mcp.json`、平台 JSON 或 CATALOG。
- Agent Plugins 只负责 portable Skills/MCP 包契约；`.github/plugin/marketplace.json`、`.cursor-plugin/marketplace.json` 等安装索引属于客户端分发层，不要把 Registry、Marketplace 或发布状态写入 portable manifest。
- 不要把 chalk/console 输出引入 `packages/cli/src/adapters/`、`schema/`、`utils/`；命令层的输出分离是既定演进方向，不要加重耦合。
- 插件声明中的路径必须经过 `packages/cli/src/infrastructure/authorized-path.ts` 的统一越界防护，不要绕过。
- schema、adapter 和 release 行为由 `packages/cli/scripts/test-cli.ts` 与 `test-package.ts` 的临时 fixture 覆盖，不依赖外部内容仓库。
- `init-repo` 注入内容只能从 `packages/cli/resources/plugkit/` 构建，不另造平行模板。
- 根目录不得重新生成 `marketplace.yaml`、`marketplace.json` 或客户端 marketplace 索引；本仓库整体不再作为可直接注册的远端 marketplace。

## 协作与 Agent 约定

- 多文件或涉及公开契约的修改前先做计划。
- 行为、架构、命令或规则变化后检查文档同步（README、`docs/architecture/` 与 ADR）。
- 临时计划和执行证据留在任务系统；只有长期有效的产品、架构、质量和发布事实进入 `docs/`。

## 常用命令

- 安装：`npm install`
- 构建：`npm run build`（构建 `packages/cli`，含生成内置 skill）
- 本地运行 CLI：`npm run agent-plugkit -- <args>`
- 测试：`npm test`（CLI E2E + CLI npm 包边界回归）
- 发布内容检查：`npm run pack:cli`
- 公开仓库卫生：`npm run check:public`

## 完成定义

- `npm run build` 与 `npm test` 通过。
- 新增或变更的 CLI 行为有对应端到端断言。
- 公开契约（命令、schema、生成物）变化已同步 README 和 `docs/architecture/overview.md`；架构决策变化写入 `docs/adr/`。
- 发布相关变更运行过 `npm run pack:cli` 并审查内容。
- `npm run check:public` 通过，公开树没有内部计划、候选取证、已退役路径、本机路径或凭据形态内容。

## 常见坑与禁止事项

- 不要手动修改 `packages/cli/src/generated/`；它由 CLI 资源构建生成。
- 不要在 `packages/cli/src/cli.ts` 之外调用 `process.exit` 或引入 commander。
- 不要新增生产依赖而不说明原因（当前为 commander、yaml、js-yaml、ajv、chalk、jsonc-parser；`yaml` 的 Document API 用于仓库 YAML 的注释、顺序和锚点保真，`jsonc-parser` 用于 VS Code 用户设置的 JSONC 保真编辑）。
- 不要在未评估兼容性的情况下改动 `plugin.yaml` schema 的既有字段语义。
- 不要为未来 library 或第三平台预先制造浅抽象层（ADR-0001）。
- 不要把关键决策只留在聊天里；长期决策写入 ADR 或对应权威文档，临时过程留在任务系统。
- 不要提交内部规格目录、一次性实施报告、候选 manifest、机器环境清单或个人路径。

## Cursor Cloud specific instructions

- 环境 `install` 会安装 Grok Build CLI（`curl -fsSL https://x.ai/cli/install.sh | bash`）；二进制在 `$HOME/.grok/bin/grok`。非登录 shell 需确保该目录在 `PATH` 中。
- 验证 Grok 注册时，在临时目录运行 `init-repo` / `build` / `index`，再执行 `install-repo <绝对路径> --agent grok`；不要在本仓库根目录执行 `init-repo`（会污染 monorepo 根）。
- `packages/cli/scripts/test-install-repo.ts` 在检测到 `grok` 可用时会跑真实 CLI smoke；缺 CLI 时自动跳过。
