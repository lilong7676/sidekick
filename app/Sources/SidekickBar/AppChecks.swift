import Foundation
import ServiceManagement
import UserNotifications

/// The menu bar app's own health. The panel shows these next to the daemon's checks in 设置 → 诊断;
/// the daemon cannot see them (they are this app's permissions and location).
enum AppChecks {
    typealias Check = [String: String]

    static func run(_ done: @escaping ([Check]) -> Void) {
        var checks: [Check] = []

        let path = Bundle.main.bundlePath
        let appName = L("菜单栏 app", "Menu bar app")
        if path.hasPrefix("/Applications/") {
            checks.append(["id": "app-location", "name": appName, "status": "ok", "detail": L("装在「应用程序」里", "Installed in Applications")])
        } else {
            checks.append([
                "id": "app-location", "name": appName, "status": "warn",
                "detail": L("不在「应用程序」里运行（\(path)）", "Not running from Applications (\(path))"),
                "fix": L("把 Sidekick.app 放进「应用程序」再打开，开机自动启动和通知才稳定；在 sidekick 的 app 目录里运行 make install 也可以",
                         "Move Sidekick.app into Applications and open it from there, so launch at login and notifications work reliably. Running make install in sidekick's app folder also does it"),
            ])
        }

        let runtime = DaemonClient().runtime()
        let daemonName = L("daemon 常驻", "Background daemon")
        if !DaemonService.loaded {
            checks.append([
                "id": "app-daemon", "name": daemonName, "status": "fail", "detail": DaemonService.statusText,
                "fix": L("系统设置 → 通用 → 登录项，在「允许在后台」里打开 sidekick，再退出并重新打开 Sidekick",
                         "In System Settings → General → Login Items, turn on sidekick under Allow in the Background, then quit and reopen Sidekick"),
            ])
        } else if !DaemonService.upToDate(runtime) {
            checks.append([
                "id": "app-daemon", "name": daemonName, "status": "warn",
                "detail": L("app 是 \(DaemonService.appVersion)，在跑的 daemon 是 \(runtime?.version ?? "旧版")：升级后新版 daemon 还没接管",
                            "The app is \(DaemonService.appVersion) but the running daemon is \(runtime?.version ?? "an older version"): the upgraded daemon has not taken over yet"),
                "fix": L("右键菜单栏图标 →「重启 daemon」，会换成新版", "Right-click the menu bar icon → Restart daemon to switch to the new version"),
            ])
        } else {
            checks.append(["id": "app-daemon", "name": daemonName, "status": "ok", "detail": L("Sidekick.app \(DaemonService.appVersion) 自带的 daemon，launchd 托管", "The daemon bundled with Sidekick.app \(DaemonService.appVersion), run by launchd")])
        }

        let loginName = L("开机自动启动", "Launch at login")
        if SMAppService.mainApp.status == .enabled {
            checks.append(["id": "app-login", "name": loginName, "status": "ok", "detail": L("已开启", "On")])
        } else {
            checks.append([
                "id": "app-login", "name": loginName, "status": "warn",
                "detail": L("没开，重启电脑后菜单栏图标不会自己出来（daemon 不受影响）", "Off: after a restart the menu bar icon does not come back on its own (the daemon is not affected)"),
                "fix": L("右键菜单栏图标 → 开机自动启动", "Right-click the menu bar icon → Launch at login"),
            ])
        }

        UNUserNotificationCenter.current().getNotificationSettings { settings in
            // On the main thread: that is where the interface language changes.
            DispatchQueue.main.async {
                let notifyName = L("通知权限", "Notification permission")
                let notify: Check
                switch settings.authorizationStatus {
                case .authorized, .provisional:
                    notify = ["id": "app-notify", "name": notifyName, "status": "ok", "detail": settings.alertStyle == .alert ? L("已允许（提醒样式）", "Allowed (alert style)") : L("已允许", "Allowed")]
                case .denied:
                    notify = [
                        "id": "app-notify", "name": notifyName, "status": "fail",
                        "detail": L("被关掉了：面板开着时待审批不会弹通知", "Turned off: approvals do not show a notification while the panel is open"),
                        "fix": L("系统设置 → 通知 → Sidekick，打开「允许通知」", "In System Settings → Notifications → Sidekick, turn on Allow notifications"),
                    ]
                default:
                    notify = [
                        "id": "app-notify", "name": notifyName, "status": "warn",
                        "detail": L("还没授权", "Not allowed yet"),
                        "fix": L("重新打开 Sidekick，在弹出的通知授权里点允许；没弹就去 系统设置 → 通知 → Sidekick",
                                 "Reopen Sidekick and click Allow when it asks to send notifications. If it does not ask, go to System Settings → Notifications → Sidekick"),
                    ]
                }
                done(checks + [notify])
            }
        }
    }
}
