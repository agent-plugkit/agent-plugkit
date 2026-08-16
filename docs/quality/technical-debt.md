# 技术债务

本文是项目已接受技术债务的唯一台账。只有经过明确风险接受的条目进入此处；普通缺陷、未来功能
和未验证担忧不登记为债务。

## TD-001：VS Code 原子新 inode 并发替换窗口

- 状态：已接受
- 接受日期与证据：2026-08-16；`packages/cli/scripts/test-install-repo.ts` 固定了候选提交与 guard 恢复两个不协作新 inode 窗口，`packages/cli/README.md` 明确公开最佳努力边界。
- 偏离与证据：Node 的 `fs.rename(oldPath, newPath)` 没有 revision 或条件替换参数。隔离探针已复现同一缺口的两个阶段：不协作的外部写入者若在最后一次目标路径 snapshot 校验后、候选 rename 前换入新 inode，候选会覆盖该内容；若 guard 已捕获同 inode 变化，在候选提交后检查与 guard 恢复 rename 之间换入更晚的新 inode，恢复 rename 会覆盖该更晚内容。guard descriptor 分别仍指向旧 inode 或只保存较早的同 inode 内容，无法恢复被覆盖的新 inode。
- 受影响边界：仅影响 `install-repo --agent vscode` 更新已经存在的当前用户 `settings.json`；缺失文件的独占原子创建、其他客户端注册、来源仓库和插件内容不受影响。
- 延期理由与成本：v1 保留纯 TypeScript/npm 包和 VS Code 一键注册，不引入 native addon、平台专用二进制与三平台打包矩阵。成本是候选提交或 guard 恢复的无条件 rename 窄窗口内可能丢失一次不协作外部写入；CLI 不能宣称文件系统级 compare-and-swap，也不能笼统声称每次失败都未覆盖原文件。
- 现有保护措施：写入前比较存在状态、内容 revision、类型与 mode；既有文件持有 guard descriptor 并在没有更晚新 inode 竞态时恢复同 inode rename 窗口变化；缺失文件使用独占 hard link 创建；提交后核对候选 revision；所有检测到且位于已定义观察点之前的冲突均失败或恢复，候选临时文件执行 fsync、清空与清理；自动测试只操作临时配置，并分别覆盖提交后外部内容保留和已接受的 guard 恢复覆盖窗口。
- 责任与重访触发：CLI 维护者负责；发生任何用户配置丢失报告、Node 新增条件 rename/CAS API、项目因其他需求引入 native runtime，或再次修改 `vscode-user-settings.ts` 的提交协议时，必须在该变更合入前重访。
- 最小偿还范围：形成跨 macOS、Linux、Windows 的条件式候选提交与条件式 guard 恢复协议，或把既有配置切换为手工步骤；用两个阶段的不协作新 inode 原子替换反例证明不会丢失外部内容，并保持 JSONC、mode、临时文件清理和现有 CLI 退出码契约。
- 明确不做：本轮不增加 advisory lock、native addon、平台专用 CAS、后台守护进程，也不把所有既有 VS Code 配置降级为手工注册。
- 关闭标准：支持平台上的不协作原子替换反例全部通过，最佳努力例外从公开文档删除，相关构建、包边界、回归和独立质量门通过。
- 回退入口：在偿还前需要零覆盖风险的使用者应不选择 `vscode` 目标，并按 VS Code 官方配置入口手工修改 `chat.plugins.enabled` 与 `chat.plugins.marketplaces`。
