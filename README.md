# Agent Plugkit

Agent Plugkit 是用于开发和发布 `agent-plugkit` CLI 的仓库。

## 工作区

- [`packages/cli`](packages/cli/)：公开发布的 `agent-plugkit` npm CLI 包。
- [`docs`](docs/)：当前产品、架构、ADR、质量和发布文档。

官方插件市场独立维护在 [`agent-plugkit/plugkit-marketplace`](https://github.com/agent-plugkit/plugkit-marketplace)。

## 开发

```bash
npm install
npm run build
npm test
npm run pack:cli
npm run check:public
```

从源码运行 CLI：

```bash
npm run agent-plugkit -- --help
npm run agent-plugkit -- --root /path/to/marketplace validate --all
npm run agent-plugkit -- install-repo agent-plugkit/plugkit-marketplace --agent vscode
```

CLI 的完整使用说明见 [`packages/cli/README.md`](packages/cli/README.md)。项目架构见
[`docs/architecture/overview.md`](docs/architecture/overview.md)。
