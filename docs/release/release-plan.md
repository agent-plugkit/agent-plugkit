# CLI 发布流程

状态：active

## 发布边界

本仓库只发布 npm CLI 包 `agent-plugkit`。官方插件市场独立维护在
[`agent-plugkit/plugkit-marketplace`](https://github.com/agent-plugkit/plugkit-marketplace)，其内容、版本、生成物和发布节奏不属于本仓库的发布事务。

`packages/cli/resources/plugkit/` 是 CLI 自带的 `init-repo` 脚手架资源，不是官方 Marketplace 内容仓库的镜像；CLI 构建和测试不得读取独立仓库。

## 发布候选门槛

从干净工作区安装依赖并运行：

```bash
npm ci
npm run check:public
npm run build
npm test
npm run pack:cli
git diff --check
```

发布前必须人工审查 `npm pack --dry-run` 的实际文件清单，确认包内只有 CLI 所需的 `dist/`、README、LICENSE 和包元数据，不包含仓库文档、测试 fixture、独立 Marketplace 内容或本机路径。

高风险依赖问题还应使用当前 lockfile 运行 `npm audit` 并单独记录结论；测试通过不能替代依赖审计。

## GitHub 与 npm 交付

- 版本号在根 `package.json`、`packages/cli/package.json` 和 `package-lock.json` 中一致。
- 发布提交必须已通过 GitHub Actions 的 Node.js 20 与 22 矩阵。
- `vX.Y.Z` tag 与 GitHub Release 必须指向同一个已验证提交。
- npm 只从 `packages/cli` workspace 发布；发布需要 2FA，并在可用时启用 provenance。
- 发布后重新查询 npm registry，并在隔离临时目录中安装和运行 `agent-plugkit --version`、`--help`。
- 官方 Marketplace 的仓库创建、提交、tag、Release 和注册是独立流程，不能与 CLI 发布成败绑定。

## 失败与修复

npm 已发布版本不可覆盖。发布后发现问题时，修复后发布新的 patch 版本；不得移动已有 tag 来掩盖提交不一致。GitHub Release、tag 或 npm 任一层失败时，应明确记录已完成与未完成的远端状态，再决定重试或发布后继版本。
