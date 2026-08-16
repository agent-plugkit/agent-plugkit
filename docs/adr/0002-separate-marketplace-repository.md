# ADR-0002：CLI 与官方 Marketplace 使用独立仓库

状态：accepted（2026-08-16）

## 背景

CLI 源码、npm 发布包和官方插件内容具有不同的版本、CI 与发布节奏。把两者放在同一个 npm
workspace 会让 CLI 构建依赖内容仓库，也会使代码仓库承担不属于 npm 包的生成物和发布历史。

## 决策

1. `agent-plugkit/agent-plugkit` 只维护 CLI 源码、测试、架构和 npm 发布流程。
2. `agent-plugkit/plugkit-marketplace` 独立维护官方插件、canonical YAML、生成索引和本地发布包。
3. CLI 测试只使用临时 marketplace fixture，不克隆或读取官方内容仓库。
4. `packages/cli/resources/plugkit/` 仅拥有 `init-repo` 随 CLI 版本发布的内置脚手架内容；官方
   marketplace 中的插件由内容仓库独立版本化，两者没有跨仓库构建依赖。
5. 当前仓库根不包含 marketplace discovery 文件，也不能作为 marketplace 来源注册。

## 后果

- CLI 可以只凭本仓库和 lockfile 完成安装、构建、测试与 npm pack。
- Marketplace 可以只凭发布到 npm 的 `agent-plugkit` 完成生成、验证和 release-local。
- 两个仓库分别运行 CI；CLI 发布不自动发布 marketplace，内容变更也不触发 CLI 发包。
- 若内置脚手架与官方插件需要同步，必须通过明确版本变更完成，不能依赖相邻目录读取。
