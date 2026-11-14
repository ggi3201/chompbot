import XCTest
@testable import Chomp

final class VoiceChatTests: XCTestCase {
    func testJoinsShortSentencesUntilWorthARequest() {
        let pieces = VoiceChat.pieces(of: "Hi. Yes. The oven is preheating to 200 degrees now.\nDone!")
        XCTAssertEqual(pieces, ["Hi. Yes. The oven is preheating to 200 degrees now.", "Done!"])
    }

    func testSpeaksTextNotMarkdown() {
        let spoken = VoiceChat.spoken("## Plan\n- **Bold** and [a link](https://x.com)\n```\ncode\n```\n:::canvas\n{\"type\":\"x\"}\n:::")
        XCTAssertFalse(spoken.contains("**"))
        XCTAssertFalse(spoken.contains("https"))
        XCTAssertFalse(spoken.contains("canvas"))
        XCTAssertTrue(spoken.contains("Bold and a link"))
        XCTAssertTrue(spoken.contains("code block"))
    }
}
