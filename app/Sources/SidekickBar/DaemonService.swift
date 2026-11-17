import AppKit
import ServiceManagement

/// The daemon is a per-user LaunchAgent: ~/Library/LaunchAgents/local.sidekick.daemon.plist runs the
/// binary inside this app, and launchd keeps it running, restarts it after a crash and starts it again
/// at login. The app writes the plist and loads it; nothing has to be installed besides the app.
///
/// Not SMAppService: that pins the daemon to the code requirement Background Task Management recorded,
/// for an ad-hoc signed binary its hash, and after an upgrade launchd refused the new binary, sometimes
/// for good (docs/plan.md, Phase 4). A plain LaunchAgent has no such pin: a restart runs the new binary.
enum DaemonService {
    static let label = "local.sidekick.daemon"
    private static let target = "gui/\(getuid())/\(label)"
    static let plistURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents/\(label).plist")

    static var binary: URL {
        Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/bin/sidekick")
    }

    /// The plist for this copy of the app: moving the app changes it, and the next launch rewrites it.
    private static var plist: Data {
        let dict: [String: Any] = [
            "Label": label,
            "ProgramArguments": [binary.path, "daemon"],
            "RunAtLoad": true,
            "KeepAlive": true,
            "ThrottleInterval": 30,
        ]
        return try! PropertyListSerialization.data(fromPropertyList: dict, format: .xml, options: 0)
    }

    /// On every launch: install the LaunchAgent if it is missing, stale or not loaded; after an upgrade
    /// (this app carries another daemon binary than the one running), restart it on the new binary.
    @MainActor
    static func ensure(runtime: Runtime?) {
        if (try? Data(contentsOf: plistURL)) != plist || !loaded {
            install()
        } else if !upToDate(runtime) {
            log("daemon binary in the app is not the one running, restarting it")
            kickstart()
        }
    }

    /// Write the plist and (re)load it; a job loaded from an older plist is replaced.
    private static func install() {
        do {
            try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try plist.write(to: plistURL, options: .atomic)
        } catch {
            log("writing \(plistURL.path) failed: \(error)")
            return
        }
        _ = launchctl("bootout", target) // fails when nothing is loaded, which is fine
        // The old instance may still be shutting down for a moment after bootout.
        for attempt in 1...3 {
            let r = launchctl("bootstrap", "gui/\(getuid())", plistURL.path)
            if r.ok {
                log("daemon loaded from \(plistURL.path)")
                return
            }
            log("loading the daemon failed (attempt \(attempt)): \(r.output)")
            Thread.sleep(forTimeInterval: 1)
        }
        askForApproval()
    }

    /// launchd has the job (running, or waiting to be restarted).
    static var loaded: Bool { launchctl("print", target).ok }

    /// The daemon runs the binary this app carries. Compared by mtime, not by "newer than the daemon's
    /// start": a release zip keeps the build machine's mtime, which can predate a daemon started today.
    static func upToDate(_ runtime: Runtime?) -> Bool {
        guard let carried = modified(binary) else { return true }
        return runtime?.binaryMtime == Int(carried.timeIntervalSince1970)
    }

    static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
    }

    /// What the offline page and the app checks say about the daemon.
    static var statusText: String {
        if !FileManager.default.fileExists(atPath: plistURL.path) { return "还没装成常驻服务，重新打开 Sidekick 会装上" }
        if !loaded { return "装了，但 launchd 没加载（可能在 系统设置 → 通用 → 登录项 里被关掉了）" }
        return "launchd 托管中"
    }

    /// Restart the daemon (on whatever binary the plist names). Also how an upgrade takes over.
    @discardableResult
    static func kickstart() -> Bool {
        launchctl("kickstart", "-k", target).ok
    }

    /// ~/Library/Logs/sidekick/app.log: what the app did about the daemon, for `sidekick doctor` users.
    static func log(_ line: String) {
        NSLog("sidekick: \(line)")
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/sidekick", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("app.log")
        let text = "[\(ISO8601DateFormatter().string(from: Date()))] \(line)\n"
        if let h = try? FileHandle(forWritingTo: file) {
            h.seekToEndOfFile()
            h.write(Data(text.utf8))
            try? h.close()
        } else {
            try? text.write(to: file, atomically: true, encoding: .utf8)
        }
    }

    private static func launchctl(_ args: String...) -> (ok: Bool, output: String) {
        let p = Process()
        let out = Pipe()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        p.standardOutput = out
        p.standardError = out
        do {
            try p.run()
        } catch {
            return (false, "\(error)")
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return (p.terminationStatus == 0, String(text.prefix(300)))
    }

    private static var asked = false

    /// The user can switch background items off; loading then fails. Point at the setting, once.
    private static func askForApproval() {
        guard !asked else { return }
        asked = true
        let alert = NSAlert()
        alert.messageText = "允许 sidekick 在后台运行"
        alert.informativeText = "sidekick 的 daemon 要在后台常驻，才能收 Slack 消息、处理任务。在 系统设置 → 通用 → 登录项 里，把「允许在后台」下的 sidekick 打开，再重新打开 Sidekick。"
        alert.addButton(withTitle: "打开系统设置")
        alert.addButton(withTitle: "稍后")
        if alert.runModal() == .alertFirstButtonReturn { SMAppService.openSystemSettingsLoginItems() }
    }

    private static func modified(_ url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }
}
