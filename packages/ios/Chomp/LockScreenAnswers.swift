import Foundation
import UserNotifications

/// Answers what an agent asked, from the notification itself, while the app
/// runs in the background. The server is the only judge of whether an answer
/// counted, so anything but its yes tells the user the answer did not count.
enum LockScreenAnswers {
    static let approvalCategory = "CHOMP_APPROVAL"
    static let questionCategory = "CHOMP_QUESTION"
    static let approveAction = "APPROVE"
    static let declineAction = "DECLINE"
    static let replyAction = "REPLY"

    /// Approving, or answering in words, can let the agent act, so both need
    /// Face ID. Declining stops it, which anyone holding the phone may do.
    static var categories: Set<UNNotificationCategory> {
        [
            UNNotificationCategory(
                identifier: approvalCategory,
                actions: [
                    UNNotificationAction(identifier: approveAction, title: "Approve", options: [.authenticationRequired]),
                    UNNotificationAction(identifier: declineAction, title: "Decline", options: [.destructive]),
                ],
                intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: "An agent needs approval",
                options: []
            ),
            UNNotificationCategory(
                identifier: questionCategory,
                actions: [
                    UNTextInputNotificationAction(
                        identifier: replyAction,
                        title: "Reply",
                        options: [.authenticationRequired],
                        textInputButtonTitle: "Send",
                        textInputPlaceholder: "Your answer"
                    ),
                ],
                intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: "An agent has a question",
                options: []
            ),
        ]
    }

    /// The request a notification with an action was pushed for, and the call that answers it.
    struct Answer: Equatable {
        let path: String
        let body: [String: String]
        var isApproval: Bool { body["decision"] == "accept" }
    }

    enum Outcome: Equatable {
        case sent, ended, signedOut, notSent
    }

    static func answer(userInfo: [AnyHashable: Any], action: String, text: String?) -> Answer? {
        guard let chomp = userInfo["chomp"] as? [String: Any] else { return nil }
        switch (chomp["kind"] as? String, action) {
        case ("approval", approveAction), ("approval", declineAction):
            guard let conversationId = chomp["conversationId"] as? String, let requestId = chomp["requestId"] as? String else { return nil }
            return Answer(
                path: "/api/agent-requests/approval",
                body: ["conversationId": conversationId, "requestId": requestId, "decision": action == approveAction ? "accept" : "decline"]
            )
        case ("question", replyAction):
            guard let sessionId = chomp["sessionId"] as? String, let questionId = chomp["questionId"] as? String,
                  let text, !text.isEmpty else { return nil }
            return Answer(path: "/api/agent-requests/question", body: ["sessionId": sessionId, "questionId": questionId, "answer": text])
        default:
            return nil
        }
    }

    /// Two tries, because the network can need a moment after the phone wakes.
    /// Together they stay inside the ~30s iOS gives a background action.
    static func send(_ answer: Answer, config: AppConfig = .shared, session: URLSession = .shared) async -> Outcome {
        let scheme = config.useTLS ? "https" : "http"
        guard !config.jwt.isEmpty, let url = URL(string: "\(scheme)://\(config.serverHost)\(answer.path)") else { return .signedOut }
        var request = URLRequest(url: url, timeoutInterval: 9)
        request.httpMethod = "POST"
        request.setValue("Bearer \(config.jwt)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(answer.body)

        for attempt in 1...2 {
            if let (_, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse {
                switch http.statusCode {
                case 200..<300: return .sent
                case 409: return .ended
                case 401, 403: return .signedOut
                default: return .notSent
                }
            }
            if attempt == 1 { try? await Task.sleep(nanoseconds: 1_000_000_000) }
        }
        return .notSent
    }

    /// What the user reads when an answer did not count. Nil when it did.
    static func notice(for outcome: Outcome, answer: Answer) -> (title: String, body: String)? {
        switch outcome {
        case .sent:
            return nil
        case .ended:
            return ("Too late", answer.isApproval ? "This request has ended. Nothing was approved." : "This request has ended. Your answer was not used.")
        case .signedOut:
            return ("Not sent", "Open Chomp and sign in again. The agent did not get your answer.")
        case .notSent:
            return ("Not sent", answer.isApproval ? "Chomp could not be reached. Nothing was approved. Try again." : "Chomp could not be reached. The agent did not get your answer. Try again.")
        }
    }

    static func handle(_ response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let text = (response as? UNTextInputNotificationResponse)?.userText
        guard let answer = answer(userInfo: content.userInfo, action: response.actionIdentifier, text: text) else { return }
        let outcome = await send(answer)
        guard let notice = notice(for: outcome, answer: answer) else { return }

        let failure = UNMutableNotificationContent()
        failure.title = notice.title
        failure.body = notice.body
        failure.sound = .default
        // Worth another try only when the server never heard it, so only then do the buttons come back.
        if outcome == .notSent {
            failure.categoryIdentifier = content.categoryIdentifier
            failure.userInfo = content.userInfo
        }
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: failure, trigger: nil))
    }

    /// The request ended elsewhere: take its notification away. A push may not
    /// arrive (iOS rations silent ones), in which case the server's 409 still
    /// tells the user their answer came too late.
    static func removeWithdrawn(userInfo: [AnyHashable: Any]) async {
        guard let id = (userInfo["chomp"] as? [String: Any])?["withdrawn"] as? String else { return }
        let center = UNUserNotificationCenter.current()
        let delivered = await center.deliveredNotifications()
        let matching = delivered.filter { ($0.request.content.userInfo["chomp"] as? [String: Any])?["id"] as? String == id }
        center.removeDeliveredNotifications(withIdentifiers: matching.map(\.request.identifier))
    }
}
