import Foundation
import UserNotifications

/// Native notifications with buttons: approve or deny (with an optional note) without opening
/// the panel. Each approval and each needs-me / failed task is announced once.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let approve = "SK_APPROVE"
    static let deny = "SK_DENY"
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
        let approve = UNNotificationAction(identifier: Self.approve, title: "批准", options: [])
        let deny = UNTextInputNotificationAction(identifier: Self.deny, title: "拒绝…", options: [], textInputButtonTitle: "拒绝", textInputPlaceholder: "意见（可选，填了会让它重做）")
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "SK_APPROVAL", actions: [approve, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: "SK_TASK", actions: [], intentIdentifiers: []),
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error { NSLog("sidekick: notification permission error: \(error)") }
            if !granted { NSLog("sidekick: notifications not allowed") }
        }
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
            c.title = a.kind == "outbound" ? "待审批：回复" : "待审批：操作"
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
            c.title = t.status == "failed" ? "任务失败" : "要你看一下"
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
        default:
            if let taskId { DispatchQueue.main.async { self.onOpenTask(taskId) } }
        }
        done()
    }
}
