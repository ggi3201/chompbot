import CoreLocation
import Foundation

/// REST client for the Chomp HTTP API. WebSocket is still the live-update
/// channel; this layer handles bootstrap reads (conversation list, message
/// history, agent list) and persistent mutations (pinning an agent to a
/// conversation) — the things that previously left the iOS chat blind to
/// server state.
struct ChompAPI {
    let config: AppConfig

    private var baseURL: URL? {
        guard !config.serverHost.isEmpty else { return nil }
        let scheme = config.useTLS ? "https" : "http"
        return URL(string: "\(scheme)://\(config.serverHost)")
    }

    private func authedRequest(path: String, method: String = "GET") -> URLRequest? {
        guard let base = baseURL, !config.jwt.isEmpty else { return nil }
        // Server mounts all REST routes under /api (see packages/api/src/index.ts).
        // The WebSocket lives at /ws (no prefix), which is why chat could connect
        // while every REST call here 404'd — that's what left the agent picker
        // empty and history un-fetchable.
        let fullPath = path.hasPrefix("/api/") ? path : "/api" + path
        guard let url = URL(string: fullPath, relativeTo: base) else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(config.jwt)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return req
    }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        // Server emits ISO-8601 timestamps as strings, SQLite's default
        // `2026-05-28 14:00:00` in UTC, or millis-since-epoch (some routes
        // return Unix ms in `createdAt`). The thread sorts by these, so a
        // wrong fallback here would reorder it.
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self),
               let d = iso8601Lenient.date(from: s) ?? iso8601.date(from: s) ?? sqliteDate.date(from: s) {
                return d
            }
            if let ms = try? c.decode(Double.self) {
                return Date(timeIntervalSince1970: ms / 1000)
            }
            return Date()
        }
        return d
    }()

    private static let iso8601Lenient: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601 = ISO8601DateFormatter()

    private static let sqliteDate: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()

    // MARK: - Conversations

    struct ConversationListItem: Decodable, Identifiable {
        let id: String
        let title: String?
        let pinned: Bool
        let tags: [String]
        let updatedAt: Date
        let running: Bool?
        let needsInput: Bool?
        let unread: Bool?
    }

    func listConversations() async throws -> [ConversationListItem] {
        guard let req = authedRequest(path: "/conversations") else {
            throw APIError.notConfigured
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return try Self.decoder.decode([ConversationListItem].self, from: data)
    }

    struct MessageDTO: Decodable, Identifiable {
        let id: String
        let role: String
        let content: String
        let agentUsed: String?
        let turnId: String?
        let createdAt: Date
        /// The server's own timestamp text, which `before` must repeat exactly to page back.
        let rawCreatedAt: String?

        private enum CodingKeys: String, CodingKey { case id, role, content, agentUsed, turnId, createdAt }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            role = try c.decode(String.self, forKey: .role)
            content = try c.decode(String.self, forKey: .content)
            agentUsed = try c.decodeIfPresent(String.self, forKey: .agentUsed)
            turnId = try c.decodeIfPresent(String.self, forKey: .turnId)
            createdAt = try c.decode(Date.self, forKey: .createdAt)
            rawCreatedAt = try? c.decode(String.self, forKey: .createdAt)
        }
    }

    /// The newest page, or the page before a message's time. `hasMore` says an older page exists.
    func listMessages(conversationId: String, before: String? = nil) async throws -> (messages: [MessageDTO], hasMore: Bool) {
        var path = "/conversations/\(conversationId)/messages?limit=\(Self.messagePageSize)"
        if let before, let encoded = before.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(["+", "&"])) {
            path += "&before=\(encoded)"
        }
        guard let req = authedRequest(path: path) else {
            throw APIError.notConfigured
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        let hasMore = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Has-More") == "true"
        return (try Self.decoder.decode([MessageDTO].self, from: data), hasMore)
    }

    /// Smaller than web's 200: a phone draws every row of the thread up front.
    static let messagePageSize = 60

    func listItems(conversationId: String) async throws -> [ChatItem] {
        guard let req = authedRequest(path: "/conversations/\(conversationId)/items") else {
            throw APIError.notConfigured
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return try Self.decoder.decode([ChatItem].self, from: data)
    }

    // MARK: - Uploads and voice

    func upload(_ data: Data, name: String, mimeType: String) async throws -> ChatAttachment {
        guard var req = authedRequest(path: "/uploads", method: "POST") else {
            throw APIError.notConfigured
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: ["data": data.base64EncodedString(), "name": name, "mimeType": mimeType])
        let (body, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: body)
        return try Self.decoder.decode(ChatAttachment.self, from: body)
    }

    func transcribe(_ audio: Data, mimeType: String) async throws -> String {
        struct Transcript: Decodable { let text: String }
        guard var req = authedRequest(path: "/voice/transcribe", method: "POST") else {
            throw APIError.notConfigured
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: ["data": audio.base64EncodedString(), "mimeType": mimeType])
        let (body, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: body)
        return try Self.decoder.decode(Transcript.self, from: body).text
    }

    /// Speech for a piece of text, as MP3, in the given voice (the server's default when nil).
    func speech(_ text: String, voice: String?) async throws -> Data {
        guard var req = authedRequest(path: "/voice/tts", method: "POST") else {
            throw APIError.notConfigured
        }
        var body = ["text": text]
        if let voice { body["voice"] = voice }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return data
    }

    func setSetting(_ key: String, to value: String) async throws {
        guard var req = authedRequest(path: "/settings/\(key)", method: "PUT") else {
            throw APIError.notConfigured
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: ["value": value])
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
    }

    /// The server's settings that are plain strings, such as `voice_auto_speak`.
    func settings() async throws -> [String: String] {
        guard let req = authedRequest(path: "/settings") else {
            throw APIError.notConfigured
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
    }

    // MARK: - Ask

    struct AskAnswer: Decodable {
        let conversationId: String
        /// Empty when the server stopped waiting. The answer then comes as a notification.
        let reply: String?
    }

    func ask(_ question: String, attachments: [ChatAttachment]) async throws -> AskAnswer {
        struct Ask: Encodable {
            let question: String
            let attachments: [ChatAttachment]
        }
        guard var req = authedRequest(path: "/ask", method: "POST") else {
            throw APIError.notConfigured
        }
        req.httpBody = try JSONEncoder().encode(Ask(question: question, attachments: attachments))
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return try Self.decoder.decode(AskAnswer.self, from: data)
    }

    // MARK: - Location

    func reportLocation(_ location: CLLocation, address: String?) async throws {
        guard var req = authedRequest(path: "/phone-location", method: "POST") else {
            throw APIError.notConfigured
        }
        var body: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracyMeters": location.horizontalAccuracy,
            "capturedAt": ISO8601DateFormatter().string(from: location.timestamp),
        ]
        if let address { body["address"] = address }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
    }

    // MARK: - Today

    struct Today: Decodable {
        struct Report: Decodable {
            struct Weather: Decodable {
                let summary: String
                let high: Double?
                let low: Double?
            }

            let place: String
            let headline: String
            let weather: Weather?
        }

        let report: Report?
        let reportUrl: URL?
    }

    func today() async throws -> Today {
        guard let req = authedRequest(path: "/today") else {
            throw APIError.notConfigured
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return try Self.decoder.decode(Today.self, from: data)
    }

    // MARK: - Souls

    /// A persona the agent answers as. The same list as the web chat's menu.
    struct Soul: Decodable, Identifiable {
        let id: String
        let name: String
        let description: String
        let isDefault: Bool
    }

    func listSouls() async throws -> [Soul] {
        guard let req = authedRequest(path: "/souls") else {
            throw APIError.notConfigured
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return try Self.decoder.decode([Soul].self, from: data)
    }

    // MARK: - Projects

    /// A git repo on the host that a new chat's agents can run in.
    struct Project: Decodable, Identifiable {
        let name: String
        let path: String
        var id: String { path }
    }

    func listProjects() async throws -> [Project] {
        guard let req = authedRequest(path: "/projects") else {
            throw APIError.notConfigured
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return try Self.decoder.decode([Project].self, from: data)
    }

    /// What a conversation last ran with, so it reopens on the same engine, model and soul.
    func lastSelection(conversationId: String) async throws -> StoredSelection {
        guard let req = authedRequest(path: "/conversations/\(conversationId)/last-selection") else {
            throw APIError.notConfigured
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return try Self.decoder.decode(StoredSelection.self, from: data)
    }

    func agentModels() async throws -> [AgentProviderModels] {
        guard let req = authedRequest(path: "/chat/agent-models") else {
            throw APIError.notConfigured
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return try Self.decoder.decode([AgentProviderModels].self, from: data)
    }

    // MARK: - Chat meta

    private func get<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        guard let req = authedRequest(path: path) else { throw APIError.notConfigured }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return try Self.decoder.decode(T.self, from: data)
    }

    /// What `/` and `@` offer in the composer.
    struct Completions: Decodable {
        struct Command: Decodable { let trigger: String; let label: String; let description: String }
        struct Agent: Decodable { let name: String; let type: String; let shorthands: [String] }
        let commands: [Command]
        let agents: [Agent]
    }

    func completions() async throws -> Completions {
        try await get("/chat/completions")
    }

    /// How full a chat's agent session is. Null before its first agent turn.
    struct ContextUsage: Decodable, Equatable {
        struct Category: Decodable, Equatable { let name: String; let tokens: Int }
        let provider: String
        let model: String?
        let usedTokens: Int
        let maxTokens: Int
        /// 0–100, may pass 100 just before the CLI compacts.
        let percent: Double
        let categories: [Category]
    }

    func context(conversationId: String) async throws -> ContextUsage? {
        try await get("/conversations/\(conversationId)/context")
    }

    /// A provider's plan limits: the 5-hour and weekly windows.
    struct ProviderUsage: Decodable, Equatable {
        struct Window: Decodable, Equatable, Identifiable { let id: String; let label: String; let percent: Double; let resetsAt: Date? }
        let provider: String
        let available: Bool
        let plan: String?
        let windows: [Window]
    }

    func usageLimits() async throws -> [ProviderUsage] {
        try await get("/chat/usage-limits")
    }

    /// The info sheet: where the agent runs, its sessions, and the chats this one came from or led to.
    struct ConversationInfo: Decodable {
        struct Git: Decodable { let branch: String?; let upstream: String?; let ahead: Int; let behind: Int; let files: Int; let insertions: Int; let deletions: Int }
        struct Project: Decodable { let name: String; let path: String; let git: Git? }
        struct Session: Decodable, Identifiable { let provider: String; let model: String?; let cwd: String?; let resume: String; var id: String { provider } }
        struct Link: Decodable, Identifiable { let id: String; let title: String?; let kind: String }
        let host: String
        let project: Project?
        let sessions: [Session]
        let parent: Link?
        let children: [Link]
    }

    func info(conversationId: String) async throws -> ConversationInfo {
        try await get("/conversations/\(conversationId)/info")
    }

    /// A new chat with everything up to the message. Returns its id.
    func fork(conversationId: String, messageId: String) async throws -> String {
        struct Forked: Decodable { let id: String }
        guard var req = authedRequest(path: "/conversations/\(conversationId)/fork", method: "POST") else {
            throw APIError.notConfigured
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: ["messageId": messageId])
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
        return try Self.decoder.decode(Forked.self, from: data).id
    }

    /// The chat is on screen: its replies count as read on every device.
    func markSeen(conversationId: String) async throws {
        guard let req = authedRequest(path: "/conversations/\(conversationId)/seen", method: "POST") else {
            throw APIError.notConfigured
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.ensureOK(response, data: data)
    }

    // MARK: -

    enum APIError: LocalizedError {
        case notConfigured
        case http(status: Int, body: String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Chat not configured (set server host + JWT in Settings)"
            case .http(let status, let body): return "HTTP \(status): \(body.prefix(200))"
            }
        }
    }

    private static func ensureOK(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        if !(200..<300).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw APIError.http(status: http.statusCode, body: body)
        }
    }
}
