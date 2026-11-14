import Foundation
import UserNotifications

@MainActor
final class NotificationTools {
    enum NotifyError: LocalizedError {
        case denied
        case scheduleFailed(String)
        var errorDescription: String? {
            switch self {
            case .denied: return "Notification permission denied"
            case .scheduleFailed(let s): return "Failed to schedule: \(s)"
            }
        }
    }

    /// Schedules a local notification. If afterSeconds is nil or 0, fires immediately
    /// (smallest legal delay is 1s for UNTimeIntervalNotificationTrigger).
    func notify(title: String, body: String, afterSeconds: TimeInterval?) async throws -> String {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            throw NotifyError.denied
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        let trigger: UNNotificationTrigger
        if let after = afterSeconds, after > 0 {
            trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(after, 1), repeats: false)
        } else {
            trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        }

        let id = UUID().uuidString
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        do {
            try await center.add(request)
        } catch {
            throw NotifyError.scheduleFailed(error.localizedDescription)
        }
        return id
    }
}
