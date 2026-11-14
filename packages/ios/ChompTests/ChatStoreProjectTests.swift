import XCTest
@testable import Chomp

@MainActor
final class ChatStoreProjectTests: XCTestCase {
    func testOnlyAFirstMessageUsesUpThePickedProject() {
        let store = ChatStore()
        store.conversations = [Conversation(id: "old", title: "Old", messages: [], updatedAt: .now)]
        store.selectConversation("old")
        store.newChatProject = "/code/chomp"

        store.send("into the old chat")
        XCTAssertEqual(store.newChatProject, "/code/chomp")

        store.newConversation()
        store.send("a new chat")
        XCTAssertNil(store.newChatProject)
    }

    func testTheLabelNamesTheProjectOnlyForANewChat() {
        let store = ChatStore()
        let selection = AgentSelection(provider: "claude", soulId: nil, model: "Opus", effort: nil, fast: false, access: "full")
        store.newChatProject = "/code/chomp"

        XCTAssertEqual(store.selectionLabel(selection, forNewChat: true), "chomp · Opus")
        XCTAssertEqual(store.selectionLabel(selection), "Opus")
    }

    func testThePayloadSaysSoOnlyWhenAProjectIsSet() throws {
        func json(_ chat: ChatClient.OutgoingChat) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(chat)) as? [String: Any])
        }
        let picked = try json(.init(content: "hi", conversationId: nil, projectPath: "/code/chomp", worktree: false))
        XCTAssertEqual(picked["projectPath"] as? String, "/code/chomp")
        XCTAssertEqual(picked["worktree"] as? Bool, false)

        let plain = try json(.init(content: "hi", conversationId: nil))
        XCTAssertNil(plain["projectPath"])
        XCTAssertNil(plain["worktree"])
    }
}
