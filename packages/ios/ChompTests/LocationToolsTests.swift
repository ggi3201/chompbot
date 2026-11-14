import CoreLocation
import XCTest
@testable import Chomp

final class LocationToolsTests: XCTestCase {
    func testAlwaysWorksLocked() {
        XCTAssertNil(LocationTools.blocker(mode: .whenIMove, status: .authorizedAlways, appIsActive: false))
    }

    func testWhenInUseWorksOnlyWithTheAppOpen() {
        XCTAssertNil(LocationTools.blocker(mode: .whenIMove, status: .authorizedWhenInUse, appIsActive: true))
        XCTAssertEqual(LocationTools.blocker(mode: .whenIMove, status: .authorizedWhenInUse, appIsActive: false), .needsAlways)
    }

    func testNotAskedCanOnlyPromptWithTheAppOpen() {
        XCTAssertNil(LocationTools.blocker(mode: .whenIMove, status: .notDetermined, appIsActive: true))
        XCTAssertEqual(LocationTools.blocker(mode: .whenIMove, status: .notDetermined, appIsActive: false), .needsAlways)
    }

    func testOffBlocksEveryRead() {
        XCTAssertEqual(LocationTools.blocker(mode: .off, status: .authorizedAlways, appIsActive: true), .turnedOff)
    }

    func testWhileOpenBlocksBackgroundReadsEvenWithAlways() {
        XCTAssertNil(LocationTools.blocker(mode: .whileOpen, status: .authorizedAlways, appIsActive: true))
        XCTAssertEqual(LocationTools.blocker(mode: .whileOpen, status: .authorizedAlways, appIsActive: false), .onlyWhileOpen)
    }

    func testAlwaysKeepsBackgroundUpdatesAndNobodyElseGetsThem() {
        XCTAssertEqual(LocationMode.standard(for: .authorizedAlways), .whenIMove)
        XCTAssertEqual(LocationMode.standard(for: .authorizedWhenInUse), .whileOpen)
        XCTAssertEqual(LocationMode.standard(for: .notDetermined), .whileOpen)
    }

    func testDeniedIsDeniedEverywhere() {
        XCTAssertEqual(LocationTools.blocker(mode: .whenIMove, status: .denied, appIsActive: true), .denied)
        XCTAssertEqual(LocationTools.blocker(mode: .whenIMove, status: .restricted, appIsActive: false), .denied)
    }
}

final class ShortcutsToolsTests: XCTestCase {
    func testRunURLKeepsCallbacksAsOneValueEach() throws {
        let url = try XCTUnwrap(ShortcutsTools.runURL(name: "Tip & Go", input: "a=1&b=2", id: "abc"))
        let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }

        XCTAssertEqual(url.host, "x-callback-url")
        XCTAssertEqual(url.path, "/run-shortcut")
        XCTAssertEqual(value("name"), "Tip & Go")
        XCTAssertEqual(value("input"), "text")
        XCTAssertEqual(value("text"), "a=1&b=2")
        XCTAssertEqual(value("x-success"), "chomp://shortcut/success?id=abc")
        XCTAssertEqual(value("x-cancel"), "chomp://shortcut/cancel?id=abc")
        XCTAssertEqual(value("x-error"), "chomp://shortcut/error?id=abc")
    }

    func testRunURLLeavesOutEmptyInput() throws {
        let url = try XCTUnwrap(ShortcutsTools.runURL(name: "Hello", input: "", id: "abc"))
        XCTAssertFalse(url.absoluteString.contains("input="))
    }

    func testCallbackReadsEachOutcome() throws {
        func outcome(_ link: String) throws -> ShortcutsTools.Outcome? {
            ShortcutsTools.callback(from: try XCTUnwrap(URL(string: link)))?.outcome
        }
        XCTAssertEqual(try outcome("chomp://shortcut/success?id=a&result=hi%20there"), .finished("hi there"))
        XCTAssertEqual(try outcome("chomp://shortcut/success?id=a"), .finished(""))
        XCTAssertEqual(try outcome("chomp://shortcut/cancel?id=a"), .cancelled)
        XCTAssertEqual(try outcome("chomp://shortcut/error?id=a&errorMessage=Nope"), .failed("Nope"))
    }

    func testOtherURLsAreNotCallbacks() throws {
        for link in ["chomp://open?url=https://a.no", "chomp://shortcut/success", "https://shortcut/success?id=a", "chomp://shortcut/other?id=a"] {
            XCTAssertNil(ShortcutsTools.callback(from: try XCTUnwrap(URL(string: link))), link)
        }
    }
}
