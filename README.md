# LocalSpace JS

基于 [Alan-512/localspace](https://github.com/Alan-512/localspace)（MIT；源自 Waishnav/devspace）的公开分支。

把原先细碎、常拦截的 MCP 工具面，换成两个工具：

1. **`open_workspace`** — 打开允许根内的本地目录，返回 `workspaceId` 与中文**总纲**
2. **`js`** — 唯一的读 / 写 / 执行入口：输入 `{ workspaceId?, program }`

`workspaceId` 由目录决定、稳定不变：同一文件夹重复 `open_workspace` 返回同一个 id，服务重启后也能恢复。`workspaceId` 可以省略（复用最近使用的工作区），也可以直接传项目根目录路径；未知 id 的报错会列出当前候选，不需要反复重开工作区。

## `js` 程序 API

`program` 是一段平铺的异步 JavaScript（不必写 class）。**全部原语都是 `this` 的成员**（万象术风格）：

| 成员 | 作用 |
|---|---|
| `this.cat` / `this.stat` / `this.ls` | 读文件与目录 |
| `this.search` / `this.findRelated` | 语义代码搜索（内置 [Semble](https://github.com/MinishLab/semble)，经 `uvx` 启动） |
| `this.where` / `this.whereAll` | 字面精确定位；`where` 零/多匹配会 park |
| `this.write` / `this.mkdir` / `this.mv` / `this.rm` | 立即落盘（as-is） |
| `this.call(command, planB?)` | 执行 shell；`planB` = 这次请求愿意等多久（省略 1 秒，给了则字节数 × 50ms） |
| `this.park` / `this.unpark` / `this.abandon` | 挂起与恢复（在**新** program 里调用 unpark/abandon） |

- 程序自身计算每次 `js` 最多 **1 秒**（`this.call` 的等待时间不计入）；到点自动 `yield` park，用 `this.unpark(handle, undefined, planB)` 续跑
- `planB` 是「这次请求愿意等多久」：`this.call` 与 `this.unpark` 都接受，省略 1 秒，给了则字节数 × 50ms
- 等待窗口永远有定时器兜底：命令卡死、`sleep` 不返回、等 stdin 的 call 也一定到点返回 `yield`，不会挂住客户端
- 程序运行在独立 worker 线程：主线程只做 HTTP/MCP 与计时，死循环也会按时 yield，不会卡住服务
- 每个 `this.call` 独占进程组；程序结束、`this.abandon`、现场过期（`LOCALSPACE_PARK_TTL_MS`，默认 30 分钟）、请求取消或服务关闭时整组 SIGTERM→SIGKILL
- 输出每路仅保留末尾 128KiB（`truncatedBytes` 标明丢弃量）；`this.cat` 上限 8MiB；返回值上限 1MiB；MCP 请求体上限 8MB
- 主线程事件循环延迟超过 500ms 时记录 `event_loop_lag` 警告，`/healthz` 附带最近窗口
- 危险操作（递归删除、强推、格式化…）自动 `confirm` park；`this.unpark(handle, { dangerous: true })` 强制继续
- 硬性拒绝：路径越出 `allowedRoots`、改写 `auth.json`
- 工具结果在 `\u0000\uFEFF`（NUL+BOM）之后附带 Pair Hint（git 脏度、park 现场等）

### `this.call`

```js
const out = await this.call("npm test");            // 缺省 1 秒窗口
await this.call("npm test", "跳过测试并报告风险");   // planB 字节数 × 50ms
```

命令到期未结束就 `yield` park；输出在 `delta` 里，命令继续在后台跑，`this.unpark(handle, undefined, planB)` 拿到最终 `CallResult`，不要重跑。

## 代码搜索依赖 `uvx`

`this.search` / `this.findRelated` 直接调用 `uvx --from "semble[mcp]" semble`，仓库本身不捆绑它。使用前请安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)（自带 `uvx`）：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
# 或：pip install uv
```

首次调用会下载 semble 并为本工作区建立索引（较慢）；之后的查询命中缓存。索引以**工作区根目录**为 `repo`，不接受程序传入的任意路径或远端 URL。`LOCALSPACE_SEMBLE_CMD` 可覆盖启动命令（JSON 数组或空白分隔），`LOCALSPACE_SEMBLE_TIMEOUT_MS`、`LOCALSPACE_SEMBLE_IDLE_MS` 调整单次调用上限与空闲回收时间。

## 示例

```js
// open_workspace 之后：
const text = await this.cat("README.md");
const [a, b] = await this.where(text, "## Install");
await this.write("README.md", text.slice(0, a) + "## Setup" + text.slice(b));
const hits = await this.search("解析 MCP initialize 请求的函数");
const out = await this.call("npm test", "跳过测试，改为报告未验证风险");
return { exit: out.exitCode, files: hits.results?.map((r) => r.file_path) };
```

恢复挂起：

```js
return await this.unpark("pk_…", { dangerous: true });
// 或 where：
return await this.unpark("pk_…", [begin, end]);
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
