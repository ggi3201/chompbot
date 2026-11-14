import Foundation
import Combine
import EventKit
import HealthKit

/// WebSocket client for Chomp's /device-bridge endpoint.
///
/// Mirrors the protocol implemented in packages/api/src/device-bridge/protocol.ts:
///   - C→S: hello (with tools), tool_result, event, heartbeat
///   - S→C: welcome, tool_call, heartbeat, error
///
/// Reconnect discipline: at most one reconnect is pending at a time, and
/// `reconnectAttempt` is only reset after we've received a server message
/// (e.g. `welcome`) — so a sequence of fast handshake-then-close cycles
/// backs off exponentially instead of looping forever.
@MainActor
final class DeviceBridgeClient: NSObject, ObservableObject {
    @Published private(set) var status: String = "idle"
    @Published private(set) var lastEventLog: [String] = []
    @Published private(set) var connection: ConnectionStatus = .off("Sign in first")

    private var task: URLSessionWebSocketTask?
    private lazy var session: URLSession = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    private let registry: BridgeToolRegistry
    private var shouldRun = false
    private var reconnectAttempt = 0
    private var reconnectScheduled = false
    private var hasReceivedData = false
    private var unsentResults: [String] = []

    init(eventStore: EKEventStore,
         healthStore: HKHealthStore,
         bookmarks: FileBookmarkStore) {
        self.registry = BridgeToolRegistry(
            eventStore: eventStore,
            healthStore: healthStore,
            bookmarks: bookmarks
        )
        super.init()
    }

    func connectIfConfigured() async {
        guard let url = AppConfig.shared.deviceBridgeURL else {
            status = "Not configured"
            connection = .off("Sign in first")
            return
        }
        shouldRun = true
        openSocket(url: url)
    }

    func disconnect() {
        shouldRun = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        status = "Disconnected"
        connection = .off("Off")
    }

    private func openSocket(url: URL) {
        // Cancel any stale task before allocating a new one so its delegate /
        // receive callbacks don't fire a second reconnect under our feet.
        task?.cancel(with: .goingAway, reason: nil)
        status = "Connecting…"
        connection = .connecting
        let t = session.webSocketTask(with: URLRequest(url: url))
        task = t
        hasReceivedData = false
        t.resume()
        listen(on: t)
        sendHello()
    }

    private func sendHello() {
        let cfg = AppConfig.shared
        let hello: [String: Any] = [
            "type": "hello",
            "deviceId": cfg.deviceId,
            "deviceName": cfg.deviceName,
            "platform": "ios",
            "tools": registry.list().map { $0.toDictionary() },
        ]
        sendJSON(hello)
    }

    private func sendJSON(_ object: [String: Any]) {
        guard let task else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: object, options: [])
            if let text = String(data: data, encoding: .utf8) {
                task.send(.string(text)) { _ in }
            }
        } catch {
            log("encode error: \(error.localizedDescription)")
        }
    }

    /// A Shortcut can outlast the socket, because Chomp is in the background while it runs.
    /// The server keeps waiting for that call, so its result goes out after reconnecting.
    private func sendResult(_ text: String) {
        guard let task else {
            unsentResults.append(text)
            return
        }
        task.send(.string(text)) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor [weak self] in self?.unsentResults.append(text) }
        }
    }

    private func runToolCall(callId: String, name: String, args: [String: Any]) async {
        let result = await registry.call(name: name, args: args)
        var payload: [String: Any] = [
            "type": "tool_result",
            "callId": callId,
            "ok": result.ok,
        ]
        if result.ok {
            payload["result"] = result.payload
        } else {
            payload["error"] = result.payload as? String ?? "Unknown error"
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else {
            log("encode error for \(name)")
            return
        }
        sendResult(text)
    }

    private func listen(on owned: URLSessionWebSocketTask) {
        owned.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self else { return }
                // Ignore callbacks for stale tasks (cancelled or replaced).
                guard owned === self.task else { return }
                switch result {
                case .failure(let err):
                    self.log("recv error: \(err.localizedDescription)")
                    self.scheduleReconnect(reason: err.localizedDescription)
                case .success(let message):
                    self.hasReceivedData = true
                    switch message {
                    case .string(let text):
                        await self.handle(text: text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            await self.handle(text: text)
                        }
                    @unknown default:
                        break
                    }
                    self.listen(on: owned)
                }
            }
        }
    }

    private func handle(text: String) async {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "welcome":
            let sid = json["sessionId"] as? String ?? "?"
            status = "Connected (\(sid.prefix(8)))"
            connection = .connected(since: Date())
            log("welcome sessionId=\(sid)")
            let unsent = unsentResults
            unsentResults = []
            unsent.forEach(sendResult)
        case "tool_call":
            let callId = json["callId"] as? String ?? ""
            let name = json["name"] as? String ?? ""
            let args = json["args"] as? [String: Any] ?? [:]
            log("tool_call \(name)(callId=\(String(callId.prefix(6))))")
            // Not awaited: a Shortcut can take minutes, and this loop also has to notice a dead socket.
            Task { await runToolCall(callId: callId, name: name, args: args) }
        case "heartbeat":
            break
        case "error":
            let err = json["error"] as? String ?? "Unknown server error"
            log("server error: \(err)")
        default:
            log("unknown \(type)")
        }
    }

    private func scheduleReconnect(reason: String) {
        guard shouldRun, let url = AppConfig.shared.deviceBridgeURL else { return }
        guard !reconnectScheduled else { return }
        reconnectScheduled = true
        if hasReceivedData {
            reconnectAttempt = 1
            hasReceivedData = false
        } else {
            reconnectAttempt += 1
        }
        status = "Disconnected (\(reason))"
        connection = .failed(reason)
        let delay = min(pow(2.0, Double(reconnectAttempt)), 30.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.reconnectScheduled = false
                if self.shouldRun { self.openSocket(url: url) }
            }
        }
    }

    private func log(_ msg: String) {
        lastEventLog.append("\(Date().formatted(.iso8601.time(includingFractionalSeconds: false))) \(msg)")
        if lastEventLog.count > 100 { lastEventLog.removeFirst(lastEventLog.count - 100) }
    }

    nonisolated var availableToolNames: [String] {
        // Tools are static at init time; safe to read off-actor.
        [
            "read_clipboard", "set_clipboard", "get_battery", "get_device_info", "speak", "vibrate",
            "get_location",
            "list_events", "create_event", "list_reminders", "add_reminder",
            "search_contact",
            "list_recent_photos", "read_photo", "save_image",
            "notify",
            "run_shortcut", "open_url",
            "list_picked_files", "read_picked_file",
            "get_steps_today", "get_active_energy_today", "get_heart_rate_recent", "get_sleep_last_night",
        ]
    }
}

extension DeviceBridgeClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Skip stale-task callbacks so they don't queue a redundant reconnect
            // on top of the one the receive-loop already started.
            guard webSocketTask === self.task else { return }
            self.scheduleReconnect(reason: "close \(closeCode.rawValue)")
        }
    }
}
