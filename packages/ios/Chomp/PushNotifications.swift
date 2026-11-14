import UIKit
import UserNotifications

/// Bridges iOS APNs registration into the Chomp app:
/// - asks for notification permission on launch
/// - registers for remote (silent) push
/// - receives the device token, ships it to the Chomp server via REST
/// - on `didReceiveRemoteNotification`, reconnects the device-bridge WS so
///   the just-pasted silent push has a live socket for the server to talk to
///
/// The actual notification UI is suppressed (we only use silent pushes), so
/// the user never sees a banner from this — it's purely a wake mechanism.
final class PushNotificationsCoordinator: NSObject {
    static let shared = PushNotificationsCoordinator()

    weak var bridge: DeviceBridgeClient?

    /// Call from `ChompApp.init` after the bridge is wired up. Idempotent.
    func start() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories(LockScreenAnswers.categories)
        Task { @MainActor in
            do {
                _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            } catch {
                print("[push] request authorization failed: \(error.localizedDescription)")
            }
            // Silent pushes work even without alert authorization — but
            // registering for remote notifications is what gets us a token.
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Called from the AppDelegate-style callback below.
    func handleDeviceToken(_ token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        Task { await self.sendTokenToServer(hex) }
    }

    private func sendTokenToServer(_ apnsToken: String) async {
        let config = AppConfig.shared
        guard !config.serverHost.isEmpty, !config.jwt.isEmpty else {
            print("[push] server/jwt not configured; skipping device-token POST")
            return
        }
        let scheme = config.useTLS ? "https" : "http"
        guard let url = URL(string: "\(scheme)://\(config.serverHost)/api/device-tokens") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(config.jwt)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        let body: [String: Any] = [
            "deviceId": config.deviceId,
            "apnsToken": apnsToken,
            "platform": "ios",
            "environment": environment,
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (_, response) = try await URLSession.shared.data(for: req)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                print("[push] POST /device-tokens returned \(http.statusCode)")
            } else {
                print("[push] device token registered (\(apnsToken.prefix(12))…)")
            }
        } catch {
            print("[push] POST /device-tokens failed: \(error.localizedDescription)")
        }
    }

    /// Wake the bridge after a silent push lands. iOS gives us ~30s of
    /// background time per push; reconnecting the WS is fast (<1s) and the
    /// agent's `phone_call_tool` will hit the now-live socket. The push may also
    /// mean the widget's cards changed, so they are fetched at the same time.
    func handleSilentPush(completion: @escaping (UIBackgroundFetchResult) -> Void) {
        Task { @MainActor in
            async let cardSync: Void = PhoneCardSync.run()
            if let bridge = self.bridge {
                bridge.disconnect()
                await bridge.connectIfConfigured()
            }
            // Give the WS a moment to send `hello` before we yield background time.
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await cardSync
            completion(.newData)
        }
    }
}

extension PushNotificationsCoordinator: UNUserNotificationCenterDelegate {
    // Silent pushes don't fire willPresent/didReceive — they go straight to
    // the AppDelegate's didReceiveRemoteNotification:fetchCompletionHandler.
    // We implement the UNUserNotificationCenter methods anyway in case we
    // start sending visible notifications in the future.

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    /// The completion runs only after the answer's request ended, so iOS keeps the app alive for it.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task {
            await LockScreenAnswers.handle(response)
            completionHandler()
        }
    }
}

/// SwiftUI-app-friendly AppDelegate shim. Wired in via `@UIApplicationDelegateAdaptor`.
final class ChompAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        LocationReporter.shared.start()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushNotificationsCoordinator.shared.handleDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[push] APNs registration failed: \(error.localizedDescription)")
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task { await LockScreenAnswers.removeWithdrawn(userInfo: userInfo) }
        // Wake the bridge and yield.
        PushNotificationsCoordinator.shared.handleSilentPush(completion: completionHandler)
    }
}
