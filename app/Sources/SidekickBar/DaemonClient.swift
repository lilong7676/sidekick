import Foundation

/// Where the daemon listens and the token it expects. Written by the daemon on start (0600).
struct Runtime: Decodable, Equatable {
    let port: Int
    let token: String
    /// The running daemon's version, and its binary's mtime in whole seconds (null when run from a
    /// checkout). A binary in this app with another mtime is an upgrade the daemon has not picked up.
    let version: String?
    let binaryMtime: Int?
}

/// Missing while the daemon waits to be set up (no workspace yet).
struct DaemonState: Decodable {
    let pendingApprovals: Int?
    let attention: Int?
    /** 设置 → 通知 → macOS 通知. */
    let notifyMacos: Bool?
    /** Interface language the daemon resolved: "zh" or "en" (Lang.swift). */
    let lang: String?
    /** Reply drafts I deleted in Slack lately (queries.ts recentlyDeletedDrafts): offer to carry on in Claude. */
    let draftsDeleted: [DeletedDraft]?
}

struct DeletedDraft: Decodable {
    let approvalId: String
    let taskId: String
    let title: String
}

/** POST /api/tasks/:id/continue (queries.ts continueInClaude): the desktop app is opened by the daemon; Terminal is ours. */
struct Continued: Decodable {
    let `where`: String
    let cwd: String
    let session: String
    let name: String?
}

struct ApprovalItem: Decodable {
    struct Input: Decodable { let command: String? }
    struct Payload: Decodable {
        let tool_name: String?
        let text: String?
        let input: Input?
    }
    let id: String
    let task_id: String
    let kind: String
    let task_title: String?
    let payload: Payload
}

struct TaskItem: Decodable {
    let id: String
    let status: String
    let title: String
    let summary: String?
}

enum DaemonError: Error {
    case notRunning
    case http(Int, String)
}

/// Talks to the sidekick daemon's local API (src/server.ts).
final class DaemonClient {
    static let runtimeURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/sidekick/runtime.json")

    func runtime() -> Runtime? {
        guard let data = try? Data(contentsOf: Self.runtimeURL) else { return nil }
        return try? JSONDecoder().decode(Runtime.self, from: data)
    }

    func baseURL(_ rt: Runtime) -> URL {
        URL(string: "http://127.0.0.1:\(rt.port)")!
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        guard let rt = runtime() else { throw DaemonError.notRunning }
        // Resolve as a URL string so a query (?filter=…) is not percent-encoded into the path.
        guard let url = URL(string: path, relativeTo: baseURL(rt)) else { throw DaemonError.http(0, "bad path \(path)") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 10
        req.setValue("Bearer \(rt.token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw DaemonError.http(status, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await request(path))
    }

    func post(_ path: String, body: [String: Any] = [:]) async throws {
        _ = try await request(path, method: "POST", body: body)
    }

    func state() async throws -> DaemonState { try await get("/api/state", as: DaemonState.self) }
    func approvals() async throws -> [ApprovalItem] { try await get("/api/approvals", as: [ApprovalItem].self) }
    func attentionTasks() async throws -> [TaskItem] { try await get("/api/tasks?filter=attention", as: [TaskItem].self) }

    func approve(_ id: String) async throws { try await post("/api/approvals/\(id)/approve") }

    func continueTask(_ id: String) async throws -> Continued {
        try JSONDecoder().decode(Continued.self, from: try await request("/api/tasks/\(id)/continue", method: "POST", body: [:]))
    }

    func deny(_ id: String, note: String?) async throws {
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        try await post("/api/approvals/\(id)/deny", body: trimmed.isEmpty ? [:] : ["note": trimmed])
    }
}
