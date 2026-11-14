import XCTest
@testable import Chomp

final class AppConfigTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "ChompTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults?.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    func testDeviceIdStaysTheSameAcrossLaunches() {
        XCTAssertEqual(AppConfig(store: defaults).deviceId, AppConfig(store: defaults).deviceId)
    }

    func testChatWebSocketURLEncodesTokenAndPath() {
        let cfg = AppConfig(store: defaults)
        cfg.serverHost = "example.ts.net"
        cfg.useTLS = true
        cfg.jwt = "abc.def.ghi"
        let url = cfg.chatWebSocketURL
        XCTAssertEqual(url?.scheme, "wss")
        XCTAssertEqual(url?.host, "example.ts.net")
        XCTAssertEqual(url?.path, "/ws")
        XCTAssertTrue(url?.query?.contains("token=abc.def.ghi") ?? false)
    }

    func testChatWebSocketURLNilWhenJWTMissing() {
        let cfg = AppConfig(store: defaults)
        cfg.serverHost = "example.ts.net"
        cfg.jwt = ""
        XCTAssertNil(cfg.chatWebSocketURL)
    }

    func testBridgeURLUsesTheLogin() {
        let cfg = AppConfig(store: defaults)
        cfg.serverHost = "example.ts.net"
        cfg.useTLS = false
        XCTAssertNil(cfg.deviceBridgeURL)
        cfg.jwt = "abc.def.ghi"
        let url = cfg.deviceBridgeURL
        XCTAssertEqual(url?.scheme, "ws")
        XCTAssertEqual(url?.path, "/device-bridge")
        XCTAssertTrue(url?.query?.contains("token=abc.def.ghi") ?? false)
    }

    func testLocationModeSurvivesARelaunch() {
        XCTAssertNil(AppConfig(store: defaults).locationMode)
        AppConfig(store: defaults).locationMode = .off
        XCTAssertEqual(AppConfig(store: defaults).locationMode, .off)
    }

    func testDefaultsSeedFromInitialValues() {
        let cfg = AppConfig(store: defaults, defaultServerHost: "")
        XCTAssertEqual(cfg.serverHost, "")
        XCTAssertTrue(cfg.useTLS)
        XCTAssertEqual(cfg.jwt, "")
        cfg.jwt = "abc.def.ghi"
        XCTAssertNil(cfg.chatWebSocketURL)
        XCTAssertNil(cfg.deviceBridgeURL)
    }

    func testConfiguredHostSeedsANewInstall() {
        let cfg = AppConfig(store: defaults, defaultServerHost: "chomp.example.com")
        XCTAssertEqual(cfg.serverHost, "chomp.example.com")
    }

    func testSavedHostTakesPrecedenceOverBuildDefault() {
        let cfg = AppConfig(store: defaults, defaultServerHost: "chomp.example.com")
        cfg.serverHost = "my-server.example.com"
        XCTAssertEqual(
            AppConfig(store: defaults, defaultServerHost: "another.example.com").serverHost,
            "my-server.example.com"
        )
    }

    func testClearedHostStaysEmptyAfterRelaunch() {
        AppConfig(store: defaults, defaultServerHost: "chomp.example.com").serverHost = ""
        XCTAssertEqual(AppConfig(store: defaults, defaultServerHost: "chomp.example.com").serverHost, "")
    }
}
