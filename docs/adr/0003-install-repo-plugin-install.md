# ADR-0003：`install-repo --plugin` 通过客户端 CLI 安装插件

状态：accepted（2026-10-11）

## 背景

首次使用官方 Marketplace 需要两步：先 `install-repo` 注册，再手动运行
`claude plugin install <插件>@<marketplace>` 或 `codex plugin add <插件>@<marketplace>`。第二步
需要知道客户端登记的 Marketplace 名称，用户容易卡在这里。此前架构约定 `install-repo` 只注册、
不安装插件。

## 决策

1. `install-repo` 新增可重复的 `--plugin <name>`；不传时行为不变。
2. 安装只在该目标注册完成后执行，并只调用客户端自身的公开 CLI：Claude Code
   `plugin install <插件>@<marketplace>`、Codex `plugin add <插件>@<marketplace>`。
3. Marketplace 名称从 `plugin marketplace list --json` 中按来源 path/URL/repo 匹配得出，与注册
   预检规则一致；不按名称猜测，找不到时失败并给出手动命令。
4. 没有文档化插件安装命令的目标（Grok Build、GitHub Copilot、VS Code、Cursor）返回需手动，不
   写入私有缓存或配置。
5. 插件结果与注册结果共用状态标签和 `0/1/2/130` 退出码语义。

## 后果

- 新用户一条命令即可完成注册与安装；缺少客户端 CLI 时，注册和插件都报告 `[缺少 CLI]` 及安装提示。
- 不新增独立子命令，避免与仓库维护用的 `add` 命令混淆。
- 客户端安装命令若变更，只需调整对应 adapter 的 `pluginInstallArgs`。
