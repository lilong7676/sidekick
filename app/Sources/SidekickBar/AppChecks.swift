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
        if path.hasPrefix("/Applications/") {
            checks.append(["id": "app-location", "name": "菜单栏 app", "status": "ok", "detail": "装在「应用程序」里"])
        } else {
            checks.append([
                "id": "app-location", "name": "菜单栏 app", "status": "warn",
                "detail": "不在「应用程序」里运行（\(path)）",
                "fix": "把 Sidekick.app 放进「应用程序」再打开，开机自动启动和通知才稳定；在 sidekick 的 app 目录里运行 make install 也可以",
            ])
        }

        let runtime = DaemonClient().runtime()
        if !DaemonService.loaded {
            checks.append([
                "id": "app-daemon", "name": "daemon 常驻", "status": "fail", "detail": DaemonService.statusText,
                "fix": "系统设置 → 通用 → 登录项，在「允许在后台」里打开 sidekick，再退出并重新打开 Sidekick",
            ])
        } else if !DaemonService.upToDate(runtime) {
            checks.append([
                "id": "app-daemon", "name": "daemon 常驻", "status": "warn",
                "detail": "app 是 \(DaemonService.appVersion)，在跑的 daemon 是 \(runtime?.version ?? "旧版")：升级后新版 daemon 还没接管",
                "fix": "右键菜单栏图标 →「重启 daemon」，会换成新版",
            ])
        } else {
            checks.append(["id": "app-daemon", "name": "daemon 常驻", "status": "ok", "detail": "Sidekick.app \(DaemonService.appVersion) 自带的 daemon，launchd 托管"])
        }

        if SMAppService.mainApp.status == .enabled {
            checks.append(["id": "app-login", "name": "开机自动启动", "status": "ok", "detail": "已开启"])
        } else {
            checks.append([
                "id": "app-login", "name": "开机自动启动", "status": "warn",
                "detail": "没开，重启电脑后菜单栏图标不会自己出来（daemon 不受影响）",
                "fix": "右键菜单栏图标 → 开机自动启动",
            ])
        }

        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let notify: Check
            switch settings.authorizationStatus {
            case .authorized, .provisional:
                notify = ["id": "app-notify", "name": "通知权限", "status": "ok", "detail": settings.alertStyle == .alert ? "已允许（提醒样式）" : "已允许"]
            case .denied:
                notify = [
                    "id": "app-notify", "name": "通知权限", "status": "fail",
                    "detail": "被关掉了：面板开着时待审批不会弹通知",
                    "fix": "系统设置 → 通知 → Sidekick，打开「允许通知」",
                ]
            default:
                notify = [
                    "id": "app-notify", "name": "通知权限", "status": "warn",
                    "detail": "还没授权",
                    "fix": "重新打开 Sidekick，在弹出的通知授权里点允许；没弹就去 系统设置 → 通知 → Sidekick",
                ]
            }
            DispatchQueue.main.async { done(checks + [notify]) }
        }
    }
}
