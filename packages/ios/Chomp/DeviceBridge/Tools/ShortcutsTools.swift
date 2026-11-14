import Foundation
import UIKit

/// Opens other apps, and runs Apple Shortcuts through x-callback-url so their text output
/// comes back. iOS only lets an app open another app while it is on screen.
@MainActor
final class ShortcutsTools {
    static let shared = ShortcutsTools()

    enum ShortcutsError: LocalizedError {
        case notOnScreen
        case invalidURL(String)
        case openFailed(String)
        case busy
        case cancelled
        case failed(String)
        case timedOut

        var errorDescription: String? {
            switch self {
            case .notOnScreen: return "Chomp must be on screen to open another app. Ask the user to open Chomp and try again."
            case .invalidURL(let url): return "Not a valid URL: \(url)"
            case .openFailed(let url): return "iOS could not open \(url). The app may not be installed."
            case .busy: return "Another Shortcut is still running."
            case .cancelled: return "The Shortcut was cancelled."
            case .failed(let message): return "The Shortcut failed: \(message)\nIt may have run some or all of its actions first. If it does not exist, ask the user to import or create it."
            case .timedOut: return "The Shortcut has not finished after 2 minutes. It may still be running."
            }
        }
    }

    enum Outcome: Equatable {
        case finished(String)
        case cancelled
        case failed(String)
    }

    private var waiting: (id: String, continuation: CheckedContinuation<String, Error>)?
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid

    private init() {}

    func open(_ url: URL) async throws {
        guard UIApplication.shared.applicationState == .active else { throw ShortcutsError.notOnScreen }
        guard await UIApplication.shared.open(url) else { throw ShortcutsError.openFailed(url.absoluteString) }
    }

    func run(name: String, input: String?, timeout: TimeInterval = 120) async throws -> [String: Any] {
        guard waiting == nil else { throw ShortcutsError.busy }
        let id = UUID().uuidString
        guard let url = Self.runURL(name: name, input: input, id: id) else {
            throw ShortcutsError.invalidURL(name)
        }
        // Chomp is in the background until Shortcuts calls back, and short Shortcuts should not lose the socket.
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "chomp-shortcut") { [weak self] in
            MainActor.assumeIsolated { self?.endBackgroundTask() }
        }
        defer { endBackgroundTask() }

        let output = try await withCheckedThrowingContinuation { continuation in
            waiting = (id, continuation)
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finish(id: id, .failure(ShortcutsError.timedOut))
            }
            Task { [weak self] in
                do {
                    try await self?.open(url)
                } catch {
                    self?.finish(id: id, .failure(error))
                }
            }
        }
        return ["name": name, "output": output]
    }

    /// Takes a callback from Shortcuts. Returns false when the URL is something else.
    func handleCallback(_ url: URL) -> Bool {
        guard let (id, outcome) = Self.callback(from: url) else { return false }
        switch outcome {
        case .finished(let output): finish(id: id, .success(output))
        case .cancelled: finish(id: id, .failure(ShortcutsError.cancelled))
        case .failed(let message): finish(id: id, .failure(ShortcutsError.failed(message)))
        }
        return true
    }

    private func finish(id: String, _ result: Result<String, Error>) {
        guard let waiting, waiting.id == id else { return }
        self.waiting = nil
        waiting.continuation.resume(with: result)
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    nonisolated static func runURL(name: String, input: String?, id: String) -> URL? {
        // URLQueryItem leaves ":" and "/" as they are, and the callbacks must arrive as one value.
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        func encoded(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
        func callback(_ kind: String) -> String { encoded("chomp://shortcut/\(kind)?id=\(id)") }

        var query = ["name=\(encoded(name))"]
        if let input, !input.isEmpty {
            query += ["input=text", "text=\(encoded(input))"]
        }
        query += ["x-success=\(callback("success"))", "x-cancel=\(callback("cancel"))", "x-error=\(callback("error"))"]
        return URL(string: "shortcuts://x-callback-url/run-shortcut?" + query.joined(separator: "&"))
    }

    nonisolated static func callback(from url: URL) -> (id: String, outcome: Outcome)? {
        guard url.scheme == "chomp", url.host == "shortcut",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let id = items.first(where: { $0.name == "id" })?.value else { return nil }
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        switch url.lastPathComponent {
        case "success": return (id, .finished(value("result") ?? ""))
        case "cancel": return (id, .cancelled)
        case "error": return (id, .failed(value("errorMessage") ?? "Unknown error"))
        default: return nil
        }
    }
}
