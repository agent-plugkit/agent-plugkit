# 产品需求入口

状态：active（2026-08-16 更新）

## 目标用户

- 想维护私有或公开 AI agent plugin marketplace 的个人、团队或组织。
- 想把 skills、MCP servers、hooks、LSP 配置打包成可安装插件的插件作者。
- 不想手写和同步 Agent Plugins 根 manifest、`.claude-plugin/`、`.codex-plugin/`、MCP/LSP/Hook 配置与多客户端 marketplace index 的维护者。

## 核心痛点

- AI coding agent 插件生态分化为规则同步、Agent Skills 标准、内容型 marketplace、MCP 注册中心和平台原生插件体系，但缺少结构化、可验证、CI 友好的 marketplace 维护工具链。
- 手工维护多平台 manifest 容易漂移：schema 错误、路径越界、权限缺失、生成物与声明不一致都难以在 CI 中被发现。

## 当前替代方案

- 手写或半手写平台原生 manifest（社区内容仓库的主流做法）。
- 模板类项目（GitHub template + Makefile / in-Claude 命令），无声明式抽象、平台覆盖弱。
- 纯验证工具（如已归档的 claudelint），只校验不生成。
- 规则同步器（Ruler、LNAI）与内容市场（wshobson/agents）解决的是相邻但不同的问题。

## 产品承诺

> Build and maintain AI agent plugin marketplaces from one declarative source.

以 `plugin.yaml` 为单一事实来源，提供脚手架、验证、构建、索引与本地发布的完整 CLI 闭环，生成 Agent Plugins 1.0 可移植包、Claude Code / Codex 原生产物以及 Copilot/VS Code、Cursor、Grok Build 等客户端可消费的仓库索引。

## 当前产品阶段

当前路线聚焦两个阶段：

1. **当前阶段**：持续维护 CLI、`plugin.yaml` 单一事实源、Agent Plugins 1.0 portable core，以及 Copilot/VS Code、Cursor、Claude Code、Codex、Grok Build 客户端分发 adapter。
2. **后续扩展**：依据公开且可验证的客户端契约增加 adapter，不把未确认的 Registry 或安装协议预先写进 portable core。

## 非目标

- 不做 Ruler/LNAI 式跨工具规则同步器。
- 不做 wshobson/agents 式内容市场。
- 当前不承诺公开 Node library API；内部分层只按现有 CLI 消费者的真实需要维护，不为假设中的调用方预建浅包装。
- 当前不承诺 Agent Plugins client loader/Registry、完整安全治理、LLM judge 评测或全部 agent 平台适配。

## 成功指标

- 正确性：validate 能发现 schema、Agent Skills、MCP transport、路径越界、权限、LSP 契约和生成物漂移问题；portable、原生与客户端索引均可从声明重新推导。
- 接入成本：新 marketplace 从 `init-repo` 到可安装源可在数分钟内完成。
- 维护成本：schema 或 adapter 变化能用官方示例 marketplace 作为 fixture 验证。
- 采用信号（开源后）：外部仓库以 agent-plugkit 作为维护工具链的数量。

## 风险与待确认

见 [risks.md](risks.md)。
