# 与万象术新 Scope 思路的适配边界（2026-10-25）

LocalSpace JS 是 MCP 工具执行宿主，不是 Provider 请求宿主。本文记录本次适配的实际边界；这不是重建 `resetScope` 的设计稿。

| 万象术原则 | LocalSpace 的对应所有者 | 改动和反例 |
| --- | --- | --- |
| 预算必须可证，未知不当作零 | `RequestWindow` + 顶层必填 `intent` | 拒绝缺失 `intent`；同一函数决定真实截止时间和文本展示；UTF-8 多字节与 30 秒 cap 由预算测试证伪。不存在模型 Scope KPI，不添加虚构 `resetScope`。 |
| 真实持久事件决定提醒是否发 | `WorkspaceRegistry` / `WorkspaceStore` | 新工作区无恢复提示；基于 SQLite 会话记录首次恢复才发、每 workspace 各一次，重开不重复。通过真实双服务器 MCP 重启验证。 |
| 未观察到不等于否 | `gitHint` + `composePairHints` | git 观察缺席显示 `git status unknown`，不冒称 `clean`；模型不会被要求自行决定提示是否适用。 |
| 保留原始工具证据与 Host 提示来源 | MCP `structuredContent` 与文本 Pair Hint | 保持现有 NUL+BOM wire 合约，不改 `structuredContent` 的程序结果；Host 观察不可冒充程序输出或 Provider user steer。 |
| 不能用没有的宿主机制模拟旧我 | 无此组件 | 没有 Provider epoch、工具目录和模型答复投递，故没有假造 `askPreviousScope` 或 `negotiate` 业务；`park/unpark` 仍由现有权限和请求时序管理。 |

验收路径：`src/workspaces.test.ts` 的真 SQLite 多工作区恢复；`src/server-hardening.test.ts` 的两轮 MCP HTTP server 物理回复及正文／结构化字段检查；`src/program/program.test.ts` 的真／假 Git 状态文本；`src/program/budget.test.ts` 的字节预算与累计 deadline；以及 `npm test`、`npm run typecheck`、`npm run build`。
