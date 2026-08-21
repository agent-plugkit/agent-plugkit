# 架构概览

状态：active（2026-08-16 更新，按当前代码事实描述）

## Monorepo 形态

仓库使用 npm workspaces 隔离公开 CLI 包与根编排器：

```text
package.json                 private 根编排器，不发布
packages/cli/                公开 npm 包 agent-plugkit
docs/                         当前产品、架构、质量和发布事实
scripts/                      仓库级公开内容检查
```

- `packages/cli` 拥有 TypeScript 源码、测试、构建脚本、依赖和 npm 发布内容。
- 根包只统一安装、构建、测试、公开内容检查和 pack 命令，不含运行时代码，也因 `private: true` 不可误发布。
- 官方内容仓库独立位于 [`agent-plugkit/plugkit-marketplace`](https://github.com/agent-plugkit/plugkit-marketplace)，不参与本仓库安装或构建。
- 未经当前产品需求证明，不预建新的 workspace 或共享 core 包。

## 公开契约

1. **CLI**：`agent-plugkit init-repo | init | add | import-skill | validate | build | index | release-local | install-repo`。仓库维护命令可使用全局 `--root <dir>`；`install-repo` 直接接收独立来源。
2. **配置 schema**：任意 marketplace root 下的 `marketplace.yaml` 与 `plugins/*/plugin.yaml`；类型与 Ajv schema 在 `packages/cli/src/schema/plugin-yaml.ts` 同源维护。
3. **插件生成物**：Agent Plugins 1.0 根 `plugin.json`、条件性根 `mcp.json`，以及 Claude/Codex/MCP/Hook/LSP 原生文件。
4. **Marketplace 生成物**：marketplace root 下的 `.github/plugin/marketplace.json`、`.cursor-plugin/marketplace.json`、`.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json`、`.grok-plugin/marketplace.json`、`marketplace.json` 和 `plugins/CATALOG.md`。

包在 monorepo 内的位置不是终端用户接口；npm 包名、bin、CLI 行为、schema 和生成物格式继续受兼容性约束。内部 TypeScript 函数仍不是公共 Node library API，见 [ADR-0001](../adr/0001-cli-only-public-contract.md)。

## CLI 内部分层

```text
packages/cli/
├── src/
│   ├── cli.ts                 commander、help、错误到退出码
│   ├── commands/              CLI 编排与终端呈现
│   ├── application/           workspace/plugin 事务、health、生成、发布与注册编排
│   ├── infrastructure/        授权路径、进程执行、用户配置原子提交与回滚
│   ├── adapters/              portable、原生 manifest、客户端 index 与注册策略
│   ├── schema/                plugin.yaml 类型与 Ajv schema
│   ├── utils/                 marketplace 定位、读取与 frontmatter
│   └── generated/             构建期生成，不入库
├── scripts/                   生成、CLI E2E、npm 包边界回归与协议 fixture
└── dist/                      CLI 编译和 npm package 内容
```

依赖方向保持 `cli → commands → application → adapters/schema/infrastructure`。commander 与 `process.exit` 不得离开 `cli.ts`；adapter、schema、infrastructure 和 utils 不拥有 chalk/console 呈现。

## Marketplace 数据流

```text
external marketplace.yaml + plugins/*/plugin.yaml + component files
                                      │
                                      ▼
                 packages/cli: parse / authorize / health scan
                                      │
                           build / index / validate
                                      │
                                      ▼
          plugins/* generated files + marketplace client indexes
                                      │
                               release-local
                                      ▼
                          dist/release + archive
```

CLI 的 `--root` 接受任意外部 marketplace 目录；测试使用临时 fixture，不依赖官方内容仓库。

## Marketplace 注册数据流

```text
existing local directory | owner/repo | HTTPS/SSH Git URL
                             │
                    normalize + security preflight
                             │
               data-driven client adapter registry
             ┌───────────────┼────────────────┐
             ▼               ▼                ▼
 Claude/Codex/Grok/Copilot  VS Code JSONC   Cursor task
 executable + argv          atomic user write  manual only
             └───────────────┼────────────────┘
                             ▼
               per-target result + aggregate exit code
```

`application/marketplace-registration.ts` 只拥有来源归一化、目标顺序、结果聚合和退出码；
executable、能力探测、argv、本地索引与恢复文案由 `adapters/marketplace-registration.ts` 拥有。
外部调用经 `infrastructure/process-runner.ts` 以 `shell: false` 异步逐个执行；命令级 AbortController
协调真实 SIGINT、当前子进程取消和剩余目标汇总；忽略 SIGINT 的子进程会被有界升级终止。
VS Code 用户配置只接受安全绝对用户路径，使用独立的 revision-aware JSONC 原子提交，不复用
假定仓库内已存在 canonical 文档的 Marketplace 事务。该提交是纯 Node 最佳努力事务：snapshot、
guard descriptor 与提交后校验覆盖已定义冲突，但 Node rename 不提供文件 revision CAS；不协作的
新 inode 在候选提交或 guard 恢复的最后观察点后换入时，仍可能被相应无条件 rename 覆盖；这一
例外类由 [`TD-001`](../quality/technical-debt.md#td-001-vs-code-原子新-inode-并发替换窗口) 明确接受和跟踪。

## 关键不变量

- **单一事实源**：平台产物从 marketplace root 内的 `plugin.yaml` 与插件内容重新推导，不手改生成物。
- **CLI 内置资源**：`packages/cli/resources/plugkit/` 是 `init-repo` 脚手架内容的唯一源；构建时编译进 `src/generated`，发布后的 CLI 自包含。
- **portable 与分发分层**：Agent Plugins 只标准化 Skills/MCP 包；客户端 index、安装、更新、信任和权限仍属于分发 adapter。
- **注册不等于插件安装**：`install-repo` 只注册已就绪 Marketplace；不构建或修改来源，不安装其中插件，也不安装缺失客户端。
- **原生注册 list 预检**：Claude / Codex / Grok / Copilot 在 `plugin marketplace add` 前统一执行 `plugin marketplace list --json`，按来源 path/URL/repo 匹配已注册项后跳过 add；list 不可用或不匹配时再 add，并以共享的 already-registered 文案作为兜底。匹配不按 marketplace 名称，避免同名覆盖误判。
- **本地来源只读**：VS Code 用户配置路径与本地 Marketplace 相等、位于其内或经现有 symlink 指回来源时，在配置提交前失败。
- **终端安全预检**：来源原值、百分号解码值、解析候选路径与真实路径中的 C0/C1/DEL 在呈现或客户端调用前统一拒绝；Git shorthand 的点路径段不作为远端仓库接受。
- **路径段语义**：本地存在性检查保留用户输入的中间段，只有确认整条路径可访问后才生成 realpath。
- **客户端差异归 adapter**：原生 executable/argv、本地索引、VS Code 配置和 Cursor 手工边界不得进入共享聚合策略。
- **用户配置事务**：VS Code 写入保留 JSONC 与无关设置；相对配置根、非法 UTF-8、注释无法安全保留、malformed、可检测的 revision/guard 冲突或原子替换失败时不覆盖目标文件；失败候选会清理，清理受外部权限阻断时显式给出恢复路径。它不宣称文件系统级 CAS，`TD-001` 是唯一已接受并发例外类，并同时覆盖候选提交与 guard 恢复的无条件 rename 窗口。
- **部分结果不回滚**：目标按固定顺序执行；非中断失败继续，最终以 `0/1/2/130` 和逐目标文字状态表达结果。
- **客户端镜像优先级**：每个 marketplace root 的 `marketplace.json` 与 `.github/plugin/marketplace.json` 同字节；Codex index 只在 `.agents/plugins/marketplace.json`；Grok Build index 只在 `.grok-plugin/marketplace.json`。
- **路径安全和事务**：声明路径、导入源与生成目标通过 `authorized-path`；创建、生成和 release 使用 revision/fingerprint、锁、staging、原子替换与有界回滚。
- **输出隔离**：CLI 编译只写 `packages/cli/dist`；临时 marketplace 的 `release-local` 制品不得进入 CLI npm 包。
- **发布生命周期**：`packages/cli` 的 `prepack` 总是先执行 workspace build；正常 `npm pack` / `npm publish` 不得依赖已有 `dist`，也不能成功产生缺少可执行 bin 的包。
- **Marketplace cwd**：外部 marketplace 的 npm scripts 在自身 cwd 运行并让 CLI 默认发现 marketplace root；不得把 `--root .` 交给会按外层 `INIT_CWD` 解释相对路径的入口。
- **根目录不是 marketplace**：根没有 `marketplace.yaml`、插件目录或客户端 discovery manifest；官方 marketplace 使用独立仓库地址。
- **无预设共享层**：只有出现第二个真实消费者后，才根据稳定接口决定是否抽共享包。

## 测试、CI 与发布入口

- `npm run build`：生成内置 plugkit 内容并编译 `packages/cli`。
- `npm test`：CLI E2E、fake-client 注册、临时 VS Code JSONC、真实临时 marketplace release 和 CLI pack 边界回归。
- `npm run pack:cli`：先由 `prepack` 从无 `dist` 状态重建 CLI，再审查 `agent-plugkit` workspace 的实际 npm 发布清单。
- `npm run check:public`：阻止内部计划、候选取证、旧仓库耦合、本机路径和凭据形态内容进入公开树。
- CI 在 Node 20/22 上执行公开内容检查、构建、测试和 CLI pack dry run。

这些质量门只使用 fake client 与临时用户配置，不表示 Git push、npm publish、真实客户端注册、插件安装或上架已发生。

## 已知演进边界

命令层编排与呈现分离、adapter 对称化和测试分层仍是可维护性方向；`packages/cli` 内部模块不因此成为已承诺的共享 API。
