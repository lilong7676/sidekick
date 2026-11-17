# sidekick

English | [中文](#中文)

A local agent for your Slack DMs and @-mentions, running on [Claude Code](https://code.claude.com). For each message it decides whether you need to reply, looks things up, and drafts the reply. Nothing goes out without your approval. It lives in the macOS menu bar.

<p>
  <img src="docs/images/tasks.png" width="380" alt="Task list: a reply waiting for approval, and something that needs you">
  <img src="docs/images/approval.png" width="380" alt="Reply approval card: the agent's conclusion, the draft and its reason">
</p>

> The app's interface is in Chinese for now. Where this README names a place in the app, the Chinese label comes first, followed by its meaning.

## How it works

```
an unread DM to you, or a message that @-mentions you
  → the agent (Claude Code, one session per conversation): does this need a reply?
    if so, it checks the facts and drafts one → approval card; the draft also waits in Slack's message box
  → you approve it in the app, or edit and send it yourself in Slack → the card closes
```

- **Approvals first.** By default every reply waits for you. Full auto mode (全托管) sends replies on its own, for when you're on leave or at lunch. It can switch on by schedule, and every auto-sent reply is copied to you.
- **Your persona.** Tell it who you are, what you own, how you talk, and what it must never promise for you. Don't want to write it by hand? Copy a prompt and let your own Claude Code interview you and write it from the replies you've corrected.
- **Signed replies.** A grey line above each reply it sends says an assistant drafted it, and whether you had approved it.
- **One conversation, one task.** Follow-ups in a thread or a DM join the same task and resume the same Claude session, with a single approval card per conversation.
- **Rules before the agent runs, at no cost.** Skip certain people or channels; outside working hours, take messages in but work on them later.
- **Hand over to yourself.** "Continue in Claude Code" (在 Claude Code 里继续) opens the task's session in your own Claude Code, in Terminal or in the Claude desktop app.
- **Local.** The task ledger, your persona and your settings stay on your Mac.

## Install

Requirements: a Mac with Apple silicon (macOS 13 or later), and [Claude Code](https://code.claude.com) installed and signed in (`~/.local/bin/claude`). You need neither Bun nor this repository: the daemon and slackcli are compiled into Sidekick.app.

1. Run this in Terminal. It downloads the latest release, verifies it, puts Sidekick.app in Applications and opens it. Downloaded with curl, the app carries no quarantine flag, so macOS won't block it.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/lilong7676/sidekick/main/scripts/install.sh | bash
   ```

2. On launch the app installs the daemon as a LaunchAgent (`~/Library/LaunchAgents/local.sidekick.daemon.plist`), and macOS will say a background item was added. If the panel can't reach the daemon, open System Settings → General → Login Items, turn on sidekick under "Allow in the Background", and reopen Sidekick.
3. Click ✨ in the menu bar and choose a folder as the workspace. The agent runs there and can read the code in it, so the parent folder of your repositories is a good choice. A folder without `sidekick/profile.yaml` gets a profile, a Slack workflow and a persona template.
4. "Getting started" (开始用 sidekick) on the home page walks you through the rest: sign in to Slack (a button that opens a browser), write your persona, allow notifications. Then pick a past message and do a dry run (试跑) to see what it would have done.

If something is off, open 设置 → 诊断 (Settings → Diagnostics). Every failing check says how to fix it.

### Upgrade

When a new version is out, the panel shows 新版本 x (new version) at the top. Click it, then 升级 (Upgrade): Terminal reruns the install command, and the new version opens. Running tasks are queued again and resume within seconds. Rerunning the install command yourself does the same.

<img src="docs/images/settings.png" width="520" alt="Settings: reply mode, Slack, follow-ups in the same conversation, which messages to handle">

## Using it

Left-click ✨ for the panel; right-click for a separate window, restarting the daemon, and launch at login. Slack is polled every 5 minutes. Realtime mode (设置 → Slack) handles new messages within seconds over Slack web's own websocket, and falls back to polling when that misbehaves. Pending approvals show up as notifications you can approve or deny right there. The draft also waits in Slack's message box: send it from Slack, edited or not, or delete it, and the card in sidekick closes on its own.

In 设置 (Settings) you can also:

- turn full auto on a schedule (定时全托管), e.g. 12:00–13:30 on weekdays;
- turn the signature line off (回复带署名行);
- set how long a conversation keeps its task (同一对话的新消息): a thread with no time limit and a DM for 2 hours by default;
- set which messages to skip and the working hours (处理哪些消息);
- set which notifications you get: macOS notifications, and a Slack DM to yourself that reaches your phone (通知).

The panel also opens in a browser at `http://127.0.0.1:47321`. The first time, paste the `token` from `~/.config/sidekick/runtime.json`.

## Command line

With the app installed, the CLI is `/Applications/Sidekick.app/Contents/Resources/bin/sidekick`; from source, `bun src/cli.ts`:

```bash
sidekick tasks                  # open tasks
sidekick approvals              # waiting for approval
sidekick approve <id>           # approve; --text-file rewrites the reply
sidekick deny <id> --note "…"   # deny; with a note the agent tries again
sidekick add "something to do"  # give it a task by hand
sidekick takeover <task>        # pause a task and print the command to drive its session yourself
sidekick task <task>            # task details
sidekick doctor                 # the same checks as the panel's diagnostics
```

## Build from source

You need [Bun](https://bun.sh) and the Xcode command line tools.

```bash
cd app && make install && make run   # compile the daemon and slackcli, assemble Sidekick.app, install and open it
cd app && make zip                   # the same app/build/Sidekick-v<version>.zip a release ships
```

How it's put together: a Bun daemon (task ledger in SQLite, local HTTP API and the web panel), a Swift menu bar app that hosts the panel and keeps the daemon running as a LaunchAgent, and [slackcli](https://github.com/lilong7676/slackcli) for Slack. Pushing a `v*` tag builds a release with GitHub Actions. Design notes live in [docs/plan.md](docs/plan.md) and [docs/adr/](docs/adr/) (in Chinese).

## Privacy and disclaimer

- sidekick keeps no data off your Mac and collects nothing. Messages and code it reads go to Claude through your own Claude Code, as any Claude Code session does.
- Slack access goes through slackcli with your browser session, the one the Slack web client uses, and in realtime mode Slack web's internal websocket. These are not official Slack APIs: they can break, and your workspace's policies may not allow them. Check before you use it at work. Provided for personal learning and research.
- Replies go out under your name. In the default mode they wait for your approval; in full auto mode they don't, and what is sent is your responsibility.

## License

[MIT](LICENSE)

---

## 中文

本机常驻的 Slack 助手，跑在 [Claude Code](https://code.claude.com) 上：私信你、@ 你的消息，它先判断要不要回，要回就查证据、起草回复，经你批准才发出。住在 macOS 菜单栏里。

### 它怎么处理一条 Slack 消息

```
未读的私信我 / @ 我
  → agent（Claude Code，一个对话一个会话）：要不要回？要回就查证据、起草 → 审批卡，草稿同时放进 Slack 输入框
  → 你在面板里批准，或者在 Slack 里自己改了发出 → 卡结掉
```

- **先审批再发出**：默认每条回复都等你批。全托管时直接发出（请假、午休用），可以按时间表自动切换，每条自动发出的都私信你一份。
- **分身**：写清你是谁、负责什么、怎么说话、哪些事不能替你答应。不想手写，就复制一段 prompt 交给你自己的 Claude Code，它会问你几个问题，参考你最近改过的回复帮你写好。
- **署名行**：sidekick 发出的回复上面有一行灰色小字，说明是助手起草的、你批没批过。
- **一个对话一个任务**：同一个 thread 或私信里的后续消息并进同一个任务，接着同一个会话处理，一个对话只留一张审批卡。
- **处理前过滤，不花钱**：可以不处理某些人、某些频道；下班时间只收不处理。
- **交还给你**：「在 Claude Code 里继续」在你自己的 Claude Code 里打开这个任务的会话，可以是终端，也可以是 Claude 桌面 app。
- **数据在本机**：任务账本、分身、设置都只在你的 Mac 上。

### 安装

前提：Apple 芯片的 Mac（macOS 13 起），[Claude Code](https://code.claude.com) 已安装并登录（`~/.local/bin/claude`）。不用装 Bun，也不用这个仓库：daemon 和 slackcli 都编进了 Sidekick.app。

1. 在终端运行这一行：下载最新版、校验、装进「应用程序」并打开。用 curl 下载的 app 不带隔离标记，不用再手动放行。

   ```bash
   curl -fsSL https://raw.githubusercontent.com/lilong7676/sidekick/main/scripts/install.sh | bash
   ```

2. app 打开后会把 daemon 装成后台常驻（`~/Library/LaunchAgents/local.sidekick.daemon.plist`），macOS 会提示「已添加后台项目」。面板一直连不上的话，去 系统设置 → 通用 → 登录项，在「允许在后台」里打开 sidekick，再重新打开 Sidekick。
3. 点菜单栏的 ✨，选一个文件夹当工作区：agent 在这里运行，能读里面的代码，建议选放代码仓库的上一级目录。没有 `sidekick/profile.yaml` 的文件夹，会按模板建好 profile、处理 Slack 的流程和分身。
4. 主页上的「开始用 sidekick」会带你做完剩下几步：登录 Slack（点按钮，会打开浏览器）、写分身、允许通知。写完挑一条历史消息「试跑」看效果。

有问题去「设置 → 诊断」，每一项不通过都写了怎么修。

### 升级

有新版本时，面板顶部会出现「新版本 x」：点进去再点「升级」，会在终端里重跑上面那行安装命令，换上新版后重新打开。正在跑的任务会重新排队，十几秒后接着处理。直接在终端再跑一遍那行命令也一样。

### 使用

左键点菜单栏的 ✨ 打开面板；右键有「打开窗口」「重启 daemon」「开机自动启动」。Slack 默认每 5 分钟轮询一次。在「设置 → Slack」打开实时模式后，新消息几秒内就处理；实时用的是 Slack 网页版内部的 websocket，不稳定时会自动回退到轮询。待审批会弹系统通知，可以直接在通知上批准或拒绝。回复同时会以草稿放进 Slack 输入框：在 Slack 里改了直接发出、或者删掉草稿都行，sidekick 里的卡会跟着结掉。

「设置」里还能改这些：
- 定时全托管：比如工作日 12:00–13:30。
- 回复带署名行：可以关掉。
- 同一对话的新消息并多久：默认 thread 不限时、私信 2 小时。
- 处理哪些消息：哪些人、哪些频道不处理，以及上班时间。
- 通知：macOS 通知，以及给你自己发的 Slack 私信提醒（手机上也能看到）。

浏览器也能打开 `http://127.0.0.1:47321`，第一次要粘贴 `~/.config/sidekick/runtime.json` 里的 `token`。

### 命令行

装了 app 的用 `/Applications/Sidekick.app/Contents/Resources/bin/sidekick`，源码里用 `bun src/cli.ts`。命令见上面英文部分，`sidekick --help` 有中文说明。

### 从源码构建

需要 [Bun](https://bun.sh) 和 Xcode 命令行工具：`cd app && make install && make run` 编译并安装；`make zip` 打出和 Release 一样的安装包。设计文档在 [docs/plan.md](docs/plan.md) 和 [docs/adr/](docs/adr/)。

### 隐私与免责声明

- sidekick 不把数据存到你的 Mac 以外，也不收集任何数据。它读到的消息和代码，会像平常的 Claude Code 会话一样，经你自己的 Claude Code 发给 Claude。
- Slack 访问通过 slackcli，用的是你浏览器里的登录态（也就是 Slack 网页版用的那份）；实时模式用的是 Slack 网页版内部的 websocket。这些都不是 Slack 官方 API，可能失效，也可能不符合你所在工作区的规定，在工作中使用前请先确认。仅供个人学习研究。
- 回复以你的名义发出。默认模式下都要你批准；全托管时不经你确认，发出的内容由你负责。

### 许可证

[MIT](LICENSE)
