import UserNotifications

/// Local notifications for the cards. The phone holds them itself, so they fire with no network.
enum PhoneCardAlerts {
    private static let idPrefix = "phone-card-"

    static func schedule(_ cards: [PhoneCard]) async {
        let center = UNUserNotificationCenter.current()
        let stale = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(idPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: stale)

        for card in cards {
            for (index, alert) in card.alerts.enumerated() where alert.at > .now {
                let content = UNMutableNotificationContent()
                content.title = card.headline
                content.body = alert.text
                content.sound = .default
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: alert.at.timeIntervalSinceNow, repeats: false)
                let request = UNNotificationRequest(identifier: "\(idPrefix)\(card.id)-\(index)", content: content, trigger: trigger)
                do {
                    try await center.add(request)
                } catch {
                    print("[phone-cards] scheduling an alert failed: \(error.localizedDescription)")
                }
            }
        }
    }
}
