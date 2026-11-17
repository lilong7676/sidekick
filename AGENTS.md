# sidekick

本机常驻的 agent 调度器：从 Slack、Jira、GitHub 和手动派活收事件，生成任务，交给 Claude Code CLI 执行；在菜单栏 app 里看进度、审批对外动作、接管会话。

状态：Phase 1（daemon）和 Phase 2（菜单栏 app）代码完成，等常驻验证。Phase 0 结论见 docs/adr/0003。

## 开工前先读

1. [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md)：问题、范围、不做什么。
2. [docs/plan.md](docs/plan.md)：架构、数据模型、阶段、待定问题。
3. [docs/adr/](docs/adr/)：关键选型和理由。

## 约定

- **引擎不含业务信息**：公司名、频道、工单前缀、个人路径都不进本仓。这些属于 profile，放在使用者自己的工作区里。
- **对外动作永远走审批**：执行对外动作的命令只出现在 daemon 的执行器里，agent 拿不到。
- **状态只在账本里**：不依赖会话记忆。
- **界面中英双语**：给人看的文案一律两种语言写在一起，TS 用 `t("中文", "English")`（src/i18n.ts），Swift 用 `L("中文", "English")`（Lang.swift），术语和已有的英文保持一致。语言跟随系统，可在设置里切换；daemon 决定，面板和菜单栏 app 从 `/api/state` 取。agent 读写的内容（prompt、MCP 工具、模板、agent 写的结论摘要）、日志、存进库里又被比较的值不翻。
- 阶段按 plan.md 推进，一个阶段在真实环境验完再开下一个。

## 目录

```
docs/
  PROJECT_CONTEXT.md
  plan.md
  references.md     开源参考和核实过的 Claude Code 文档要点
  adr/              关键选型
  conversations/    起始讨论
src/
  cli.ts            命令行入口（daemon / tick / add / approvals / approve / guard / mcp …）
  daemon.ts         主循环：采集 → 建任务 → 审批执行 → 处理 → 通知
  slack.ts          Slack 源、上下文、daemon 才能用的写操作
  listener.ts       常驻 slackcli listen，私信 / @我 一到就立刻采集
  realtime.ts       实时模式开没开、socket 健不健康，不稳定时回退到轮询
  doctor.ts         诊断：CLI、daemon 自动诊断、面板「运行诊断」共用
  persona.ts        分身：读写（防覆盖）、拼进每次运行的系统提示
  trial.ts          试跑：拿历史消息按分身走一遍，只读、不建任务
  setup.ts          首次设置 / 换工作区：没有 profile 的文件夹按模板建好
  intake.ts         Slack 消息 → 任务（同一对话合并）；跳过规则、下班时间只收不处理
  handle.ts         处理一个任务：prompt、启动参数、跑完后的状态
  runner.ts         spawn claude -p（接口按 ACP 形状）
  mcp.ts            sidekick MCP：approve / propose / report
  guard.ts          PreToolUse hook：变体写法的 ask / deny
  approvals.ts      审批决定和执行
  server.ts         本机 HTTP API + SSE，顺带提供网页
  queries.ts        CLI 和 API 共用的查询与任务动作
  slacklogin.ts     面板里登录 Slack：daemon 跑 slackcli auth login-auto
  update.ts         查 GitHub Releases 有没有新版本
  db.ts config.ts notify.ts util.ts
web/                管理界面（Preact，Bun 打包，由 daemon 提供）
templates/          profile.yaml、slack.md（处理 Slack 的通用流程）、me.md（分身）；首次设置时拷进工作区，不写任何公司信息
app/                Swift 菜单栏 app，也是唯一的安装方式：make install 把编译好的 daemon 和 slackcli 一起装进 Sidekick.app（make zip 打发布包），
                    app 把 daemon 装成 ~/Library/LaunchAgents 下的 LaunchAgent（DaemonService.swift）；
                    图标源文件是 Resources/AppIcon.svg，改完跑 make icon 重新生成 AppIcon.icns，两个都提交
test/               bun test
bin/slackcli        锁定版本的 slackcli 入口；daemon 和每次 agent 运行的 PATH 里排第一
scripts/install.sh  一行安装 / 升级：curl 下载最新 Release、校验、替换 /Applications/Sidekick.app
docs/images/        README 截图，用假数据拍的，不能出现公司信息和本机路径
.github/workflows/release.yml   推 v* tag 构建并发 Release
```

- **slackcli 只用锁定的那一份**：依赖写在 `package.json` 里，锁到具体 commit。要升级，就改 commit 后重新 `bun install`，再跑 `bun src/cli.ts doctor` 确认 `listen` 还在。不要依赖机器上全局装的 slackcli。
- **调用 slackcli 和其他命令一律用异步进程**（`slack.ts` 的 `slack()`、`util.ts` 的 `runProcess()`）。不要用 `execFileSync`：一次采集约 18 秒，同步调用会把整个 daemon 卡住。
- **新的故障点要配一条诊断**：加了依赖（命令、权限、登录、外部服务）就在 `doctor.ts` 里加一项检查，写清修法，能用命令修的给出命令。同事装好后靠它自助排查。

- **daemon 只由 Sidekick.app 托管**：app 启动时写 `~/Library/LaunchAgents/local.sidekick.daemon.plist`（指向 app 里的 daemon）并用 `launchctl bootstrap` 加载；升级后 `launchctl kickstart -k` 就换上新二进制。改完代码用 `cd app && make install && make run` 验证。**不要改回 SMAppService**：它把 daemon 钉在后台项目管理记下的代码要求上，ad-hoc 签名时就是二进制哈希，升级后 launchd 拒绝新二进制，重新注册也不一定救得回来（plan.md Phase 4）。判断「升级了」靠比较 daemon 二进制的修改时间（daemon 启动时写进 `runtime.json` 的 `binaryMtime`），不比先后：Release 包里的时间是 CI 构建的时间，可能早于本机 daemon 的启动。app 自己的日志在 `~/Library/Logs/sidekick/app.log`。
- **版本号只写在 `package.json`**：`make bundle` 写进 app 的 Info.plist，daemon 编译时带上（`util.ts` 的 `VERSION`），面板「设置 → daemon」和诊断里都能看到。
- **发版**：在一个 `chore: release <版本>` 提交里改 `package.json` 的 version（测试版用 `0.2.0-beta.1` 这种），合进 main 后在那个提交上打 `v<版本>` 的 tag 并推上去。`.github/workflows/release.yml` 会核对 tag 和 `package.json` 一致，跑类型检查和测试，`make -C app zip`，把 `Sidekick-v<版本>.zip` 和 `.sha256` 挂到 Release；版本号带 `-` 的标成预发布。不打 tag、在 Actions 页手动运行，只构建不发布，zip 挂在那次运行上。包只有 Apple 芯片版本。
- **编译后没有源码目录**：`util.ts` 的 `COMPILED` 区分两种运行方式。模板、`package.json` 这类文件用 import 编进去，不要在运行时按源码路径读文件。
- **公司的东西不进本仓**：仓库推广时公开。公司统一的 deny 规则、skill 放在公司 org 的「公司包」里（还没建），个人的放在使用者自己的工作区。

开发时从 Claude Code 里跑 daemon 也安全：所有子进程都用白名单环境变量，见 `util.ts` 的 `cleanEnv`。
