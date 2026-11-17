# 开源参考

2026-11-13 调研。star 数和活跃度来自 GitHub API，借鉴点都读过源码。没有核实的地方标了「未核实」。

## ACP

| 仓库 | 是什么 | 借鉴 | 不照搬 |
|---|---|---|---|
| agentclientprotocol/agent-client-protocol | ACP 规范。v1 已稳定，v2 是草案 | 接口直接用 v1 的类型：new / prompt / cancel / load / resume / update / request_permission。load 和 resume 是两个独立能力 | v2 还在变；官方 SDK 没有 Swift 版 |
| agentclientprotocol/claude-agent-acp | Claude 的 ACP 适配器，原 zed-industries/claude-code-acp，底层是 Agent SDK | ACP 的 sessionId 就是 Claude 的 session id；`canUseTool` 映射成允许一次 / 总是允许 / 拒绝 | 主文件约 1 万行，大半是编辑器扩展 |
| openclaw/acpx | 无头 ACP 客户端，相当于 daemon 这一侧 | 权限分三档：自动允许、自动拒绝、上报给编排者；进程崩了先 resume，不行再 load；拉起 agent 时默认不加载用户级 settings | 还没到 1.0 |

## 多会话管理与 GUI

| 仓库 | 驱动方式 | 借鉴 | 不照搬 |
|---|---|---|---|
| BloopAI/vibe-kanban（已宣布停止维护） | 裸 `claude -p` + stream-json + `--permission-prompt-tool=stdio` | 任务、worktree、会话、进程、对话轮次分表；存 Claude 的 session id | stdio 控制协议没有文档 |
| slopus/happy | 终端模式和 SDK 模式共用一个 session id，轮流跑 | 两种模式互斥交接；审批请求持久化后推送到手机 | 加密中继服务 |
| winfunc/opcode（原 claudia，AGPL） | Tauri，跳过所有权限 | 读 `~/.claude/projects` 做历史会话视图 | 没有审批 |
| smtg-ai/claude-squad（AGPL） | tmux + worktree，读屏幕自动按回车 | worktree 管理 | 读屏审批太脆 |

另外：crystal 已弃用（改名 nimbalyst），claude-code-webui 已归档。

## Slack 实时

| 仓库 | 是什么 | 借鉴 | 不照搬 |
|---|---|---|---|
| luoxiu/slk（fork 自 gammons/slk，Go，MIT） | 用自己的 Slack 登录态的 CLI，`slk listen` 连网页版的事件 websocket | 连接地址和 start_args、cookie 放在握手请求里、60 秒没有任何帧就重连、90 秒等不到 hello 就重连、退避从 1 秒到 30 秒且稳定 1 分钟才重置、认证失败退出码 2、睡眠唤醒后重连、错误信息脱敏。已移植进 slackcli 的 `listen` | 它冒充 Chrome 的 User-Agent。实测下来，User-Agent 不影响能不能连上，slackcli 沿用自己的 UA |

## 事件触发

| 仓库 | 是什么 | 借鉴 | 不照搬 |
|---|---|---|---|
| anthropics/claude-code-action | GitHub 上 @claude 触发，底层是 SDK | 只接受有写权限的人触发；内容按触发那一刻做快照，忽略事后修改；去掉不可见字符和 HTML 注释，token 打码；外部 PR 禁用会执行仓库代码的命令 | 靠每次一台新机器隔离，本机 daemon 没有这一层 |
| cyrusagents/cyrus | Linear / GitHub / Slack 事件 → worktree → Claude（SDK） | Slack 按 channel + ts 去重；每个来源一份工具白名单，Slack 来的只读；用 Stop hook 区分会话是结束了还是在等 | 依赖 webhook + 内网穿透 |
| nanocoai/nanoclaw | 常驻助手，SDK 在容器里免审批运行 | 定时任务先跑一段脚本，返回 `wakeAgent:false` 就不调模型 | 进了容器就用不了本机登录态，也没法接管 |
| openai/symphony | 轮询 Linear，派 Codex 干活，有 SPEC 文档 | 任务认领的状态机；每轮先对账再派发；失败退避重试；审批不能让任务无限挂起 | 对接的是 Codex 的协议 |

## Claude Code 文档里核实过的点

来源：code.claude.com 的 CLI reference、headless、sessions、hooks、agent-sdk 页面。

- **审批工具**：`--permission-prompt-tool <MCP 工具>` 用于非交互模式。返回一个 text 块，内容是 JSON，`{"behavior":"allow","updatedInput":{...}}` 或 `{"behavior":"deny","message":"..."}`。
- **无人应答时**：`--permission-prompts none` 表示不问人，直接拒绝（v2.1.259+）。
- **权限判定顺序**（SDK 文档）：hooks → deny 规则 → ask 规则 → permission mode → allow 规则 → prompt tool。
- **会话**：
  - `-p --resume <id>` 能续跑 `-p` 的会话。
  - `-p` 的会话不出现在选择列表里，但 `claude --resume <id>` 能直接打开。
  - resume 不会带回 `--mcp-config`、`--settings`、`--add-dir`，要重新传。
- **stream-json 输入**：`--input-format stream-json` 下，排队的消息会开启新的一轮。
- **result 事件**：带 `total_cost_usd`、`usage`、`permission_denials`。
- **默认加载的配置**：不加 `--bare` 时，`-p` 会加载 cwd 的 CLAUDE.md、skills、`.mcp.json` 和 `~/.claude` 的用户配置。
- **hooks 超时**：PreToolUse hook 默认超时 600 秒，超时后回落到常规权限流程。
- **Agent SDK 认证**：未经批准，第三方产品不得提供 claude.ai 登录，应该用 API key。
