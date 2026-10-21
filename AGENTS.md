# LocalSpace JS

MCP 服务器：把本机批准的工作区暴露给 ChatGPT 等客户端。

工具面只有 `open_workspace` 与 `js`。外层框架（CLI、配置、Streamable HTTP、OAuth、workspaces、审计）保持 LocalSpace 血统。

核心实现在 `src/program/`。修改工具行为时优先改那里，并跑：

```bash
npm test
npm run typecheck
npm run build
```
