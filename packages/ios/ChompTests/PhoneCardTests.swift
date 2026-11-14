import XCTest
@testable import Chomp

final class PhoneCardTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000_000)

    private func card(
        _ id: String,
        from: TimeInterval,
        until: TimeInterval,
        board: String = "travel",
        group: String = "trip",
        countdown: TimeInterval? = nil
    ) -> PhoneCard {
        PhoneCard(
            id: id,
            group: group,
            board: board,
            showFrom: start.addingTimeInterval(from),
            showUntil: start.addingTimeInterval(until),
            headline: id,
            detail: nil,
            countdownTo: countdown.map { start.addingTimeInterval($0) },
            alerts: [],
            icon: nil,
            tone: .normal,
            rows: [],
            link: nil,
            source: nil,
            checkedAt: nil
        )
    }

    func testShowingOnlyTheWindowAndEndingFirstOnTop() {
        let cards = [card("long", from: 0, until: 300), card("short", from: 0, until: 100), card("later", from: 200, until: 300)]
        XCTAssertEqual(cards.showing(at: start, board: nil).map(\.id), ["short", "long"])
        XCTAssertEqual(cards.showing(at: start.addingTimeInterval(100), board: nil).map(\.id), ["long"])
        XCTAssertEqual(cards.showing(at: start.addingTimeInterval(300), board: nil).map(\.id), [])
    }

    func testShowingFiltersByBoard() {
        let cards = [card("trip", from: 0, until: 100), card("home", from: 0, until: 100, board: "home")]
        XCTAssertEqual(cards.showing(at: start, board: "home").map(\.id), ["home"])
        XCTAssertEqual(cards.showing(at: start, board: nil).count, 2)
    }

    func testUpcomingIsSoonestFirstAndSkipsLaterStagesOfAGroupShowingNow() {
        let cards = [
            card("now", from: 0, until: 100),
            card("next stage", from: 100, until: 200),
            card("dinner", from: 500, until: 600, group: "dinner"),
            card("lunch", from: 300, until: 400, group: "lunch"),
            card("home", from: 300, until: 400, board: "home", group: "home"),
        ]
        XCTAssertEqual(cards.upcoming(after: start, board: "travel").map(\.id), ["lunch", "dinner"])
        XCTAssertEqual(cards.upcoming(after: start, board: nil).map(\.id), ["lunch", "home", "dinner"])
    }

    func testUpcomingIncludesAGroupThatIsNotShowingYet() {
        let cards = [card("first", from: 100, until: 200), card("second", from: 200, until: 300)]
        XCTAssertEqual(cards.upcoming(after: start, board: nil).map(\.id), ["first", "second"])
    }

    func testChangesAreUniqueSortedAndAhead() {
        let cards = [card("a", from: -100, until: 100), card("b", from: 100, until: 200), card("other", from: 50, until: 60, board: "home")]
        let offsets = cards.changes(after: start, board: "travel").map { $0.timeIntervalSince(start) }
        XCTAssertEqual(offsets, [100, 200])
    }

    func testChangesIncludeWhenACountdownStartsRunning() {
        let cards = [card("a", from: 0, until: 200_000, countdown: 100_000)]
        let offsets = cards.changes(after: start, board: nil).map { $0.timeIntervalSince(start) }
        XCTAssertEqual(offsets, [100_000 - PhoneCard.countdownRange, 200_000])
    }

    func testDecodesServerJSON() throws {
        let json = """
        [{"id":"1","group":"trip","board":"travel","showFrom":"2026-11-10T07:00:00.000Z","showUntil":"2026-11-10T11:30:00.000Z",\
        "headline":"Flight today","detail":null,"countdownTo":"2026-11-10T11:50:00.000Z",\
        "alerts":[{"at":"2026-11-10T11:35:00.000Z","text":"Leave soon"}],"icon":"airplane","tone":"urgent",\
        "rows":[{"label":"Gate","value":"B12"}],"link":"https://example.com/pass","source":null,"checkedAt":null}]
        """
        let cards = try PhoneCardStore.decoder.decode([PhoneCard].self, from: Data(json.utf8))
        XCTAssertEqual(cards.first?.headline, "Flight today")
        XCTAssertNil(cards.first?.detail)
        XCTAssertEqual(cards.first?.showFrom, Date(timeIntervalSince1970: 1_794_294_000))
        XCTAssertEqual(cards.first?.alerts.first?.text, "Leave soon")
        XCTAssertEqual(cards.first?.tone, .urgent)
        XCTAssertEqual(cards.first?.rows.first?.value, "B12")
        XCTAssertEqual(cards.first?.link?.host, "example.com")
    }

    func testLinkSurvivesTheTripThroughTheApp() throws {
        let link = try XCTUnwrap(URL(string: "https://example.com/pass?id=1&seat=14A#top"))
        let opening = try XCTUnwrap(PhoneCardLink.opening(link))
        XCTAssertEqual(opening.scheme, "chomp")
        XCTAssertEqual(PhoneCardLink.target(of: opening), link)
    }

    func testOtherURLsAreNotOpenedAsLinks() throws {
        XCTAssertNil(PhoneCardLink.target(of: try XCTUnwrap(URL(string: "https://example.com/open?url=https://x.com"))))
        XCTAssertNil(PhoneCardLink.target(of: try XCTUnwrap(URL(string: "chomp://other?url=https://x.com"))))
    }
}
