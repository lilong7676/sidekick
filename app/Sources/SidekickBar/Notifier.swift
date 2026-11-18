import Foundation
import UserNotifications

/// Native notifications with buttons: approve or deny (with an optional note), or carry on in Claude,
/// without opening the panel. Each approval, needs-me / failed task and deleted draft is announced once.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let approve = "SK_APPROVE"
    static let deny = "SK_DENY"
    static let continueInClaude = "SK_CONTINUE"
    private let client: DaemonClient
    private let onOpenTask: (String) -> Void
    private let seenKey = "sidekick.notified"
    private var seen: Set<String>

    init(client: DaemonClient, onOpenTask: @escaping (String) -> Void) {
        self.client = client
        self.onOpenTask = onOpenTask
        self.seen = Set(UserDefaults.standard.stringArray(forKey: seenKey) ?? [])
        super.init()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        registerCategories()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error { NSLog("sidekick: notification permission error: \(error)") }
            if !granted { NSLog("sidekick: notifications not allowed") }
        }
    }

    /// The approve / deny buttons, in the interface language: at launch, and again when it changes.
    func registerCategories() {
        let approve = UNNotificationAction(identifier: Self.approve, title: L("批准", "Approve"), options: [])
        let deny = UNTextInputNotificationAction(
            identifier: Self.deny, title: L("拒绝…", "Deny…"), options: [],
            textInputButtonTitle: L("拒绝", "Deny"),
            textInputPlaceholder: L("意见（可选，填了会让它重做）", "Feedback (optional; it will redo the work with it)"))
        // Same as the panel's button: the task's session, in Terminal or the Claude desktop app per 设置.
        let carryOn = UNNotificationAction(identifier: Self.continueInClaude, title: L("在 Claude 里继续", "Continue in Claude"), options: [])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "SK_APPROVAL", actions: [approve, deny, carryOn], intentIdentifiers: []),
            UNNotificationCategory(identifier: "SK_TASK", actions: [carryOn], intentIdentifiers: []),
            UNNotificationCategory(identifier: "SK_DRAFT_DELETED", actions: [carryOn], intentIdentifiers: []),
        ])
    }

    private func markSeen(_ key: String) {
        seen.insert(key)
        UserDefaults.standard.set(Array(seen.suffix(500)), forKey: seenKey)
    }

    /// `show` false (macOS notifications turned off in 设置): still mark them seen, so turning it back on
    /// does not bring back everything that happened meanwhile.
    func announce(approvals: [ApprovalItem], tasks: [TaskItem], show: Bool) {
        for a in approvals where !seen.contains("a:\(a.id)") {
            markSeen("a:\(a.id)")
            let c = UNMutableNotificationContent()
            c.title = a.kind == "outbound" ? L("待审批：回复", "To approve: reply") : L("待审批：操作", "To approve: action")
            c.subtitle = a.task_title ?? a.task_id
            c.body = a.kind == "outbound" ? (a.payload.text ?? "") : "\(a.payload.tool_name ?? "") \(a.payload.input?.command ?? "")"
            c.sound = .default
            c.categoryIdentifier = "SK_APPROVAL"
            c.userInfo = ["approvalId": a.id, "taskId": a.task_id]
            if show { post(c, id: "a-\(a.id)") }
        }
        for t in tasks where t.status == "needs_me" || t.status == "failed" {
            let key = "t:\(t.id):\(t.status)"
            if seen.contains(key) { continue }
            markSeen(key)
            let c = UNMutableNotificationContent()
            c.title = t.status == "failed" ? L("任务失败", "Task failed") : L("要你看一下", "Needs you")
            c.subtitle = t.title
            c.body = t.summary ?? ""
            c.sound = .default
            c.categoryIdentifier = "SK_TASK"
            c.userInfo = ["taskId": t.id]
            if show { post(c, id: "t-\(t.id)-\(t.status)") }
        }
    }

    private func post(_ content: UNNotificationContent, id: String) {
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
            if let error { NSLog("sidekick: notification failed: \(error)") }
        }
    }

    // Show banners even while the panel is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    /// A reply draft I deleted in Slack: the reply was not good enough, so offer once to carry on in
    /// Claude with the task's session rather than start over from the Slack link.
    func announceDeleted(_ drafts: [DeletedDraft], show: Bool) {
        for d in drafts where !seen.contains("d:\(d.approvalId)") {
            markSeen("d:\(d.approvalId)")
            let c = UNMutableNotificationContent()
            c.title = L("你删掉了 sidekick 的草稿", "You deleted sidekick's draft")
            c.subtitle = d.title
            c.body = L("要自己接着处理，就在 Claude 里继续这个会话：查过的东西都在。", "To handle it yourself, continue this session in Claude: everything it looked up is there.")
            c.categoryIdentifier = "SK_DRAFT_DELETED"
            c.userInfo = ["taskId": d.taskId]
            if show { post(c, id: "d-\(d.approvalId)") }
        }
    }

    /// The panel's 「在 Claude 里继续」: the daemon opens the desktop app itself; a Terminal fork is opened here.
    private func carryOn(_ taskId: String) async {
        do {
            let r = try await client.continueTask(taskId)
            if r.where == "terminal" {
                await MainActor.run { Terminal.continueSession(cwd: r.cwd, session: r.session, name: r.name) }
            }
        } catch {
            NSLog("sidekick: continue in Claude failed: \(error)")
            await MainActor.run { self.onOpenTask(taskId) }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let approvalId = info["approvalId"] as? String
        let taskId = info["taskId"] as? String
        switch response.actionIdentifier {
        case Self.approve:
            if let approvalId { Task { try? await client.approve(approvalId) } }
        case Self.deny:
            let note = (response as? UNTextInputNotificationResponse)?.userText
            if let approvalId { Task { try? await client.deny(approvalId, note: note) } }
        case Self.continueInClaude:
            if let taskId { Task { await self.carryOn(taskId) } }
        default:
            if let taskId { DispatchQueue.main.async { self.onOpenTask(taskId) } }
        }
        done()
    }
}
