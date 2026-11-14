import SwiftUI

@main
struct ChompApp: App {
    @UIApplicationDelegateAdaptor(ChompAppDelegate.self) var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var config = AppConfig.shared
    @StateObject private var chatStore = ChatStore()
    /// One voice session for the app, so one started on Home carries on in the thread it opens.
    @StateObject private var voice = VoiceChat()
    @StateObject private var permissions: PermissionsManager
    @StateObject private var bookmarks: FileBookmarkStore
    @StateObject private var bridge: DeviceBridgeClient

    init() {
        let perms = PermissionsManager()
        let books = FileBookmarkStore()
        _permissions = StateObject(wrappedValue: perms)
        _bookmarks = StateObject(wrappedValue: books)
        let bridgeClient = DeviceBridgeClient(
            eventStore: perms.eventStore,
            healthStore: perms.healthStore,
            bookmarks: books
        )
        _bridge = StateObject(wrappedValue: bridgeClient)
        // Push coordinator wakes the bridge on silent push.
        PushNotificationsCoordinator.shared.bridge = bridgeClient
        PushNotificationsCoordinator.shared.start()

        let titleText: [NSAttributedString.Key: Any] = [.foregroundColor: UIColor(Theme.textPrimary)]
        UINavigationBar.appearance().titleTextAttributes = titleText
        UINavigationBar.appearance().largeTitleTextAttributes = titleText
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
                .environmentObject(config)
                .environmentObject(chatStore)
                .environmentObject(voice)
                .environmentObject(bridge)
                .environmentObject(permissions)
                .environmentObject(bookmarks)
                .task {
                    await chatStore.connectIfConfigured()
                    await bridge.connectIfConfigured()
                }
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active else { return }
                    Task { await PhoneCardSync.run() }
                    LocationReporter.shared.refresh()
                }
                .onOpenURL { url in
                    if ShortcutsTools.shared.handleCallback(url) { return }
                    guard let link = PhoneCardLink.target(of: url) else { return }
                    UIApplication.shared.open(link)
                }
        }
    }
}
