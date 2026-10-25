# LocalSpace JS

基于 [Alan-512/localspace](https://github.com/Alan-512/localspace)（MIT；源自 Waishnav/devspace）的公开分支。

把原先细碎、常拦截的 MCP 工具面，换成两个工具：

1. **`open_workspace`** — 打开允许根内的本地目录，返回 `workspaceId` 与中文**总纲**
2. **`js`** — 唯一的读 / 写 / 执行入口：输入 `{ workspaceId?, program, intent }`

`workspaceId` 由目录决定、稳定不变：同一文件夹重复 `open_workspace` 返回同一个 id，服务重启后也能恢复。`workspaceId` 可以省略（复用最近使用的工作区），也可以直接传项目根目录路径；未知 id 的报错会列出当前候选，不需要反复重开工作区。

## `js` 程序 API

`program` 是一段平铺的异步 JavaScript（不必写 class）。**全部原语都是 `this` 的成员**（万象术风格）：

| 成员 | 作用 |
|---|---|
| `this.cat` / `this.stat` / `this.ls` | 读文件与目录 |
| `this.search` / `this.findRelated` | 语义代码搜索（内置 [Semble](https://github.com/MinishLab/semble)，经 `uvx` 启动） |
| `this.where` / `this.whereAll` | 字面精确定位；`where` 零/多匹配会 park |
| `this.write` / `this.mkdir` / `this.mv` / `this.rm` | 立即落盘（as-is） |
| `this.call(command)` | 执行 shell；等待时间来自本次请求的顶层 `intent` |
| `this.park` / `this.unpark` / `this.abandon` | 挂起与恢复（在**新** program 里调用 unpark/abandon） |

- 每次 `js` **必填**顶层 `intent`：**每 20 个 UTF-8 字节 = 1 秒**（`Buffer.byteLength × 50ms`），**单次请求最多 30 秒（600 字节，超出按 30 秒封顶）**；到点自动 `yield` park，下次请求带新 `intent` 且用 `this.unpark(handle)` 续跑
- 这个截止时间被本次请求的所有 `this.call` 与 `this.unpark` 共用，`this.call(command)` 不再单独收 `intent`，程序内无法续期
- 客户端断开（AbortSignal）**不杀程序**：程序与命令继续在后台跑，现场留在 `parked:` 列表里，回来 `this.unpark(handle)` 取结果，不要重跑
- 等待窗口永远有定时器兜底：命令卡死、`sleep` 不返回、等 stdin 的 call 也一定到点返回 `yield`，不会挂住客户端
- 程序运行在独立 worker 线程：主线程只做 HTTP/MCP 与计时，死循环也会按时 yield，不会卡住服务
- 每个 `this.call` 独占进程组；程序结束、`this.abandon`、现场过期（`LOCALSPACE_PARK_TTL_MS`，默认 30 分钟）或服务关闭时整组 SIGTERM→SIGKILL
- 输出每路仅保留末尾 128KiB（`truncatedBytes` 标明丢弃量）；`this.cat` 上限 8MiB；返回值上限 1MiB；MCP 请求体上限 8MB
- 主线程事件循环延迟超过 500ms 时记录 `event_loop_lag` 警告，`/healthz` 附带最近窗口
- 危险操作（递归删除、强推、格式化…）自动 `confirm` park；`this.unpark(handle, { dangerous: true })` 强制继续
- 硬性拒绝：路径越出 `allowedRoots`、改写 `auth.json`
- 工具结果在 `\u0000\uFEFF`（NUL+BOM）之后附带 Pair Hint（`now` ISO UTC 时间、git 脏度、park 现场等）；`structuredContent.servedAt` 是同一时间，模型据此知道“现在几点”

### 顶层等待窗口

提交工具参数：

```json
{
  "workspaceId": "当前工作区 id",
  "intent": "等待测试完成；到期后保留原命令，检查输出并显式恢复，不重复启动测试。",
  "program": "const out = await this.call(\"npm test\"); return out;"
}
```

实际预算为 `min(UTF8Bytes(intent) × 50ms, 30000ms)`，在准入时形成一个绝对截止时间。连续命令和恢复目标都只使用剩余时间。程序内 `const intent = 'x'.repeat(48000)` 不参与预算；`call(command, intent)` 和三参数 `unpark` 会被拒绝。

到期时命令可以继续在后台运行，新增输出放在 `delta`。新的工具请求提供顶层 `intent`，程序体用 `return await this.unpark(handle);` 取回最终结果。已启动命令不重跑；worker 的本地计算及直接文件 API 保留既有后台行为，新命令和恢复请求在期限后等待显式恢复。

## 代码搜索依赖 `uvx`

`this.search` / `this.findRelated` 直接调用 `uvx --from "semble[mcp]" semble`，仓库本身不捆绑它。使用前请安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)（自带 `uvx`）：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
# 或：pip install uv
```

首次调用会下载 semble 并为本工作区建立索引（较慢）；之后的查询命中缓存。索引以**工作区根目录**为 `repo`，不接受程序传入的任意路径或远端 URL。`LOCALSPACE_SEMBLE_CMD` 可覆盖启动命令（JSON 数组或空白分隔），`LOCALSPACE_SEMBLE_TIMEOUT_MS`、`LOCALSPACE_SEMBLE_IDLE_MS` 调整单次调用上限与空闲回收时间。

## 示例

```js
// open_workspace 之后，以下源码放入 program；同次工具请求另带顶层 intent：
const text = await this.cat("README.md");
const [a, b] = await this.where(text, "## Install");
await this.write("README.md", text.slice(0, a) + "## Setup" + text.slice(b));
const hits = await this.search("解析 MCP initialize 请求的函数");
const out = await this.call("npm test");
return { exit: out.exitCode, files: hits.results?.map((r) => r.file_path) };
```

恢复挂起时，新工具请求仍须携带顶层 `intent`：

```js
return await this.unpark("pk_…", { dangerous: true });
// 或 where：
return await this.unpark("pk_…", [begin, end]);
```

## 不支持 OAuth 的客户端（Grok）

ChatGPT 走完整的 OAuth：`/register` → `/authorize`（填 owner token）→ `/token`。
Grok 的 connector 只接受一个 URL，探测时连 `Authorization` 头都不带，`/mcp` 直接 401，连不上。

固定 token 默认就是 OAuth 的 owner token（`~/.localspace/auth.json` 里的 `ownerToken`），不需要新密码；要改用别的值就设 `LOCALSPACE_MCP_TOKEN`（至少 16 字符）。二选一：

- URL 里带：`https://<你的域名>/mcp?token=<ownerToken>`
- 请求头里带：`Authorization: Bearer <ownerToken>`（`grok mcp add --header` 或 xAI API 的 `authorization` 参数）

固定 token 与 OAuth 并存：`/mcp` 先认固定 token，认不出再走原来的 Bearer/OAuth 校验；`authMode` 仍是 `oauth`，浏览器流程不受影响。
注意：`?token=` 会进反向代理（Caddy）的访问日志，只在不支持请求头的连接器上用。

## 终端监控屏

```bash
npm run monitor                      # 只显示新发生的操作
npm run monitor -- --state-dir DIR   # 换 state 目录
npm run monitor -- --full            # 每行打印更长的 program 片段
npm run monitor -- --no-color        # 重定向到文件时用
```

`tail -f` 风格：每行一个事件，`▶` 请求开始（附本次 `intent`）、`…` 超过 10 秒仍在跑、`✓/✗` 结束（耗时、结果、写入数），结束行再用 `→` 回显 intent、`│` 回显 program 片段。
数据直接来自 `~/.local/share/localspace/traffic/<UTC小时>.jsonl`，所以多个 AI 交错、多台工作区并发都会按真实顺序刷出来。

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
