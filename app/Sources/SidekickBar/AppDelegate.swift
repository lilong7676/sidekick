import AppKit
import ServiceManagement

/// Menu bar item: left click toggles the panel, right click shows the menu. The badge is the
/// number of things waiting for me (pending approvals + needs-me + failed). The same page can
/// also open in a normal window, which then gets a Dock icon and ⌘Tab like any app.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var panel: WebPanel!
    private var window: NSWindow?
    private var windowPanel: WebPanel?
    private var notifier: Notifier!
    private let client = DaemonClient()
    private var timer: Timer?
    private var lastRuntime: Runtime?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Without a main menu an accessory app has nowhere to route ⌘V / ⌘C / ⌘A, so paste
        // silently does nothing in the web view. The menu stays invisible but its shortcuts work.
        NSApp.mainMenu = Self.mainMenu()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "sidekick")
            image?.isTemplate = true
            button.image = image
            button.imagePosition = .imageLeading
            button.target = self
            button.action = #selector(clicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        panel = makePanel(size: NSSize(width: 440, height: 680))
        popover = NSPopover()
        popover.behavior = .transient
        popover.contentSize = NSSize(width: 440, height: 680)
        popover.contentViewController = panel

        notifier = Notifier(client: client) { [weak self] taskId in self?.openTask(taskId) }

        // The daemon lives in this app: register it, or restart it after an upgrade.
        DaemonService.ensure(runtime: client.runtime())

        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func makePanel(size: NSSize) -> WebPanel {
        WebPanel(client: client, size: size,
                 onBadgeRefresh: { [weak self] in self?.refresh() },
                 onOpenWindow: { [weak self] in self?.openWindow() },
                 onLanguage: { [weak self] in self?.apply(lang: $0) })
    }

    /// The language the daemon resolved. When it changes, rebuild what was built once in the old one:
    /// the main menu (shown while the window is open) and the notification buttons. The right-click
    /// menu, the tooltip and each notification are built when used, so they follow on their own.
    private func apply(lang: String?) {
        guard UILang.update(from: lang) else { return }
        NSApp.mainMenu = Self.mainMenu()
        notifier.registerCategories()
    }

    private static func mainMenu() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: L("关闭窗口", "Close window"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appMenu.addItem(withTitle: L("退出 Sidekick", "Quit Sidekick"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: L("编辑", "Edit"))
        edit.addItem(withTitle: L("撤销", "Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: L("重做", "Redo"), action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: L("剪切", "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L("拷贝", "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L("粘贴", "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: L("全选", "Select all"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        return main
    }

    @objc private func clicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu()
        } else {
            togglePopover()
        }
    }

    private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            panel.reload(force: false)
        }
    }

    private func openTask(_ taskId: String) {
        if let window, window.isVisible {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            windowPanel?.show(taskId: taskId)
            return
        }
        if !popover.isShown { togglePopover() }
        panel.show(taskId: taskId)
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: L("打开窗口", "Open window"), action: #selector(openWindow), keyEquivalent: "").target = self
        menu.addItem(withTitle: L("重新加载", "Reload"), action: #selector(reloadAll), keyEquivalent: "r").target = self
        menu.addItem(withTitle: L("重启 daemon", "Restart daemon"), action: #selector(restartDaemon), keyEquivalent: "").target = self
        menu.addItem(.separator())
        let login = NSMenuItem(title: L("开机自动启动", "Launch at login"), action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(withTitle: L("退出 Sidekick", "Quit Sidekick"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil // keep left click for the panel
    }

    @objc private func openWindow() {
        popover.performClose(nil)
        if window == nil {
            let p = makePanel(size: NSSize(width: 960, height: 760))
            let w = NSWindow(contentViewController: p)
            w.title = "Sidekick"
            w.setContentSize(NSSize(width: 960, height: 760))
            w.styleMask.insert([.resizable, .miniaturizable])
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.setFrameAutosaveName("SidekickMainWindow")
            windowPanel = p
            window = w
        }
        // A real window behaves like a real app while it is open: Dock icon, ⌘Tab, focus.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        // Back to a menu bar app once the window is gone.
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Clicking the Dock icon brings the window back.
        if !flag { openWindow() }
        return true
    }

    @objc private func reloadAll() {
        panel.reload()
        windowPanel?.reload()
        refresh()
    }

    /// Restart the launchd job. Works even when the daemon is stuck and its API does not answer.
    @objc private func restartDaemon() {
        if DaemonService.kickstart() {
            // The panels pick up the new port / token on the next refresh.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.refresh() }
        } else {
            let alert = NSAlert()
            alert.messageText = L("重启 daemon 失败", "Couldn't restart the daemon")
            alert.informativeText = L("daemon 状态：\(DaemonService.statusText)。", "Daemon status: \(DaemonService.statusText).")
            alert.runModal()
        }
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = L("设置开机启动失败", "Couldn't change Launch at login")
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    /// Poll the daemon: badge, notifications, and reload the panels if the daemon restarted.
    private func refresh() {
        let rt = client.runtime()
        if rt != lastRuntime {
            lastRuntime = rt
            panel.reload()
            windowPanel?.reload()
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                let state = try await client.state()
                await MainActor.run { self.apply(lang: state.lang) }
                let approvals = try await client.approvals()
                let tasks = try await client.attentionTasks()
                await MainActor.run {
                    self.setBadge(state.attention ?? 0, online: true)
                    self.notifier.announce(approvals: approvals, tasks: tasks, show: state.notifyMacos ?? true)
                    self.notifier.announceDeleted(state.draftsDeleted ?? [], show: state.notifyMacos ?? true)
                }
            } catch {
                await MainActor.run { self.setBadge(0, online: false) }
            }
        }
    }

    private func setBadge(_ count: Int, online: Bool) {
        guard let button = statusItem.button else { return }
        button.title = count > 0 ? " \(count)" : ""
        button.appearsDisabled = !online
        button.toolTip = !online ? L("连不上 sidekick daemon", "Can't reach the sidekick daemon")
            : count == 0 ? "sidekick"
            : L("\(count) 件事要你处理", count == 1 ? "1 thing needs you" : "\(count) things need you")
    }
}
