import ThinkingOrbsKit
import XCTest
@testable import Chomp

final class AgentOrbStateTests: XCTestCase {
    private func entry(_ fields: String) throws -> TimelineEntry {
        let text = #"{"id":"a","conversationId":"c1","turnId":"t1","seq":1,"createdAt":"2026-11-07T00:00:00Z","updatedAt":"2026-11-07T00:00:00Z",\#(fields)}"#
        return .item(try ChompAPI.decoder.decode(ChatItem.self, from: Data(text.utf8)))
    }

    func testFollowsWhatTheLatestItemIsDoing() throws {
        XCTAssertEqual(agentOrbState(for: try entry(#""kind":"reasoning","text":"","streaming":true"#)), .solving)
        XCTAssertEqual(agentOrbState(for: try entry(#""kind":"assistant_text","text":"","streaming":true"#)), .composing)
        XCTAssertEqual(agentOrbState(for: try entry(#""kind":"tool_call","tool":"WebSearch","title":"","status":"running""#)), .searching)
        XCTAssertEqual(agentOrbState(for: try entry(#""kind":"tool_call","tool":"Read","title":"","status":"running""#)), .searching)
        XCTAssertEqual(agentOrbState(for: try entry(#""kind":"tool_call","tool":"send_imessage","title":"","status":"running""#)), .working)
        XCTAssertEqual(agentOrbState(for: try entry(#""kind":"file_change","files":[],"status":"running""#)), .shaping)
    }

    func testFinishedItemsAndOtherEntriesJustShowWork() throws {
        XCTAssertEqual(agentOrbState(for: try entry(#""kind":"tool_call","tool":"Read","title":"","status":"completed""#)), .working)
        XCTAssertEqual(agentOrbState(for: try entry(#""kind":"reasoning","text":"","streaming":false"#)), .working)
        XCTAssertEqual(agentOrbState(for: nil), .working)
    }
}
