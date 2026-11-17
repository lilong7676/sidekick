# ADR 0001：一期的执行器直接 spawn `claude -p`，审批走 MCP 工具

- 状态：Phase 0 实测确认，补充约束见 [ADR 0003](0003-phase0-findings.md)
- 日期：2026-11-13

## 背景

一期只支持 Claude Code。驱动它有四条路，底层都是同一个 claude 二进制：

| 方案 | 实时审批 | 会话 | 认证 | 代表项目 |
|---|---|---|---|---|
| A. spawn `claude -p`，加 `--permission-prompt-tool <MCP 工具>` | 有文档：MCP 工具返回 `{"behavior":"allow"\|"deny"}` | `--session-id` 预先指定 id，`--resume` 续跑；`-p` 跑出的会话可以在终端用 `claude --resume <id>` 打开 | 使用者自己的 CLI 和登录，就是 headless 文档的用法 | — |
| B. spawn `claude -p`，加 `--permission-prompt-tool=stdio` | 用 stdio 控制协议应答，协议没有公开文档 | 同 A | 同 A | vibe-kanban（已宣布停止维护） |
| C. Claude Agent SDK | `canUseTool` 回调，可以无限期挂起，类型完整 | 同 A，SDK 起的会话不进 `--resume` 的选择列表 | 文档写明：未经批准，第三方产品不得提供 claude.ai 登录，应使用 API key | claude-code-action、cyrus、nanoclaw |
| D. 拉起 ACP 适配器 claude-agent-acp | 走 ACP 的 `session/request_permission` | ACP 的 sessionId 就是 Claude 的 session id | 适配器支持订阅登录（底层是 SDK，政策同 C） | Zed、acpx |

## 决定

选 **A**。runner 的接口按 ACP v1 的形状定义，见 plan.md §6。理由：

1. **只依赖有文档的接口。** `--permission-prompt-tool` 接 MCP 工具、`--session-id`、`--resume`、`stream-json` 都写在 CLI 文档里。B 依赖未公开的控制协议，CLI 一升级可能就要跟着改。
2. **认证最干净。** 跑的就是使用者自己装的 claude CLI，用的是 headless 模式，daemon 不碰 token。C 和 D 底层是 SDK，订阅登录有政策上的灰区。现在是个人用，以后要在公司推广，这一点更重要。
3. **和接管用的是同一个二进制、同一个会话。** 终端里 `claude --resume <id>` 打开的，就是 daemon 跑出的那个会话，不存在 SDK 自带的二进制和本机 CLI 版本不一致的问题。
4. **审批工具本来就要有。** 对外动作的提案、等待、关联这些 sidekick 自己的工具，都得通过一个 MCP 服务提供。审批工具放在同一个服务里，不多一个部件。

## 代价和风险

- **MCP 审批工具挂起能等多久，文档没写。** 已知启动时连 MCP 最多等 30 秒，调用期间的超时不知道。plan.md §7 的设计是「等一会儿，等不到就 deny，再 resume」，所以不依赖长时间挂起。Phase 0 第 1 项实测。
- **自己写 stream-json 的解析。** 输出事件的类型文档里有列（system init、assistant、user、result 等），但字段可能随版本变。解析要宽松，遇到不认识的事件原样记日志。
- **resume 不会带回 `--mcp-config`、`--settings`、`--add-dir`。** runner 每次都从任务的 `launch_spec` 重建完整参数。

## 什么时候重新评估

- Phase 0 发现 MCP 审批工具不可用或不稳定：改用 C，同时要解决认证问题（换 API key，或者确认政策允许）。
- 二期要接第二种 agent：改成拉起 ACP 子进程（D），客户端参考 acpx。现在接口已经按 ACP 定义，到时候只换实现。
