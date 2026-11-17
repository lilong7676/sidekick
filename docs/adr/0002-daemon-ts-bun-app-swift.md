# ADR 0002：daemon 用 TypeScript + Bun，app 用 Swift，两者分开

- 状态：提议
- 日期：2026-11-13

## 背景

需要两个部件：

- **daemon**：常驻后台，负责轮询事件源、调度、spawn claude、落账本，还要提供一个 MCP 服务。
- **app**：菜单栏 app，负责展示状态、审批、派活。

按喜好里的选型表，「CLI、本地代理服务」用 Rust，「只面向 macOS 的原生应用」用 Swift。

## 决定

1. **daemon 用 TypeScript + Bun**，偏离了喜好里的 Rust。理由：
   - **复用**：现有 Slack 收件队列有约 1000 行 TS（bun:sqlite、slackcli 调用、launchd 接线、去重和分档逻辑），可以直接搬，Phase 1 就能和旧版并行对照。
   - **MCP**：官方 MCP TypeScript SDK 最成熟。daemon 要同时当 MCP 服务端（审批、提案、等待等工具）。
   - **推广**：如果在公司推广，同事以 TS 为主，改 profile 适配器、加事件源的门槛低。
   - **分发**：`bun build --compile` 能打成单文件，安装体验和 Rust 二进制接近。
2. **app 用 Swift**（SwiftUI `MenuBarExtra` + 窗口），符合喜好。
3. **两者分开，通过本地 HTTP 通信**：127.0.0.1 随机端口，token 放在权限 0600 的文件里，实时更新走 SSE。
   - app 关了，任务照跑；app 崩了，也不丢状态。
   - 以后要做 Web 界面或手机端，复用同一套 API。

## 代价

- 两种语言，API 类型要写两份。缓解办法是用一份 JSON Schema 描述 API，两边各自生成或手写校验。
- Bun 常驻进程长时间运行的稳定性没有 Rust 那样有把握。Phase 1 要观察内存和句柄泄漏，launchd 配置 `KeepAlive` 兜底。

## 没选的方案

- **全 Swift，单一 app 内含调度**：分发最简单，但 slack-inbox 要重写，而且 app 退出就停摆。
- **Electron / Tauri 一体**：UI 和 daemon 可以共用 TS，但只面向 Mac，原生菜单栏和通知体验更好，也符合已有选型。
- **Rust daemon**：符合喜好，但要重写现有逻辑，MCP 服务端生态也不如 TS。
