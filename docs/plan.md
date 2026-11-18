# 方案（一期：工作 profile）

> 状态：待拍板。没有代码。背景和范围见 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)，关键选型见 [adr/](adr/)，开源参考见 [references.md](references.md)，最后一节是需要拍板的问题。

## 1. 总体结构

```
┌─────────────────────── sidekick daemon（launchd 常驻）───────────────────────┐
│                                                                            │
│  事件源（轮询）         路由与关联            任务账本（SQLite）    执行器     │
│  slack  ─┐                                                                 │
│  github ─┼→ 事件 ──→  新建任务 / 挂到已有任务 ─→  tasks / runs  ──→  claude -p │
│  jira   ─┤            / 唤醒等待中的任务          approvals          （cwd =  │
│  manual ─┘                                            ↑            profile） │
│                                                       │                │    │
│                                sidekick MCP 服务 ←───────┴── 权限请求、提案、等待 │
│                                                                            │
│  本地 API（127.0.0.1 + token 文件）                                          │
└──────────────────────────────────↑─────────────────────────────────────────┘
                                   │ 读状态、批准、派活、接管
                         菜单栏 app（Swift）
```

- **daemon 和 app 分开**：daemon 负责采集、调度、执行和落账本，app 只读状态、发指令。app 关了任务照跑，崩了也不丢状态。
- **引擎不懂业务**：判断规则全在 profile 的 skill 和授权策略里。执行时 cwd 设为 profile 根目录，CLAUDE.md、skill、memory 由 Claude Code 自己加载。不加 `--bare` 时，`-p` 会加载这些（见 headless 文档）。

## 2. profile 契约

一个 profile 就是一个工作区目录。一期只有工作 profile，即现有工作区。引擎本身的配置只记录有哪些 profile：

```yaml
# ~/.config/sidekick/config.yaml
profiles:
  - name: work
    root: ~/<工作区路径>
```

工作区提供：

```
<工作区>/
  sidekick/profile.yaml   事件源参数、路由表、授权策略
  sidekick/me.md          分身（默认路径，profile 的 persona 可以改成别的文件）
  skills/               已有的 skill（slack-inbox、ticket-closed-loop……）
  CLAUDE.md             已有：准则、授权边界
  .state/sidekick/        账本和日志（.state/ 已在 .gitignore 里）
```

`profile.yaml` 大致的样子：

```yaml
sources:
  slack:  { poll: 5m, denyChannels: [...], levels: { dm: interrupt, mention: interrupt, thread: tell } }
  github: { poll: 2m, reasons: [review_requested, mention, comment, assign] }
  jira:   { poll: 5m, jql: "assignee = currentUser() OR watcher = currentUser()" }

routes:                                  # 从上往下匹配第一条
  - match: { source: slack }
    skill: slack-inbox
    tier: triage                         # 分诊：要不要回、能不能代做、归不归我；只读调查 + 起草
    env: lean                            # 只加载项目级配置，见 §6
    agent: { model: claude-opus-5-5, effort: medium }   # 每条直接处理，见 §5
    batch: 8                             # 分诊批量跑，见 §5
  - match: { source: jira, event: assigned }
    skill: ticket-closed-loop
    tier: dev                            # 可改本地代码；PR、合并、流转走审批
    env: full                            # 要用 Jira 等 claude.ai 连接器
  - match: { source: manual }
    skill: auto                          # 按链接类型选 skill，纯文字就直接执行

policy:                                  # 对应 CLAUDE.md 授权边界的三档
  tiers:
    triage: { allow: [...], deny: [...] }
    dev:    { allow: [...], deny: [...] }
  outbound: [slack.send, jira.comment, jira.transition, github.comment, github.merge]
```

- **policy 三档**：用 auto 模式（已定），三档这样落地（ADR 0003 ⑤ 实测）：

  | 档 | 落到哪 |
  |---|---|
  | 自主 | 交给 auto 分类器判断 |
  | 我说一句 | 写成 `permissions.ask` 规则（通过 `--settings` 传入），命中就交给审批工具，出卡 |
  | 只能我 | 写成 `--disallowedTools`，在 auto 下照样硬拦 |

  auto 分类器把 prompt 里写明要做的事当成我授权了的，force push 和对外 POST 都直接放行了。所以对外动作不能指望分类器拦，必须写进 ask 或 deny。

  **工作 profile 的定法（2026-11-13）：工具权限全交给 auto，`ask` 留空，只用 `deny` 拦「只能我」的几样**（发包、force push、改凭证、改仓库设置）。ask 机制保留在引擎里，给以后需要的 profile 用。对外说话不受影响：回 Slack 只能走 `propose`，审批卡由我批。
- **从 slack-inbox 迁移**：现有 `config.json` 里的频道过滤、分档，`opencode.json` 里 slack-inbox agent 的 bash deny 列表，原样迁到这里。

## 3. 数据模型

| 表 | 一行是什么 | 关键字段 |
|---|---|---|
| `events` | 一个外部事件 | source、kind、external_id、dedupe_key、url、actor、text、keys（提取出的关联键）、task_id |
| `tasks` | 一件事 | title、status、route、keys、waiting_for、session_id、launch_spec（复现一次运行所需的全部参数） |
| `runs` | 一次 claude 进程 | task_ids（分诊可一跑多件）、session_id、trigger、exit、cost_usd、usage、log_path |
| `approvals` | 一张审批卡 | task_id、run_id、kind（tool / outbound）、payload、status、decided_at |

任务状态机：

```
new → queued → running ─┬→ done / closed
                        ├→ needs_approval ──(批准/拒绝)──→ queued
                        ├→ waiting（等外部事件或超时）──(事件到)──→ queued
                        └→ failed（连续三次没进展）
   任意状态 → cancelled（我取消）；running → paused（我接管）
```

**状态只在账本里，不在会话里。** 这条沿用 slack-inbox 的原则。换模型、重启 daemon、换一天，读同一个账本得到同一个结论。

## 4. 事件源

| 源 | 怎么拉 | 去重键 | 说明 |
|---|---|---|---|
| Slack | `slackcli conversations unread`，**只收两类**（2026-11-13 定）：1:1 私信我（含其中的 thread），以及在频道、群聊、thread 里 @ 我本人。我参与过的 thread 里其他人的回复、@here / @channel、群聊闲聊都不收 | channel + 消息 ts | 已跑通 |
| GitHub | `gh api notifications`（participating），用 `since` 拉增量，间隔跟随 `X-Poll-Interval` | thread id + updated_at | 不标已读，保持只读 |
| Jira | `acli jira workitem search --jql '<profile jql> AND updated >= "<上次>"' --json`，命中的单再用 `view` / `comment list` 看变了什么 | key + 最新评论 id + 状态 | acli 已 OAuth 登录。search 的 JSON 不带 updated 字段，所以靠 JQL 的时间窗 + 二次查询 |
| 手动 | app 输入框，或 `sidekick add "<文字或链接>"` | 无 | 一期测试主要靠它 |

**实时：`slackcli listen`**（2026-11-13，2026-11-16 改成可选）。开了实时模式时，daemon 常驻一个 `slackcli listen` 子进程。listen 连的是 Slack 网页版自己用的事件 websocket，移植自 slk（github.com/luoxiu/slk），已推到我的 fork lilong7676/slackcli 的 `feat/listen` 分支。sidekick 在 package.json 里把 slackcli 锁到这个分支上的一个 commit（具体是哪个以 package.json 为准），daemon 和 agent 都通过 `bin/slackcli` 调用这一份，不依赖机器上装的版本，方便同事装。

- **触发**：别人私信我、或 @ 我的新消息一到，去抖 2 秒后立刻跑一次采集，把 daemon 主循环提前唤醒。断线重连后补采一次。轮询（`pollMinutes`）保留，兜底用。
- **实测**：一条真实私信从发出到任务开始处理约 20 秒，原来最长 5 分钟。其中约 17 秒耗在 `conversations unread` 上。以后可以直接拿 socket 推来的消息建任务，能压到几秒。
- **坑：`agent_version` 必须是一个 Slack 认可的网页版构建号。** 留空时，网关接受升级之后一个字节都不发；填了不认识的值，网关回 `force_reload`。listen 默认带 slk 实测可用的那个值，并可以用 `--agent-version` 覆盖。哪天 Slack 不再认这个值，`disconnected` 里会写明 force_reload。
- **默认关，在设置里开**（2026-11-16）。socket 不是官方接口，Slack 一改版就可能失效，所以推广时让每个人自己决定。打开时面板先讲清楚这一点，确认后才生效。轮询一直在跑，不受开关影响；轮询间隔也能在设置里改（1–60 分钟，留空跟 profile 走），两项都不用重启 daemon。
- **自动回退**（`src/realtime.ts`）：出现下面任一情况，就停掉 listen，只靠轮询，15 分钟后再试，并弹一次本机通知。重试又失败不会再通知；重连后稳定 10 分钟，才算一轮新的。
  - 10 分钟内，已经连上的连接断了 3 次。重连失败不算断线：网络抖一下时 listen 会在 1、2、4 秒后重试，这几次不计入。
  - 3 分钟一直没连上（刚启动时，或断线后）。
  - 登录失效（listen 退出码 2）或 `force_reload`（Slack 不再认 listen 带的网页版版本号）。这两种重连也没用，立刻回退。
- 面板顶部显示「实时 / 连接中 / 已回退轮询 / 轮询」；设置页「Slack 连接」有实时状态、回退原因、下次重试时间、上次采集结果和下次采集时间，回退时可以点「现在重试实时」。
- **所有 slackcli 调用都是异步进程**（2026-11-13）。原来同步调用时，一次采集（约 18 秒，几乎都花在 `conversations unread --messages` 上）会卡住整个 daemon。改成异步后实测，采集期间面板接口最慢 31 毫秒；实时监听从启动到连上也从 19 秒降到 1 秒。
- **安全评审已通过**（2026-11-16，使用者告知，会话 299d615c）：继续用浏览器登录态和网页版内部接口（未读、草稿、实时 socket）。Slack 访问都收在 `slack.ts` 和 `listener.ts` 两个文件里，哪天要换成官方 Slack App（用户授权 xoxp + Socket Mode + Web API），只动这两处。

**原地派活：在 Slack 消息上点一个约定的 emoji。** 不用改 slackcli，slackcli 0.19.1 已实测通过：

1. 用 `slackcli search messages "has::<emoji>: after:<上次>" --json` 找出带这个 reaction 的消息。
2. 再用 `slackcli conversations get <channel> <ts> --json` 读这条消息，`reactions[].users` 里有我才算数，别人点的不算。
3. 通过的消息建成任务，来源记为 `slack`，种类记为 `dispatch`。

emoji 选一个工作区里很少有人用的，最好是自定义的。Slack 搜索有索引延迟，派活后几分钟内才能被拉到，对 5 分钟一轮的轮询够用。

**降噪在源这一层做。** 每拉起一次 claude 都有固定开销（加载 CLAUDE.md、skill），所以先用规则过滤、合批，agent 只看过滤后剩下的。

## 5. 路由、关联、唤醒

**一件事一个任务。** 事件进来先提取关联键：

- Jira key：`[A-Z][A-Z0-9]+-\d+`
- GitHub：issue / PR 链接
- Slack：permalink，或 channel + thread_ts

关联键命中一个未结束的任务，就把事件挂到这个任务上，不新建。之后分三种情况：

- 任务在 `waiting`：唤醒。
- 任务在 `running`：排队，这一轮结束后带上这个事件再跑一轮。
- 已结束：挂进时间线，并通知我，不自动重开。

没命中就按路由表新建任务。agent 可以通过 `sidekick.link` 往任务上加关联键，比如自己开出 PR 之后把 PR 链接挂上来。

**Slack：每条私信 / @ 我直接交给 agent 处理，不分段。** 已定（2026-11-13）。

| 步 | 谁来做 | 做什么 |
|---|---|---|
| 采集 | daemon 代码 | 只收私信我和 @ 我（见 §4），去重；同一对话的新消息并进这个对话的任务，接着原会话处理（规则见下） |
| 处理 | Opus 5.5，`--effort medium`，一个任务一个会话 | 先判断要不要回；要回就读上下文、查证据、起草，产出草稿和对外动作提案，交给我审批。不用回的一两步就 `report no_reply` |

**同一对话一个任务、一个会话**（2026-11-16 定，会话 299d615c；`intake.ts` 的 `findJoinableTask`）。新消息看这个对话（同一个 thread，或同一个私信里不在 thread 的消息）最近的那个任务：还在排队或运行，直接并进去；已经待审批、要我处理或结束了，只要最后一次动静在时间窗内，也并进去、重新排队，接着原来的 Claude 会话；已取消或失败的不并。时间窗在 app 设置里改，默认 thread 不限时（一个 thread 就是一个话题），私信 2 小时（私信不分话题，隔久了多半是另一件事，接着旧会话反而带进过期的结论，缓存失效后也更贵）。依据：账本里 59% 的 Slack 任务落在同一对话的多个任务里，Bin 的私信 2 小时开了 9 个会话，连发里相邻两条最长隔 95 分钟。并进来时如果上一轮的回复还在等审批，agent 带着新消息重新判断：要改就重新提议，新卡替换旧卡、删掉旧草稿；不用改就保留旧卡。

为什么不再分两段：最初分「haiku 合批判断 → Opus 处理」，是因为「我参与的 thread 有新回复」这类消息量大、大多不用管（ADR 0003 ⑥）。只收私信和 @ 我之后，按历史账本重算：

- 每天约 7 条，其中 56% 我后来回了。
- haiku 只能筛掉三分之一（问卷、通知、收尾），而且漏了我实际回过的 5 条。
- Opus 每次实测平均 $0.51、38 秒。合成一段每天约多 $1（按 API 价折算），换来零漏判，还删掉了合批、短序号、重问这一整套。

- **不在原消息上加 reaction**（2026-11-16 决定，会话 299d615c）。之前 agent 判定要回或要我看时，daemon 会以我的账号加一个专用表情表示「处理中」，是唯一不经审批的对外动作。已去掉：Slack 上不留任何标记，进度只在 sidekick 里看。agent 本来就拿不到 react 权限，这条不变。
- **重放和重试时，不让 agent 看到旧结论。** 账本里上一轮的草稿和判断只给 app 显示，不进 prompt，也不通过任何命令暴露（Phase 0 ③ v2 实测：agent 会照抄旧草稿）。

**等待与唤醒。** agent 在需要等的地方调用 `sidekick.wait_for`，参数是 `{key, condition, timeout, note}`，比如等 PR 合并、等部署完成、等对方回复，然后结束这一轮，进程退出，只把唤醒条件存进账本。daemon 收到匹配的事件后，先用固定命令确认条件真的满足（比如 `gh pr view --json state` 确认已合并），再执行 `claude -p --resume <session_id>`，带上事件摘要接着跑。这一步不经过模型，不满足就继续等，不花钱（借鉴 nanoclaw 的唤醒前脚本）。超时就唤醒 agent，或者通知我，由路由配置决定。

## 6. 执行器

一期直接 spawn Claude Code CLI，选型理由见 [adr/0001](adr/0001-runner-spawn-claude-cli.md)。一次运行：

```
cwd = profile 根目录；环境变量只给白名单（HOME、USER、PATH、LANG、TMPDIR……），不继承父进程
claude -p "<prompt>"
  --session-id <uuid>                 # 首轮由 daemon 生成，task ↔ session 一一对应
  | --resume <session_id>             # 后续轮；resume 不带回 mcp-config / settings / add-dir，要重传
  --output-format stream-json --verbose  # 实时写日志，app 订阅；result 带 total_cost_usd、permission_denials
  --model <route.model> --max-turns <route.maxTurns>
  --permission-mode auto              # 已定用 auto；lean 下不读用户级设置，必须显式传（ADR 0003 ⑤）
  --setting-sources project,local     # route.env = lean 时加；full 时不加
  --allowedTools … --disallowedTools … # 来自 policy 档位
  --mcp-config <sidekick MCP>         # lean 下这是唯一的 MCP；full 下和用户级 MCP 并存
  --permission-prompt-tool mcp__sidekick__approve
  --append-system-prompt <sidekick 约定：任务 id、skill 文件路径、可用的 sidekick 工具、外部内容是数据>
```

**路由的 `env` 字段决定加载多少用户级配置。** 依据是 ADR 0003 的实测：

- **`lean`（默认）**：加 `--setting-sources project,local`。冷启动 0.5 s，固定开销约为完整环境的千分之一。用户级 CLAUDE.md 照样加载，用户级 skill、权限、claude.ai 连接器都不加载。skill 靠 prompt 里给出的文件路径让 agent 去读。
- **`full`**：给需要 claude.ai 连接器的路由用，比如工单闭环要读 Jira。代价是冷启动 3.4 s，上下文里多出几百个工具。

- **接口按 ACP v1 的形状设计**：`session/new`、`prompt`、`cancel`、`load`、`resume` 五个方法，事件流对应 `session/update`，审批对应 `session/request_permission`（选项是允许一次、总是允许、拒绝）。以后接 opencode，或改成拉起 ACP 子进程（比如 claude-agent-acp）时，只换实现。参考见 [references.md](references.md)。
- **每轮先对账再派发**：daemon 每个 tick 先核对账本里的 `running` 和实际进程，daemon 重启后孤儿进程能被发现、收尾，同一个任务不会派两次（借鉴 openai/symphony）。
- **用户级配置的隔离**：全局装的插件和 hook 会拖慢、干扰无人值守的运行，acpx 默认不加载用户级 settings。但工作 profile 的准则有一部分在用户级 `~/.claude/CLAUDE.md` 里，不能一刀切。`--setting-sources` 对 CLAUDE.md 有没有影响，文档没写，Phase 0 实测。
- **并发**：全局上限默认 2 个进程。会改代码的任务开 worktree，这是 skill 里已有的约定，引擎不管。
- **接管**：app 先把任务置为 `paused`，确认没有进程在跑，再在 Terminal 里打开同一套参数的 `claude --resume <id>`。`-p` 跑出的会话可以这样打开（见 sessions 文档）。我退出终端后，点「交还」，daemon 回到 `queued`。
- **在 Claude Code 里继续**（2026-11-17，使用者提出，会话 299d615c；`queries.ts` 的 `continueInClaude`）：sidekick 处理完我还想接着做，就在任务详情点它，任何有会话、不在运行的任务都有，包括已结束的。用我自己的 Claude Code 权限，不挂 sidekick 的工具，不暂停任务，也不用交还（要交还的是「接管」）。打开方式在设置里选：
  - 终端（默认）：`claude --resume <id> --fork-session -n "sidekick：标题"`，从 sidekick 的会话分叉出新会话，两边不会写同一个会话文件。命令由 Swift 用会话 ID 拼，页面只能传 ID、目录和名字。
  - Claude 桌面 app：`claude --desktop --resume <id>`。实测它不能和 `--fork-session`、`-n` 一起用，输出也不能被重定向（daemon 用 `script` 给它一个伪终端），所以打开的是 sidekick 的原会话；同时记下 `handed_off_at`，这个任务再跑时 sidekick 另开会话（`handle.ts` 的 `sessionFor`），不和我抢。
- **超时和失败**：单轮有超时上限。没有进展的连续三次标 `failed`，沿用 slack-inbox 的做法。

## 7. 审批

审批有两类，都由我在 app 里点。

**① 运行中的权限请求。** auto 模式下，只有命中 `ask` 规则（「我说一句」档）的调用会交给 `mcp__sidekick__approve`，app 弹一张卡。其余的由 auto 分类器放行，或者被 deny 规则拦下。

- 在电脑前：几分钟内点掉，agent 原地继续。
- 不在电脑前：等待超过阈值后，审批工具返回 deny，附一句「已提交审批，本轮先停」，任务转为 `needs_approval`。我批准后用 resume 接着跑。

这样不会有进程挂几个小时，daemon 重启也不丢。待审批的请求一律存进账本。实测结果见 ADR 0003：

- **怎么发现被拒**：被拒的那一轮会正常结束，被拒的调用列在 `result.permission_denials` 里。daemon 据此把任务转为 `needs_approval`。
- **resume 后要自动放行**：resume 后 agent 会把同一个调用再请求一次。审批工具发现它和已批准的调用一致（tool_name 和 input 都相同），就直接放行，不让我批两次。
- **还在等审批的调用，再请求就立刻拒**：被拒后，模型有时会马上重试同一个调用。审批工具发现它就是那张还没批的卡，立刻再拒，不重新计时，也不多出一张卡。
- **在电脑前要等多久**：CLI 至少能等 30 分钟，不会自己掐断（Phase 0 实测），阈值按我的习惯定，先设 5 分钟。
- **变体写法交给 `sidekick guard`（PreToolUse hook）。** 已实现（ADR 0003 ⑦）。规则按前缀匹配，`git -C 目录 push` 会漏过 `Bash(git push:*)`，规则中间的通配符也不生效。guard 把命令拆段、去掉包装和 git 全局参数，再对照 ask 和 deny 判断。下面这条原计划里的「审批工具拆命令」改由 guard 来做。
- **审批工具先过一道确定性规则，再决定要不要出卡。** Claude Code 的 allow 规则按命令前缀匹配，agent 却习惯写 `cd 仓库 && gh pr view …`，这种组合命令匹配不上，就会落到审批工具这里（Phase 0 ③ 实测踩到）。审批工具的处理：
  1. 把命令按 `&&`、`;`、`|` 拆开，逐段对照 profile policy。
  2. 每段都是只读的，就自动放行。
  3. 有一段命中 deny，就直接拒绝。
  4. 其余的才出卡。

  这样分诊档不用 `--permission-prompts none` 一刀切，也不会把每条 `cd && git log` 都推给我。

卡片上有三个选项，和 ACP 一致：

- **允许一次**。
- **总是允许**：生成一条对 profile policy 的修改，我确认后写进 `profile.yaml`。不直接改 Claude 的 settings，规则都留在 profile 一处。
- **拒绝**：可以附一句理由回给 agent。

**② 对外动作提案。** 所有对外动作，agent 都不能自己执行：

- agent 只能调 `sidekick.propose`，参数是 `{kind, target, payload, reason, evidence}`，生成一张卡。
- 我批准后，**由 daemon 用固定命令执行**，不经过 agent：

| kind | 执行命令 |
|---|---|
| slack.send | agent 先用 `slackcli messages draft` 建草稿，批准后执行 `slackcli messages send-draft <id>`，拒绝则 `delete-draft` |
| jira.comment / jira.transition | `acli` |
| github.comment / github.merge | `gh` |

- 卡片里能改文字再批准。
- **审批卡和 Slack 草稿是两个对等的入口，哪边先动以哪边为准**（2026-11-16，会话 299d615c；`approvals.ts` 的 `reconcileDrafts`）。草稿从 Slack 的草稿列表里消失（list-drafts 不列已发、已删的），就看那个对话或 thread 里卡片建出来之后有没有我发的消息：有，算我在 Slack 里发了（改过也算），卡结成「你在 Slack 里发出了」，记下实际发出的文字，任务结成已回复；没有，算我删了草稿，卡关掉，任务结成不回，不重新起草。每轮采集后核对一次；实时模式下我在有待审批卡的对话里一发消息，3 秒后就核对。在 sidekick 里点批准前也先核对：已在 Slack 发过就不再发；草稿被删了但这里批准了，以后一个决定为准，把正文直接发出去。没用草稿、另外手打回复的情况（草稿还在）不自动处理，免得误判。
- 这些命令同时写进 agent 的 `--disallowedTools`，agent 直接调用会被拦下。

**agent 不能批准自己的请求。** 决定接口只在本地 API 上，agent 能碰到的 MCP 工具只有「创建」，没有「决定」。

## 8. app

- **菜单栏**：图标上的角标是待审批数。下拉里是待审批、运行中、等待中、最近完成，外加一个派活输入框（一句话或一个链接）。
- **窗口**：
  - 任务列表：可按状态、来源筛选。
  - 任务详情：一条时间线，按时间排列事件、每轮运行、审批卡。
  - 实时日志：渲染 stream-json，显示 assistant 文本、工具调用、结果。
  - 操作：批准 / 改后批准 / 拒绝、重试、取消、接管、关闭。
- **通知**：中断级（DM、@我、待审批）弹系统通知，其余攒成摘要（沿用 slack-inbox 的 12:30 / 18:30）。
- **手机上：Slack 给自己发提醒。** 不在电脑前时也能看到有事，但审批仍然回到电脑上做。
  - 只有 daemon 的通知模块会发，用 `slackcli messages send` 发到我和自己的 DM。agent 的 `messages send` 照样是 deny。
  - 发之前在代码里校验目标就是我自己的 DM（channel id 由 `auth whoami` 推出），不是就拒发。
  - 只发待审批、中断级事件、任务失败这三类。一条一行：谁、什么事、任务链接。同一个任务 10 分钟内只发一次。
  - 我在电脑前时不发：app 处于前台，或者最近几分钟有操作，就只弹系统通知。
- **设置**（2026-11-13，面板右上角「设置」，存在 `~/.config/sidekick/settings.json`，不改工作区里的 profile.yaml）：
  - 托管模式：半托管（默认）回复都要我批；全托管下 agent 提交回复时直接批准，跑完就发出，每条私信我一份，顶部一直挂「全托管中」。切换前已在等的回复仍然等我。agent 的 prompt 里会写明全托管，门槛更高，拿不准就交给我。
  - **定时全托管**（2026-11-17，使用者提出，会话 299d615c；`settings.ts` 的 `effectiveMode`）：比如午休 12:00–13:30 自动全托管，其他时间半托管。可以设多个时段，默认只在工作日，可选周末。手动选了全托管就一直是全托管，时段不起作用。按时间表切换时，按通知设置发 macOS 通知和 Slack 私信；手动切换不提醒。顶部显示「全托管中（到 13:30）」。
  - **回复带署名行**（2026-11-17，使用者确认，会话 299d615c；`approvals.ts` 的 `replyBlocks`）：sidekick 发出的回复上面加一个 Block Kit 的 context 块（灰色小字），英文固定写法：我批准的「:speaking_head_in_silhouette: Drafted by sidekick · approved by me」，全托管自动发出的「… Auto-reply by sidekick · not yet reviewed by me」，让对方知道是助手起草的、我看没看过。消息的 `text` 只放正文，推送预览就是正文。草稿只能是纯文本，所以签名时不再发草稿，而是删掉草稿、带 blocks 直接发；我在 Slack 里自己发草稿的不带署名。正文超过 3000 字按换行拆成几个 section。设置里可以关。参考的是同事助手的做法（普通消息 + context 块，Slack 没有专门的「助手确认」功能）。
  - **一轮按开始时的模式跑完**：这一轮的系统提示和「回复要不要直接发」都看它开始时的模式（`SIDEKICK_MODE` 传给 MCP）。之前「直接发」是在提交那一刻读设置，按半托管规则起草的回复，遇上中途切到全托管就会不经审批发出；定时切换让这件事每天都会碰到，所以一并改了。
  - 模型和 effort：派活和 Slack 任务共用一组，留空跟 profile 走，下一个任务生效。
  - 工作区目录：写进 `~/.config/sidekick/config.yaml`，目录下必须有 `sidekick/profile.yaml`，重启 daemon 生效。
  - 重启 daemon：设置页里一个按钮（daemon 自己退出，launchd 拉起），菜单栏右键也有一项（`launchctl kickstart`，daemon 卡住时也能用）。
  - Slack 连接（2026-11-16）：实时模式开关、轮询间隔，见 §4。
- **分身**（2026-11-16，`src/persona.ts`，面板顶部「✎ 分身」）：分身是使用者自己写的 Markdown，写他是谁、负责什么、怎么说话、哪些事不能替他答应。
  - 存放：在工作区里，路径列在 profile 的 `persona` 里，默认 `sidekick/me.md`。工作区里已经有成型的分身资料（决策模型、角色说明）的，直接把那几个文件列进去，面板里就能改。
  - 生效：每次运行都把分身放进 agent 的系统提示（`--append-system-prompt`），不靠 skill 让它去读，所以跳不过去。保存后，下一个任务就用上。只有模板、没写内容的不放进去。
  - 编辑：面板里是带模板的 Markdown 编辑器，⌘S 保存。只能写 profile 列出的文件。文件在别处改过（编辑器、git），保存会被拒绝，让你先重新加载，不会覆盖别人的修改。模板在 `templates/me.md`，不含任何公司信息。
  - **交给自己的 agent 写**（2026-11-16，使用者提出，会话 299d615c；`persona.ts` 的 `refinePrompt`）：没人会手写分身，所以分身页有「复制 prompt」。复制出来的 prompt 写明分身文件的绝对路径和现状、每一节写什么、怎么做（先读、能查的先查、一次只问一个问题、改完给使用者看过再保存），并附上账本里最近 20 条使用者改过或拒绝过的回复（在 Slack 里改了再发、在 sidekick 里改了再批、拒绝及意见、在 Slack 里删了草稿）当依据。贴给本机的 Claude Code 或别的 agent 即可。复制先用同步的 `execCommand`，再退到异步剪贴板接口：内置浏览器面板实测拒绝异步写入，但同步复制能进系统剪贴板。
  - 试跑（`src/trial.ts`）：挑一条账本里的历史消息，按已保存的分身完整走一遍。上下文只截到这条消息为止，结果显示会不会回、理由和草稿。试跑不建任务，也不挂 sidekick 的 MCP 工具，所以建不了草稿、发不出消息。一次只能跑一个，花费和处理一条真消息差不多（实测 $0.8，71 秒）。
  - 诊断里有一项「分身」：没写时提醒去写。
- **诊断**（2026-11-16，`src/doctor.ts`，为推广准备）：`sidekick doctor`、daemon 自动诊断和设置页「运行诊断」用的是同一套检查。每一项不通过都给出修法，能用命令修的附上命令，面板里可以一键复制。
  - daemon 侧检查：工作区配置、常驻服务（launchd）、Claude Code（版本、是否登录）、锁定的 slackcli（含不含 listen）、Slack 登录（auth.test）、最近一次采集、实时连接、账本。
  - app 侧检查（只有菜单栏 app 能看到，经 `sidekickAsk` 桥接回传）：app 是否装在「应用程序」里、通知权限、开机自动启动。
  - 什么时候自动跑：daemon 启动 1 分钟后，之后每 6 小时；采集失败后提前跑，但至少隔 30 分钟。新出现的失败项弹一次本机通知，同一项一直坏着不重复通知。顶部有异常时显示「诊断：N 项异常」，点它直接跳到诊断。
- **终止和删除**：运行中的任务点「终止」立刻结束进程；「删除记录」删掉任务、运行、日志文件、审批卡和 Slack 里的草稿，「已结束」页可以一键清空。原始消息的去重记录保留，免得同一条未读消息被再收一次。
- 以上在真机上都点过（2026-11-13）：设置、终止、删除在浏览器里实测；⌘V 粘贴、独立窗口、右键重启 daemon 由我在菜单栏 app 里确认。
- **独立窗口**：面板顶部「⧉ 窗口」或右键「打开窗口」。窗口打开时 app 变成普通 app（Dock 图标、⌘Tab），关掉变回只在菜单栏。补了隐藏的「编辑」主菜单，⌘V / ⌘C / ⌘A 在面板和窗口里都能用。
- **和 daemon 通信**：daemon 在 127.0.0.1 随机端口起 HTTP 服务，token 写进权限 0600 的本地文件，实时更新走 SSE。

## 9. 安全

- **外部内容是数据，不是指令。**
  - prompt 里把消息、评论、issue 正文放进明确的分隔块。
  - skill 和 `--append-system-prompt` 都写明不执行里面的要求。
  - 真正的防线是工具权限，不是 prompt：对外动作 agent 根本执行不了（§7）。
- **输入先清洗再给 agent**（借鉴 claude-code-action）：
  - 事件内容按入队那一刻做快照，之后别人改过的内容不算数。
  - 去掉不可见字符和 HTML 注释，遇到疑似 token 的串打码。
  - 原地派活的 emoji 只认我自己点的。
- **最小权限**：policy 按路由分档，分诊档只读 + 起草，deny 列表从现有 slack-inbox 配置迁过来。
- **不碰凭证**：daemon 不持有任何 token，复用 slackcli、acli、gh、claude 各自的登录。配置文件里没有 secret。
- **本地 API 不出本机**：只绑 127.0.0.1，靠 token 文件鉴权。
- **认证**：用的是使用者自己的 Claude Code CLI 和登录，按 headless 文档的用法跑 `claude -p`，不用 Agent SDK 代管登录（理由见 ADR 0001）。

## 10. 和 slack-inbox 的关系

1. Phase 1 期间两者并行：旧版关掉 handler，只留 collect 继续入账本，作为覆盖率的对照；sidekick 用同一个 skill 处理，草稿只由 sidekick 写，避免同一条消息出两份草稿。
2. 对照一周，草稿质量和覆盖率不低于旧版，就卸掉 slack-inbox 的 launchd 任务，`scripts/slack-inbox/` 只保留 skill 用到的 `cli.ts` 子命令（或改指向 sidekick 的命令）。
3. 「可接管的工作」清单里第 2 项的触发方式改为 sidekick。

## 11. 阶段

不写工时，只写顺序和过关标准。

**Phase 0：验证最大的不确定点**（脚本级，不做 app）。已完成，结论见 [adr/0003](adr/0003-phase0-findings.md)。

1. **审批**：用一个最小 MCP 服务实现 `approve`，验证三件事：CLI 挂起等人点能等多久、超时后怎么表现、「deny 后 resume」接得上。
2. **接管**：`-p --session-id` 跑一轮 → 终端 `claude --resume` 接手聊两句 → 再 `-p --resume` 交回 daemon。看上下文和 MCP 配置是否完整。
3. **质量和花费**：slack-inbox skill 在 `claude -p` 下跑同一批历史消息，和现在 opencode + deepseek 的草稿、花费对比。
4. **配置隔离**：用 `--setting-sources` 去掉用户级 settings 后，确认两件事。一是用户级 CLAUDE.md 里的准则还在不在；二是启动时间和稳定性有没有改善。

过关标准：四项都有实测结论，写进 ADR。①不通就改成「只做 ② 提案式审批」。

**Phase 1：daemon MVP**

- 内容：账本、profile 加载、Slack 源、手动派活（CLI）、执行器、两类审批（先做 CLI 版 `sidekick approvals`）、日志。
- 过关：并行对照一周，Slack 队列全部由 sidekick 处理，草稿都能经审批发出。
- 进度（2026-11-13）：

  | 项 | 状态 |
  |---|---|
  | 代码 | 已写完：Slack 三段、手动派活、执行器、MCP 审批、guard、通知、daemon、CLI、launchd 脚本。单测 28 个 |
  | 已在真实环境验证 | 手动任务端到端；工具审批端到端（出卡 → `sidekick approve` → 原地继续）；在我自己的 DM 里实测了四个 Slack 写操作（给自己发提醒、加 reaction、建草稿再删、建草稿再发）；guard 拦截 |
  | 还差 | 装 launchd 常驻后，等真实新消息走完一遍处理 → reaction → 审批 → 发出，然后对照一周 |
- 不在这一期：原地派活的 emoji、app、GitHub 和 Jira 源、等待和唤醒。
- 采集只看**未读**。我在 Slack 里先看过的消息，sidekick 不会再处理。这条沿用 slack-inbox 的做法：我自己看过的，我自己处理。

**Phase 2：app**

- 内容：菜单栏、窗口、通知、接管。
- 过关：日常不开终端，就能处理完队列。
- 形态（2026-11-13 定）：Swift 菜单栏薄壳 + WKWebView，界面用网页写，由 daemon 在本机提供。
  - 原生只做网页做不了的：菜单栏角标、带「批准 / 拒绝…」按钮的系统通知、接管时开 Terminal、开机自启。
  - 网页（Preact，Bun 自带打包，不用 Vite）负责：任务列表、详情时间线、实时日志、审批卡（可改正文、拒绝带意见）、派活框。
  - 本机 API 只绑 127.0.0.1，校验 Host 头；token 在 `~/.config/sidekick/runtime.json`（0600），由 app 注入网页，不进 URL。
- 进度（2026-11-13）：

  | 项 | 状态 |
  |---|---|
  | daemon API + SSE | 已写完，带 6 个鉴权测试 |
  | 网页 | 已写完。在浏览器里端到端验过：派活 → 实时日志 → 审批卡点批准 → 原地继续 → 完成 |
  | Swift 壳 | 编译、打包（ad-hoc 签名）、启动、连上 daemon 都已验证 |
  | 真机点过 | 菜单栏面板；在系统通知上直接点批准（`approved (inline)`，推送落地）；面板里「在终端接管」打开 Terminal，聊一句后交还，同一份 transcript 里依次是 daemon 一轮 → 终端一轮 → daemon 续跑 |
  | 还差 | 装正式常驻（launchd，开 Slack），用真实消息对照一周 |
- app 打开时，daemon 不再弹 osascript 通知（60 秒内有 app 请求就跳过），由 app 发带按钮的通知；Slack 自提醒照发。

**Phase 3：GitHub、Jira 源，关联与唤醒**

- 过关是一条完整的链：
  1. Jira 上指派一张单，工单闭环自动跑到「等 PR 合并」。
  2. 合并事件把任务唤醒，接着跑到部署验证。
  3. 最后给出 Jira 流转和 Slack 回复两张审批卡。

**Phase 4：推广准备**（2026-11-16 起）

- 已做：
  - 诊断（`doctor`）、实时模式开关和自动回退、可调的轮询间隔，见 §4、§8。
  - 分身编辑和试跑，见 §8。
  - **单个 app**：daemon（`src/cli.ts`）和锁定的 slackcli 各用 `bun build --compile` 编成单文件，装进 Sidekick.app。同事只要装好 Claude Code，不用装 bun，也不用 clone 本仓。
    - app 启动时把 daemon 写成 `~/Library/LaunchAgents/local.sidekick.daemon.plist`（指向 app 里的二进制），用 `launchctl bootstrap` 加载，取代原来的 `scripts/install.sh`（已删）。升级后 `launchctl kickstart -k`，十几秒换上新二进制（实测换了哈希不同的二进制）。
    - **不用 SMAppService**（2026-11-16 决定，会话 299d615c）。先用过 `SMAppService.agent`，升级时出问题：后台项目管理（BTM）记下 daemon 的代码要求，ad-hoc 签名时就是二进制哈希，换了二进制 launchd 就以 OS_REASON_CODESIGNING 拒绝；launchd 自己的修复因为没有 Team ID 取不到新的。重新注册有时第二次能换上，有时任务会丢掉和 app 的关联（「not a bundle」），之后怎么注册、kickstart 都起不来。本机一天五次升级里两次卡住：一次停了 4 分半，一次一直起不来，最后手动换成 LaunchAgent 才恢复。普通 LaunchAgent 没有这层钉住。有了 Developer ID 才能回到 SMAppService。
    - 判断「升级了」靠比较 daemon 二进制的修改时间，不比先后：Release 包里是 CI 构建的时间，可能早于本机 daemon 的启动。拿早于启动时间的新二进制实测过。
    - agent 的 PATH 里只有 slackcli 的目录，没有 sidekick 本身；引擎再加一条 `Bash(sidekick:*)` 的 deny，guard 按文件名匹配，绝对路径调用也拦得住（实测），agent 没法替自己批审批卡。
  - **发布流程**：版本号只写在 `package.json`，app 的 Info.plist 和 daemon 都从它取，面板和诊断里能看到。推 `v<版本>` tag 后，GitHub Actions（macos-15）核对 tag 和版本、跑类型检查和测试、`make -C app zip`，把 `Sidekick-v<版本>.zip` 和 `.sha256` 挂到 Release，带 `-` 的版本标预发布；手动运行只构建不发布。只出 Apple 芯片版本。测试在空 HOME 下全过；workflow 还没在 GitHub 上跑过。
  - **首次设置**：没有配置时，daemon 只开面板的「开始用 sidekick」页，不再反复崩溃重启。选一个文件夹后，没有 profile 的按 `templates/` 建好 profile、通用 Slack 流程和分身模板，再重启进入正常模式。用临时 HOME 实测过整条流程。
- 推广前的易用性（2026-11-17，使用者确认，会话 299d615c）：
  - 一行安装：`scripts/install.sh`，curl 下载最新 Release（含 beta）、校验 sha256、替换 /Applications/Sidekick.app 并打开；再跑一遍就是升级。curl 下载的文件不带隔离标记，不用再手动放行。daemon 每 6 小时查一次 GitHub Releases（`update.ts`），有新版面板顶部提示，菜单栏 app 里点「升级」就在终端跑这行命令（命令写死在 Swift 里）。仓库公开前查不到，提示不出现。
  - 面板里登录 Slack（`slacklogin.ts`）：daemon 跑 `slackcli auth login-auto`，打开浏览器等登录；成功后清掉缓存的账号、重连实时、马上诊断一次。设置的 Slack 组和诊断里失败的「Slack 登录」都有按钮。
  - 手机上的提醒：私信给自己的提醒不再写 `sidekick approvals`，改成「草稿已经在这个对话的输入框里，点链接过去发出或删掉」。
  - 通知开关挪进设置：macOS 通知、Slack 私信提醒；菜单栏 app 自己弹的通知也照这个开关。
  - 处理前过滤（`intake.ts`，在启动 agent 前判断，不花钱）：不处理某些人的消息、某些频道里的 @，命中的照样建任务、直接结成「按规则跳过」，可以「仍然处理」；下班时间只收不处理，任务记下 `not_before`，到上班时间再跑，可以「现在处理」。我在面板里的操作不受下班时间限制。
  - 首次设置清单：主页「开始用 sidekick」，按诊断结果打勾（登录 Slack、写分身、允许通知），都过了就不再出现。
  - README 截图：`docs/images/`，用假数据和临时 HOME 拍，不含公司信息。
- 终端桥接不再收命令字符串（2026-11-17，会话 299d615c）：「接管」原来把拼好的命令交给菜单栏 app，app 只检查开头是不是 `claude --resume`，面板页面被攻破时可以在后面接 `; 其他命令`。现在 daemon 给参数列表，`WebPanel.swift` 检查头两个是 `--resume <会话 ID>`，再逐个加引号拼命令；「在 Claude Code 里继续」和「升级」本来就是这样。页面再也传不进可执行的字符串。
- 公司包（2026-11-17 定方向）：公司已有内部的 Claude Code 插件市场（每个 skill 一个插件）。sidekick 跑任务时只读工作区设置（`--setting-sources project,local`），同事装的插件进不了运行，所以公司包做成给同事自己用的 sidekick 插件，放在公司那边：装好或升级 sidekick、把公司统一的 deny 规则和按公司工具调过的 Slack 流程写进工作区、陪着写分身。等本仓公开（安装脚本才能下载）后再提，草稿先给使用者看。本仓不写公司仓库和内部插件的名字。
- 提效（2026-11-18，使用者提出，会话 47b9cf72）。依据是 11-13 起的账本和运行日志：
  - 同一对话的追问：每条都重跑、接着同一个会话，越跑越贵（「好了」「欧克」「那你发吧」「hao wo kankan」四次 $0.43 → $1.89）。现在等对话停一分钟再跑，连着几条合成一次；已处理完的对话里的收尾话（好了、欧克、哈哈、emoji）只记下、不重跑（`intake.ts`）。
  - 每次运行只装需要的（`handle.ts` ToolSet）：原来带着 Claude Code 全部内置工具和 75 个 claude.ai 连接器，一轮 65.7k token；57/84 次运行先花一轮 ToolSearch 找 sidekick 自己的工具，约一半花一轮 `cat SKILL.md`。现在默认只给 Bash、Read、Grep、Glob 和 sidekick 的工具，一轮 33k；消息里有 Slack、GitHub 以外的链接才带连接器；skill 和分身一样放进系统提示。会话只升不降。同两条历史消息试跑：$0.43 → $0.23，$0.87 → $0.19。工作区的 CLAUDE.md 留着（约 9k，agent 找仓库靠它）。
  - PR：team btp、team lemonade 的人发 PR 来直接 approve，回「已 approve ✅」不经审批（profile 的 `autoReply`，代码判断发信人和原文，`mcp.ts`）；其他人的快速 review 后 approve。规则写在工作区的决策模型里。
  - 要我拍板的事：起草 2–3 条候选回复（`propose` 的 `options`），我在审批卡上挑一条发；带候选的永远等我批，全托管也不例外。
  - 「在 Claude 里继续」（原名在 Claude Code 里继续）也在通知上；我在 Slack 里删掉草稿时，弹一条通知给这个按钮。
  - 只在重试 API 的运行（断网、睡眠）5 分钟就停，10 分钟后再跑，不算失败；原来要等满 40 分钟超时，还连试三次。
  - 派活时带 Slack 消息链接，任务挂到那个对话上，回复走审批卡发进那个 thread。
- 还没做：
  - 公司包的 PR（见上一条）。
  - 开发者签名：没有签名，「登录项」里显示的是 sidekick 这个可执行文件而不是 Sidekick.app。有了 Developer ID 和公证才能回到 SMAppService，Gatekeeper 也不用担心。
  - 花费上限：每天超过多少就只收不处理。
- 个人 profile 放进二期。

## 12. 待你拍板

已定（2026-11-13）：

- **Slack 原地派活**：用专用 emoji，实现见 §4。
- **手机上**：Slack 给自己发提醒，见 §8。
- **名字**：sidekick（搭档、小跟班），工作名 deputy 太正式。
- **权限模式用 auto**：三档授权落到 auto 分类器、ask 规则、deny 规则上，见 §2。
- **工具权限交给 auto**：工作 profile 不加 ask 规则，只留 deny，见 §2。
- **Slack 不分段**：每条私信 / @ 我直接交给 Opus 5.5 medium 处理，见 §5。
- **Slack 只收私信和 @ 我**：thread 里其他人的回复先不管，见 §4。
- **推广时仓库公开**（2026-11-16，会话 299d615c）：本仓不含公司信息即可公开；公司统一的东西做成公司包，放进公司 org。
- **Slack 上不加 reaction**（2026-11-16，会话 299d615c）：处理中不在原消息上留标记，见 §5。
- **同一对话一个任务、一个会话**（2026-11-16，会话 299d615c）：时间窗可设，默认 thread 不限时、私信 2 小时，见 §5。
- **做成单个 app**（2026-11-16，会话 299d615c）：安全评审通过后，安装方式只剩 Sidekick.app，见 §11 Phase 4。

还没定：

1. **profile 位置**：放在工作区的 `sidekick/profile.yaml`（目录名跟着项目名走）。你没有异议的话就这么定。
2. **daemon 语言**：TS + Bun。这偏离了「本地服务用 Rust」的喜好，理由见 [adr/0002](adr/0002-daemon-ts-bun-app-swift.md)。你没有异议的话就这么定。
