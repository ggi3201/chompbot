import XCTest
@testable import Chomp

final class ComposerAutocompleteTests: XCTestCase {
    private let completions = ChompAPI.Completions(
        commands: [
            .init(trigger: "/help", label: "Help", description: "What you can do"),
            .init(trigger: "/handoff", label: "Hand off", description: "Open a new chat"),
            .init(trigger: "/compact", label: "Compact", description: "Free up context"),
        ],
        agents: [.init(name: "Alfred", type: "agent", shorthands: ["al"])]
    )
    private let chats = [
        Conversation(id: "aaaaaaaa-1111", title: "Trip to Oslo", messages: [], updatedAt: .now),
        Conversation(id: "bbbbbbbb-2222", title: "This chat", messages: [], updatedAt: .now),
    ]

    private func match(_ draft: String) -> [String]? {
        ComposerAutocomplete.match(draft, completions: completions, chats: chats, activeId: "bbbbbbbb-2222")?.items.map(\.insert)
    }

    func testSlashOffersCommandsByPrefix() {
        XCTAssertEqual(match("/h"), ["/help ", "/handoff "])
        XCTAssertEqual(match("look at this /comp"), ["/compact "])
    }

    func testAtOffersSoulsAndOtherChatsButNotThisOne() {
        XCTAssertEqual(match("@"), ["@Alfred ", "@session:aaaaaaaa "])
        XCTAssertEqual(match("ask @al"), ["@Alfred "])
        XCTAssertEqual(match("see @oslo"), ["@session:aaaaaaaa "])
    }

    func testOnlyTheWordBeingTypedCounts() {
        XCTAssertNil(match("plain text"))
        XCTAssertNil(match("a/b"))
        XCTAssertNil(match("/help "))
    }

    func testThePickReplacesTheTypedWord() throws {
        let draft = "please /han"
        let found = try XCTUnwrap(ComposerAutocomplete.match(draft, completions: completions, chats: [], activeId: nil))
        XCTAssertEqual(String(draft[..<found.start]) + found.items[0].insert, "please /handoff ")
    }
}

final class ChangedFileTests: XCTestCase {
    private func change(_ path: String, _ add: Int, _ del: Int, status: String = "completed") throws -> ChatItem {
        let json = """
        {"id":"\(UUID())","conversationId":"c","turnId":"t","seq":1,"createdAt":"2026-11-12T06:00:00Z","kind":"file_change","status":"\(status)",
         "files":[{"path":"\(path)","diff":"","additions":\(add),"deletions":\(del)}]}
        """
        return try ChompAPI.decoder.decode(ChatItem.self, from: Data(json.utf8))
    }

    func testLinesAddUpPerFileAndDeclinedChangesDoNotCount() throws {
        let files = ChangedFile.from([
            try change("src/a.ts", 3, 1),
            try change("src/b.ts", 5, 0),
            try change("src/a.ts", 2, 2),
            try change("src/b.ts", 9, 9, status: "declined"),
        ])
        XCTAssertEqual(files, [
            ChangedFile(path: "src/a.ts", additions: 5, deletions: 3),
            ChangedFile(path: "src/b.ts", additions: 5, deletions: 0),
        ])
        XCTAssertEqual(files[0].name, "a.ts")
        XCTAssertEqual(files[0].dir, "src")
    }
}
