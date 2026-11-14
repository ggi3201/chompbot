import Foundation

/// Thin URLSessionWebSocketTask wrapper that handles connect/reconnect and
/// dispatches JSON events. Caller drives the conversation; this client owns
/// the socket lifecycle only.
///
/// Speaks the agent runtime's `item` / `items` events and sends `approval`,
/// `afterSeq` and the composer's selection with every message.
///
/// Reconnect discipline: at most one reconnect is pending at a time, and
/// `reconnectAttempt` is only reset once we've actually received a server
/// message — so a sequence of fast handshake-then-close cycles backs off
/// exponentially instead of looping at 2s forever.
final class ChatClient: NSObject {
    typealias EventHandler = (ChatEvent) -> Void
    typealias StateHandler = (ConnectionState) -> Void

    enum ConnectionState: Equatable {
        case idle
        case connecting
        case connected
        case disconnected(reason: String)
    }

    private var task: URLSessionWebSocketTask?
    private lazy var session: URLSession = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    private var url: URL?
    private var onEvent: EventHandler?
    private var onState: StateHandler?
    private(set) var state: ConnectionState = .idle {
        didSet { onState?(state) }
    }
    private var shouldRun = false
    private var reconnectAttempt = 0
    private var reconnectScheduled = false
    private var hasReceivedData = false

    func connect(url: URL, onEvent: @escaping EventHandler, onState: @escaping StateHandler) {
        self.url = url
        self.onEvent = onEvent
        self.onState = onState
        self.shouldRun = true
        openSocket()
    }

    func disconnect() {
        shouldRun = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .disconnected(reason: "Closed by client")
    }

    private func openSocket() {
        guard shouldRun, let url else { return }
        // Replace any pre-existing task before allocating the next one — this
        // both stops its receive loop and prevents stale delegate callbacks
        // from triggering further reconnects under our feet.
        task?.cancel(with: .goingAway, reason: nil)
        state = .connecting
        let req = URLRequest(url: url)
        let t = session.webSocketTask(with: req)
        task = t
        hasReceivedData = false
        t.resume()
        listen(on: t)
    }

    private func scheduleReconnect(reason: String) {
        guard shouldRun else { return }
        guard !reconnectScheduled else { return }
        reconnectScheduled = true
        if hasReceivedData {
            // We had a working session — reset the backoff for a quick first retry.
            reconnectAttempt = 1
            hasReceivedData = false
        } else {
            reconnectAttempt += 1
        }
        state = .disconnected(reason: reason)
        let delay = min(pow(2.0, Double(reconnectAttempt)), 30.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.reconnectScheduled = false
            self.openSocket()
        }
    }

    /// Bind the receive loop to a specific task so a late callback for an
    /// already-cancelled socket can't trigger a reconnect for the new one.
    private func listen(on owned: URLSessionWebSocketTask) {
        owned.receive { [weak self] result in
            guard let self else { return }
            // Only act if `owned` is still the active task.
            guard owned === self.task else { return }
            switch result {
            case .failure(let err):
                self.scheduleReconnect(reason: err.localizedDescription)
            case .success(let message):
                self.hasReceivedData = true
                if self.state != .connected { self.state = .connected }
                switch message {
                case .string(let text):
                    self.handle(text: text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handle(text: text)
                    }
                @unknown default:
                    break
                }
                self.listen(on: owned)
            }
        }
    }

    private func handle(text: String) {
        guard let data = text.data(using: .utf8) else { return }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        let convId = json["conversationId"] as? String

        switch type {
        case "conversation":
            // Server assigns the real conversationId for a freshly-started chat.
            // Arrives before the first agent_message, so the store can migrate
            // its local placeholder conversation to this id.
            if let convId { onEvent?(.conversationStarted(id: convId)) }
        case "agent_message":
            let id = json["id"] as? String ?? UUID().uuidString
            let content = json["content"] as? String ?? ""
            let agentUsed = json["agentUsed"] as? String
            onEvent?(.agentMessage(id: id, content: content, agentUsed: agentUsed, turnId: json["turnId"] as? String, conversationId: convId))
        case "item":
            if let item = json["item"] { onEvent?(.items(decodeItems([item]))) }
        case "items":
            if let items = json["items"] as? [Any] { onEvent?(.items(decodeItems(items))) }
        case "chunk":
            onEvent?(.chunk(json["content"] as? String ?? "", conversationId: convId))
        case "agent_progress":
            let status = json["status"] as? String ?? ""
            let elapsed = json["elapsedSeconds"] as? Int ?? 0
            onEvent?(.agentProgress(status: status, elapsedSeconds: elapsed, conversationId: convId))
        case "agent_activity":
            let activity = json["activity"] as? [String: Any]
            let text = activity?["text"] as? String ?? activity?["summary"] as? String ?? ""
            onEvent?(.agentActivity(text: text, conversationId: convId))
        case "question":
            let sid = json["sessionId"] as? String ?? ""
            let q = json["question"] as? String ?? ""
            onEvent?(.question(sessionId: sid, question: q, conversationId: convId))
        case "sync_complete":
            var last: ChatMessage? = nil
            if let lm = json["lastMessage"] as? [String: Any] {
                last = ChatMessage(
                    id: lm["id"] as? String ?? UUID().uuidString,
                    role: .assistant,
                    content: lm["content"] as? String ?? "",
                    createdAt: Date(),
                    agentUsed: lm["agentUsed"] as? String
                )
            }
            onEvent?(.syncComplete(conversationId: convId, lastMessage: last))
        case "done":
            // Agent turns end with their reply in `done.replyMessage` or
            // `done.content`. A streamed reply only needs its id from `messageId`.
            let messageId = json["messageId"] as? String
            let reply = (json["replyMessage"] as? [String: Any]) ?? (json["content"] as? String).flatMap { content -> [String: Any]? in
                content.isEmpty ? nil : ["id": messageId as Any, "content": content]
            }
            let message = reply.flatMap { fields -> ChatMessage? in
                guard let content = fields["content"] as? String, !content.isEmpty else { return nil }
                return ChatMessage(
                    id: fields["id"] as? String ?? UUID().uuidString,
                    role: .assistant,
                    content: content,
                    createdAt: Date(),
                    agentUsed: fields["agentUsed"] as? String ?? json["agentUsed"] as? String,
                    turnId: fields["turnId"] as? String ?? json["turnId"] as? String
                )
            }
            onEvent?(.done(reply: message, messageId: messageId, conversationId: convId))
        case "handoff":
            if let convId, let content = json["content"] as? String { onEvent?(.handoff(conversationId: convId, content: content)) }
        case "cancelled":
            onEvent?(.cancelled)
        case "heartbeat":
            onEvent?(.heartbeat)
        case "error":
            let err = json["error"] as? String ?? "Unknown error"
            onEvent?(.error(err))
        default:
            onEvent?(.unknown(type: type))
        }
    }

    private func decodeItems(_ raw: [Any]) -> [ChatItem] {
        raw.compactMap { value in
            guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
            return try? ChompAPI.decoder.decode(ChatItem.self, from: data)
        }
    }

    // MARK: - Sending

    struct OutgoingChat: Encodable {
        let type = "chat"
        let content: String
        let conversationId: String?
        var attachments: [ChatAttachment]? = nil
        var provider: String? = nil
        var model: String? = nil
        var effort: String? = nil
        var fast: Bool? = nil
        var access: String? = nil
        var soulId: String? = nil
        var projectPath: String? = nil
        var worktree: Bool? = nil
        var channelContext: String? = nil
        /// Send now: end the running turn and run this as a new one.
        var interrupt: Bool? = nil
        /// The chat a handoff note came from, sent with the new chat's first message.
        var handoffFrom: String? = nil
    }

    struct OutgoingSync: Encodable {
        let type = "sync"
        let conversationId: String?
        var afterSeq: Int? = nil
    }

    struct OutgoingAnswer: Encodable {
        let type = "answer"
        let sessionId: String
        let answer: String
    }

    struct OutgoingApproval: Encodable {
        let type = "approval"
        let conversationId: String
        let requestId: String
        let decision: String
    }

    struct OutgoingCancel: Encodable {
        let type = "cancel"
    }

    func send<E: Encodable>(_ payload: E) {
        guard let task else { return }
        do {
            let data = try JSONEncoder().encode(payload)
            if let text = String(data: data, encoding: .utf8) {
                task.send(.string(text)) { _ in }
            }
        } catch {
            // Encoding our own structs shouldn't fail.
        }
    }
}

extension ChatClient: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        // Only react if this is the active task — a late open callback for a
        // task we've already cancelled shouldn't move the UI state.
        guard webSocketTask === self.task else { return }
        state = .connected
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        // Ignore close callbacks for stale tasks — they would otherwise queue
        // a redundant reconnect on top of the one the receive-loop already did.
        guard webSocketTask === self.task else { return }
        let r = reason.flatMap { String(data: $0, encoding: .utf8) } ?? "Closed (\(closeCode.rawValue))"
        scheduleReconnect(reason: r)
    }
}
