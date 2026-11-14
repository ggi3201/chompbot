import Foundation
import Combine

/// What the user chose to share. The iOS permission says what the app may do. This says what it does.
enum LocationMode: String, CaseIterable, Identifiable {
    case whenIMove, whileOpen, off

    var id: String { rawValue }

    var title: String {
        switch self {
        case .whenIMove: return "When I move"
        case .whileOpen: return "Only while open"
        case .off: return "Off"
        }
    }
}

// Persistent, user-editable settings. UserDefaults is plenty for personal use;
// swap to Keychain if anyone ever ships this further than the home network.
final class AppConfig: ObservableObject {
    static let shared = AppConfig()
    /// From CHOMP_BUNDLE_ID at build time (Info.plist ChompAppGroup), so the app and widget share one container.
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "ChompAppGroup") as? String ?? "group.com.example.chomp"

    private let store: UserDefaults

    @Published var serverHost: String {
        didSet { store.set(serverHost, forKey: Keys.serverHost) }
    }
    @Published var jwt: String {
        didSet { store.set(jwt, forKey: Keys.jwt) }
    }
    @Published var deviceId: String {
        didSet { store.set(deviceId, forKey: Keys.deviceId) }
    }
    @Published var deviceName: String {
        didSet { store.set(deviceName, forKey: Keys.deviceName) }
    }
    @Published var useTLS: Bool {
        didSet { store.set(useTLS, forKey: Keys.useTLS) }
    }
    /// Nil until the user picks one.
    @Published var locationMode: LocationMode? {
        didSet { store.set(locationMode?.rawValue, forKey: Keys.locationMode) }
    }

    /// The store the app shares with its widget. Settings saved before the
    /// widget existed live in the app's own store, so they are copied across.
    static func sharedStore() -> UserDefaults {
        guard let shared = UserDefaults(suiteName: appGroup) else { return .standard }
        for key in Keys.all where shared.object(forKey: key) == nil {
            if let value = UserDefaults.standard.object(forKey: key) {
                shared.set(value, forKey: key)
            }
        }
        return shared
    }

    init(
        store: UserDefaults = AppConfig.sharedStore(),
        defaultServerHost: String = Bundle.main.object(forInfoDictionaryKey: "ChompDefaultServerHost") as? String ?? ""
    ) {
        self.store = store
        self.serverHost = store.string(forKey: Keys.serverHost) ?? defaultServerHost
        self.jwt = store.string(forKey: Keys.jwt) ?? ""
        self.deviceId = store.string(forKey: Keys.deviceId) ?? "iphone-\(Self.shortRandom())"
        self.deviceName = store.string(forKey: Keys.deviceName) ?? "iPhone"
        self.useTLS = store.object(forKey: Keys.useTLS) as? Bool ?? true
        self.locationMode = store.string(forKey: Keys.locationMode).flatMap(LocationMode.init)
        // didSet does not run in init. Unsaved, each launch would register as another device.
        store.set(deviceId, forKey: Keys.deviceId)
    }

    /// Where relative links in chat point, like `/api/uploads/photo.jpg`.
    var serverURL: URL? {
        guard !serverHost.isEmpty else { return nil }
        return URL(string: "\(useTLS ? "https" : "http")://\(serverHost)")
    }

    var chatWebSocketURL: URL? {
        guard !serverHost.isEmpty, !jwt.isEmpty else { return nil }
        let scheme = useTLS ? "wss" : "ws"
        var c = URLComponents()
        c.scheme = scheme
        c.host = serverHost
        c.path = "/ws"
        c.queryItems = [URLQueryItem(name: "token", value: jwt)]
        return c.url
    }

    var deviceBridgeURL: URL? {
        guard !serverHost.isEmpty, !jwt.isEmpty else { return nil }
        let scheme = useTLS ? "wss" : "ws"
        var c = URLComponents()
        c.scheme = scheme
        c.host = serverHost
        c.path = "/device-bridge"
        c.queryItems = [URLQueryItem(name: "token", value: jwt)]
        return c.url
    }

    var isChatConfigured: Bool { chatWebSocketURL != nil }
    var isBridgeConfigured: Bool { deviceBridgeURL != nil }

    private static func shortRandom() -> String {
        let alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
        return String((0..<6).map { _ in alphabet.randomElement()! })
    }

    private enum Keys {
        static let serverHost = "config.serverHost"
        static let jwt = "config.jwt"
        static let deviceId = "config.deviceId"
        static let deviceName = "config.deviceName"
        static let useTLS = "config.useTLS"
        static let locationMode = "config.locationMode"
        static let all = [serverHost, jwt, deviceId, deviceName, useTLS, locationMode]
    }
}
