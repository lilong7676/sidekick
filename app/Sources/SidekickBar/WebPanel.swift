import AppKit
import WebKit

/// The panel: a WKWebView on the daemon's page, with the token injected before the page runs
/// and a small bridge for the things a web page cannot do (open Terminal, open links).
final class WebPanel: NSViewController, WKNavigationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    private let client: DaemonClient
    private let onBadgeRefresh: () -> Void
    private let onOpenWindow: () -> Void
    private let onLanguage: (String?) -> Void
    private var webView: WKWebView!
    private var loadedRuntime: Runtime?
    private let size: NSSize

    init(client: DaemonClient, size: NSSize, onBadgeRefresh: @escaping () -> Void, onOpenWindow: @escaping () -> Void,
         onLanguage: @escaping (String?) -> Void) {
        self.client = client
        self.size = size
        self.onBadgeRefresh = onBadgeRefresh
        self.onOpenWindow = onOpenWindow
        self.onLanguage = onLanguage
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let config = WKWebViewConfiguration()
        // A weak proxy, so the content controller does not keep this controller alive.
        config.userContentController.add(WeakHandler(self), name: "sidekick")
        // Questions with an answer (a Promise on the page side).
        config.userContentController.addScriptMessageHandler(WeakReplyHandler(self), contentWorld: .page, name: "sidekickAsk")
        webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        view = webView
        reload()
    }

    /// (Re)load the page when the daemon restarted with a new port or token, or when asked to.
    func reload(force: Bool = true) {
        guard isViewLoaded else { return }
        guard let rt = client.runtime() else {
            loadedRuntime = nil
            showOffline(L("找不到 ~/.config/sidekick/runtime.json，daemon 还没启动过。", "Can't find ~/.config/sidekick/runtime.json: the daemon has not started yet."))
            return
        }
        if !force, rt == loadedRuntime { return }
        let ucc = webView.configuration.userContentController
        ucc.removeAllUserScripts()
        // The token is hex from the daemon; still, never interpolate anything unchecked into script.
        guard rt.token.allSatisfy({ $0.isHexDigit }) else {
            showOffline(L("runtime.json 里的 token 格式不对。", "The token in runtime.json is malformed."))
            return
        }
        ucc.addUserScript(WKUserScript(source: "window.SIDEKICK_TOKEN = '\(rt.token)';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        loadedRuntime = rt
        webView.load(URLRequest(url: client.baseURL(rt)))
    }

    /// Open a task's detail in the panel.
    func show(taskId: String) {
        guard taskId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return }
        webView?.evaluateJavaScript("location.hash = 'task=\(taskId)'")
    }

    private func showOffline(_ reason: String) {
        let html = """
        <html><body style="font: 13px -apple-system; padding: 24px; color: #6e6e73; background: transparent">
        <h3 style="color: #c96442; margin-top: 0">\(L("连不上 sidekick daemon", "Can't reach the sidekick daemon"))</h3>
        <p>\(reason.replacingOccurrences(of: "<", with: "&lt;"))</p>
        <p>\(L("daemon：", "Daemon: "))\(DaemonService.statusText.replacingOccurrences(of: "<", with: "&lt;"))\(L("。", "."))</p>
        <p>\(L("刚装好时等几秒；一直这样就右键菜单栏图标 →「重启 daemon」，再「重新加载」。", "Right after installing, give it a few seconds. If it stays like this, right-click the menu bar icon → Restart daemon, then Reload."))</p>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.host == "127.0.0.1" || url.scheme == "about" {
            return decisionHandler(.allow)
        }
        // Anything else (Slack permalinks, docs) opens in the default browser / Slack app.
        if url.scheme == "https" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadedRuntime = nil
        showOffline(L("daemon 没有响应（\(error.localizedDescription)）。", "The daemon is not responding (\(error.localizedDescription))."))
    }

    // MARK: bridge

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only our own page may ask for anything.
        guard message.frameInfo.securityOrigin.host == "127.0.0.1",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "takeover":
            if let cwd = body["cwd"] as? String, let args = body["args"] as? [String] {
                Terminal.takeover(cwd: cwd, args: args)
            }
        case "upgrade":
            Terminal.upgrade()
        case "continue":
            if let cwd = body["cwd"] as? String, let session = body["session"] as? String {
                Terminal.continueSession(cwd: cwd, session: session, name: body["name"] as? String)
            }
        case "open":
            if let s = body["url"] as? String, let url = URL(string: s), url.scheme == "https" {
                NSWorkspace.shared.open(url)
            }
        case "refreshBadge":
            onBadgeRefresh()
        case "openWindow":
            onOpenWindow()
        default:
            break
        }
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.securityOrigin.host == "127.0.0.1",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return replyHandler(nil, "refused") }
        switch type {
        case "appChecks":
            // Ask the daemon for the language first: the panel may ask for these right after the language
            // is switched in 设置, before the next state poll (every 5 s) has picked it up.
            Task { @MainActor in
                if let state = try? await client.state() { onLanguage(state.lang) }
                AppChecks.run { replyHandler($0, nil) }
            }
        case "pickFolder":
            // Setup: the page cannot learn a folder's path from a file input, so ask natively.
            let open = NSOpenPanel()
            open.canChooseDirectories = true
            open.canChooseFiles = false
            open.canCreateDirectories = true
            open.prompt = L("用这个文件夹", "Use this folder")
            open.message = L("选一个文件夹当 sidekick 的工作区", "Choose a folder for sidekick's workspace")
            NSApp.activate(ignoringOtherApps: true)
            replyHandler(open.runModal() == .OK ? open.url?.path : nil, nil)
        default:
            replyHandler(nil, "unknown request")
        }
    }
}

private final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?
    init(_ target: WKScriptMessageHandlerWithReply) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { return replyHandler(nil, "gone") }
        target.userContentController(ucc, didReceive: message, replyHandler: replyHandler)
    }
}

private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}

/// Opens Terminal windows running Claude Code in a task's workspace: a takeover, or a fork of a task's
/// session to go on with it myself, or the one-line install to upgrade. Every command is put together
/// here from quoted parts, never taken from the page as a string.
enum Terminal {
    private static var claude: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/claude").path
    }

    /// Takeover: `claude --resume <session> …` with the arguments the daemon built (its MCP config,
    /// settings and deny list). They arrive as a list and each is quoted here, so none of them can add
    /// a second command; only claude runs, and only to resume a session.
    static func takeover(cwd: String, args: [String]) {
        guard args.count >= 2, args[0] == "--resume", isSession(args[1]) else {
            NSLog("sidekick: refused takeover arguments")
            return
        }
        run(cwd: cwd, command: ([claude] + args).map(quote).joined(separator: " "))
    }

    private static func isSession(_ s: String) -> Bool {
        s.range(of: "^[0-9a-fA-F-]{36}$", options: .regularExpression) != nil
    }

    /// 「在 Claude 里继续」: a fork of the session, so mine and sidekick's never share a file. Built
    /// here from a session id and a name rather than taken as a command, so the page cannot add to it.
    static func continueSession(cwd: String, session: String, name: String?) {
        guard isSession(session) else {
            NSLog("sidekick: refused session id")
            return
        }
        var command = "\(quote(claude)) --resume \(session) --fork-session"
        let label = (name ?? "").components(separatedBy: .controlCharacters).joined(separator: " ").prefix(60)
        if !label.isEmpty { command += " -n \(quote(String(label)))" }
        run(cwd: cwd, command: command)
    }

    /// The one-line install, which is also how to upgrade (scripts/install.sh). Fixed here: the page
    /// can ask for it but cannot change what runs.
    static func upgrade() {
        run(cwd: FileManager.default.homeDirectoryForCurrentUser.path,
            command: "curl -fsSL https://raw.githubusercontent.com/lilong7676/sidekick/main/scripts/install.sh | bash")
    }

    private static func quote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func run(cwd: String, command: String) {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir), isDir.boolValue else {
            NSLog("sidekick: refused terminal directory")
            return
        }
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("sidekick", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("claude-\(Int(Date().timeIntervalSince1970)).command")
        let script = "#!/bin/zsh\ncd \(quote(cwd)) && \(command)\n"
        do {
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
            NSWorkspace.shared.open(file)
        } catch {
            NSLog("sidekick: could not open terminal: \(error)")
        }
    }
}
