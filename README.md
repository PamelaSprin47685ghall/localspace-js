# LocalSpace JS

基于 [Alan-512/localspace](https://github.com/Alan-512/localspace)（MIT；源自 Waishnav/devspace）的公开分支。

把原先细碎、常拦截的 MCP 工具面，换成两个工具：

1. **`open_workspace`** — 打开允许根内的本地目录，返回 `workspaceId` 与中文**总纲**
2. **`js`** — 唯一的读 / 写 / 执行入口：输入只有 `{ workspaceId, program }`

## `js` 程序 API

`program` 是一段平铺的异步 JavaScript（不必写 class）：

| 成员 | 作用 |
|---|---|
| `cat` / `stat` / `ls` / `rg` | 读与搜索 |
| `where` / `whereAll` | 空白折叠精确定位；零/多匹配会 park |
| `write` / `mkdir` / `mv` / `rm` | 立即落盘（as-is） |
| `call(command)` | 执行 shell 命令 |
| `park` / `unpark` / `abandon` | 挂起与恢复（在**新** program 里调用 unpark/abandon） |

- 约每 **30 秒**自动 `yield` park，用 `unpark(handle)` 续跑
- 危险操作（递归删除、强推、sudo…）自动 `confirm` park；`unpark(handle, { dangerous: true })` 强制继续
- 硬性拒绝：路径越出 `allowedRoots`、改写 `auth.json`
- 工具结果在 `\u0000\uFEFF`（NUL+BOM）之后附带 Pair Hint（git 脏度、park 现场等）

## 示例

```js
// open_workspace 之后：
const text = await cat("README.md");
const [a, b] = await where(text, "## Install");
await write("README.md", text.slice(0, a) + "## Setup" + text.slice(b));
const out = await call("npm test");
return { exit: out.exitCode };
```

恢复挂起：

```js
return await unpark("pk_…", { dangerous: true });
// 或 where：
return await unpark("pk_…", [begin, end]);
```

## 运行

```bash
npm ci
npm run build
# 本地无 OAuth 试跑：
LOCALSPACE_AUTH_MODE=none \
LOCALSPACE_ALLOWED_ROOTS=$HOME \
LOCALSPACE_PUBLIC_BASE_URL=http://127.0.0.1:7677 \
PORT=7677 \
node dist/cli.js serve
```

生产部署仍走 OAuth（默认 `LOCALSPACE_AUTH_MODE=oauth`）与既有 systemd / 反代框架。

## 许可

MIT。保留上游版权声明。本仓库净室实现了新的 `js` 编程面；总纲与工具描述为中文原创改写。
