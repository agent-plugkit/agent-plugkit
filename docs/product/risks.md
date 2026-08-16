# 风险与待确认

状态：active（2026-08-16 更新）

## 长期风险

- **协议与平台格式演进**：Agent Plugins、GitHub Copilot/VS Code、Cursor、Claude Code 与 Codex 的 manifest/index 格式可能继续变化。缓解：固定 portable 协议版本、以 adapter 边界隔离客户端细节、vendor 当前协议 schema，并以官方文档和 marketplace fixture 作为生成契约证据；格式变化时同步 adapter、fixture 与公开文档。
- **过早承诺 library API**：公开 Node library API 会显著扩大 semver 维护负担。缓解：当前公开接口只有 CLI、配置 schema 和生成物契约。
- **为假设需求制造浅抽象**：没有真实消费者的预留边界会增加维护成本。缓解：只保留当前 CLI 与生成事务实际消费的模块。
- **公开树污染**：内部计划、执行报告、候选取证或本机环境信息会误导贡献者并扩大暴露面。缓解：长期事实蒸馏进正式文档，临时过程留在任务系统，并由 `npm run check:public` 阻止已知污染形态。
- **单一维护者节奏**：开源初期由个人维护，响应 issue 和平台跟进的带宽有限。缓解：CI 与 fixture 自动化尽量前置，把回归成本压到最低。
