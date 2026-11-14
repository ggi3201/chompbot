import CoreLocation
import XCTest
@testable import Chomp

final class ChatTimelineTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000_000)

    private func message(_ id: String, _ role: ChatMessage.Role, at seconds: TimeInterval, content: String = "text", turn: String? = nil) -> ChatMessage {
        ChatMessage(id: id, role: role, content: content, createdAt: start.addingTimeInterval(seconds), agentUsed: nil, turnId: turn)
    }

    private func item(_ id: String, seq: Int, at seconds: TimeInterval, json: String, turn: String = "t1", parent: String? = nil) throws -> ChatItem {
        let date = ISO8601DateFormatter().string(from: start.addingTimeInterval(seconds))
        let parentField = parent.map { "\"parentId\":\"\($0)\"," } ?? ""
        let text = """
        {"id":"\(id)","conversationId":"c1","turnId":"\(turn)","seq":\(seq),\(parentField)"createdAt":"\(date)","updatedAt":"\(date)",\(json)}
        """
        return try ChompAPI.decoder.decode(ChatItem.self, from: Data(text.utf8))
    }

    private func tool(_ id: String, seq: Int, at seconds: TimeInterval, turn: String = "t1", name: String = "Read", status: String = "completed") throws -> ChatItem {
        try item(id, seq: seq, at: seconds, json: #""kind":"tool_call","tool":"\#(name)","title":"Read a file","status":"\#(status)""#, turn: turn)
    }

    func testDecodesEveryKindOfItem() throws {
        let tool = try tool("a", seq: 1, at: 0)
        XCTAssertEqual(tool.body, .toolCall(tool: "Read", title: "Read a file", input: nil, output: nil, status: .completed))

        let command = try item("b", seq: 2, at: 0, json: #""kind":"command","command":"ls","output":"x","exitCode":null,"status":"running""#)
        XCTAssertEqual(command.body, .command(command: "ls", cwd: nil, output: "x", exitCode: nil, status: .running))

        let files = try item("c", seq: 3, at: 0, json: #""kind":"file_change","files":[{"path":"a.ts","kind":"update","diff":"+x","additions":1,"deletions":0}],"status":"completed""#)
        XCTAssertEqual(files.body, .fileChange(files: [.init(path: "a.ts", diff: "+x", additions: 1, deletions: 0)], status: .completed))

        let approval = try item("d", seq: 4, at: 0, json: #""kind":"approval","requestId":"r1","title":"Run command","detail":"rm","state":"pending""#)
        XCTAssertEqual(approval.body, .approval(requestId: "r1", title: "Run command", detail: "rm", state: "pending", oneTime: false))

        let send = try item("f", seq: 6, at: 0, json: #""kind":"approval","requestId":"r2","title":"Send to Far","detail":"Hei","state":"pending","oneTime":true"#)
        XCTAssertEqual(send.body, .approval(requestId: "r2", title: "Send to Far", detail: "Hei", state: "pending", oneTime: true))

        let unknown = try item("e", seq: 5, at: 0, json: #""kind":"from_the_future""#)
        XCTAssertEqual(unknown.body, .other)
    }

    func testDecodesSQLiteAndISOTimes() throws {
        struct Dated: Decodable { let at: Date }
        let sqlite = try ChompAPI.decoder.decode(Dated.self, from: Data(#"{"at":"1970-01-12 13:46:40"}"#.utf8))
        let iso = try ChompAPI.decoder.decode(Dated.self, from: Data(#"{"at":"1970-01-12T13:46:40Z"}"#.utf8))
        XCTAssertEqual(sqlite.at, start)
        XCTAssertEqual(iso.at, start)
    }

    func testUpsertReplacesByIdAndIgnoresOlderSeq() throws {
        let first = try item("a", seq: 5, at: 0, json: #""kind":"error","message":"new""#)
        let older = try item("a", seq: 3, at: 0, json: #""kind":"error","message":"old""#)
        let newer = try item("a", seq: 9, at: 0, json: #""kind":"error","message":"newest""#)
        XCTAssertEqual([first].upserting([older]).first?.body, .error(message: "new"))
        XCTAssertEqual([first].upserting([newer]).first?.body, .error(message: "newest"))
        XCTAssertEqual([first].upserting([newer]).maxSeq, 9)
    }

    func testFoldsConsecutiveWorkOfATurnBetweenMessages() throws {
        let entries = ChatTimeline.build(
            messages: [message("u", .user, at: 0), message("a", .assistant, at: 10)],
            items: [try tool("x", seq: 1, at: 1), try tool("y", seq: 2, at: 2)],
            liveTurn: nil
        )
        XCTAssertEqual(entries.map(\.id), ["message-u", "work-x", "message-a"])
        guard case .work(_, _, let items, let live) = entries[1] else { return XCTFail("expected work") }
        XCTAssertEqual(items.map(\.id), ["x", "y"])
        XCTAssertFalse(live)
    }

    func testWorkIsLiveWhileItsTurnRunsOrAToolIsRunning() throws {
        let done = [try tool("x", seq: 1, at: 1)]
        guard case .work(_, _, _, let liveTurn) = ChatTimeline.build(messages: [], items: done, liveTurn: "t1")[0] else { return XCTFail() }
        XCTAssertTrue(liveTurn)
        let running = [try tool("x", seq: 1, at: 1, status: "running")]
        guard case .work(_, _, _, let liveTool) = ChatTimeline.build(messages: [], items: running, liveTurn: nil)[0] else { return XCTFail() }
        XCTAssertTrue(liveTool)
    }

    func testAReplyAnItemAlreadyShowsBecomesOnlyAFooter() throws {
        let text = try item("x", seq: 1, at: 1, json: #""kind":"assistant_text","text":"Hello","streaming":false"#)
        let entries = ChatTimeline.build(
            messages: [message("a", .assistant, at: 2, content: " Hello\n", turn: "t1"), message("b", .assistant, at: 3, content: "Other", turn: "t1")],
            items: [text],
            liveTurn: nil
        )
        XCTAssertEqual(entries.map(\.id), ["item-x", "footer-a", "message-b"])
    }

    func testHidesTheReplyToolSubagentsAndTheirWork() throws {
        let entries = ChatTimeline.build(
            messages: [],
            items: [
                try tool("reply", seq: 1, at: 0, name: "mcp__chomp-api__reply"),
                try item("sub", seq: 2, at: 0, json: #""kind":"subagent","name":"Explore","description":"x","status":"running","toolUses":0,"tokens":0,"durationMs":0"#),
                try item("child", seq: 3, at: 0, json: #""kind":"tool_call","tool":"Read","title":"x","status":"completed""#, parent: "sub"),
            ],
            liveTurn: nil
        )
        XCTAssertEqual(entries, [])
    }

    func testSummaryCountsToolsCommandsAndUniqueFiles() throws {
        let change = #""kind":"file_change","files":[{"path":"a","kind":"update","diff":"","additions":1,"deletions":0}],"status":"completed""#
        let items = [
            try tool("x", seq: 1, at: 0),
            try tool("y", seq: 2, at: 0),
            try item("z", seq: 3, at: 0, json: #""kind":"command","command":"ls","output":"","exitCode":0,"status":"completed""#),
            try item("v", seq: 4, at: 0, json: change),
            try item("w", seq: 5, at: 0, json: change),
        ]
        XCTAssertEqual(ChatTimeline.summary(of: items), "Used 2 tools, ran 1 command, changed 1 file")
        XCTAssertEqual(ChatTimeline.summary(of: []), "Worked")
    }
}

final class CanvasBlockTests: XCTestCase {
    func testSplitsTextAndBlocksInOrder() {
        let content = """
        Before

        :::canvas
        {"type":"info-card","title":"BTC","value":104230}
        :::

        After ![photo](/api/uploads/a.jpg)
        """
        let segments = MessageSegment.parse(content)
        XCTAssertEqual(segments.count, 3)
        guard case .text(let before) = segments[0], case .canvas(.infoCard(let metric)) = segments[1], case .text(let after) = segments[2] else {
            return XCTFail("unexpected segments: \(segments)")
        }
        XCTAssertTrue(before.contains("Before"))
        XCTAssertEqual(metric.title, "BTC")
        XCTAssertEqual(metric.value.value, "104230")
        XCTAssertTrue(after.contains("/api/uploads/a.jpg"))
    }

    func testPlainTextIsOneSegment() {
        XCTAssertEqual(MessageSegment.parse("Just text"), [.text("Just text")])
    }

    func testInvalidJSONShowsAsWrittenAndUnknownBlocksAreUnsupported() {
        let broken = ":::canvas\n{not json}\n:::"
        XCTAssertEqual(MessageSegment.parse(broken), [.text(broken)])
        XCTAssertEqual(MessageSegment.parse(":::canvas\n{\"type\":\"sketchpad\",\"id\":\"s\"}\n:::"), [.canvas(.unsupported(type: "sketchpad"))])
        XCTAssertEqual(MessageSegment.parse(":::canvas\n{\"type\":\"data-table\"}\n:::"), [.canvas(.unsupported(type: "data-table"))])
    }

    func testDecodesTheBlocksAgentsUseMost() {
        func block(_ json: String) -> CanvasBlock? {
            if case .canvas(let block) = MessageSegment.parse(":::canvas\n\(json)\n:::").first { return block }
            return nil
        }
        XCTAssertEqual(block(#"{"type":"artifact","id":"abc","title":"Page"}"#), .page(url: "/api/artifacts/abc", title: "Page", isArtifact: true))
        XCTAssertEqual(block(#"{"type":"button","label":"Go","prompt":"Do it"}"#), .button(label: "Go", prompt: "Do it"))
        guard case .dataTable(let table) = block(#"{"type":"data-table","headers":["A"],"rows":[[1],["x"]]}"#) else { return XCTFail() }
        XCTAssertEqual(table.rows.map { $0[0].value }, ["1", "x"])
        guard case .lineChart(_, let labels, let series) = block(#"{"type":"line-chart","labels":["M"],"series":[{"label":"S","data":[1.5]}]}"#) else { return XCTFail() }
        XCTAssertEqual(labels, ["M"])
        XCTAssertEqual(series.first?.data, [1.5])
    }
}

final class AgentSelectionTests: XCTestCase {
    private func model(_ id: String, efforts: [String] = ["low", "high"], defaultEffort: String? = "low", fast: Bool = false, featured: Bool = true) -> AgentModelOption {
        AgentModelOption(id: id, label: id.capitalized, description: nil, efforts: efforts, defaultEffort: defaultEffort, supportsFast: fast, featured: featured)
    }

    private var providers: [AgentProviderModels] {
        [
            AgentProviderModels(provider: "claude", available: true, reason: nil, models: [
                model("hidden", featured: false),
                model("opus", efforts: ["low", "high", "max"], fast: true),
                model("haiku", efforts: []  , defaultEffort: nil),
            ]),
            AgentProviderModels(provider: "codex", available: true, reason: nil, models: [model("gpt", efforts: ["high"], defaultEffort: "high")]),
        ]
    }

    func testNothingStoredTakesTheFirstFeaturedModelWithFullAccess() {
        let selection = AgentSelection.resolve(providers, stored: nil)
        XCTAssertEqual(selection, AgentSelection(provider: "claude", soulId: nil, model: "opus", effort: "low", fast: false, access: "full"))
    }

    func testKeepsAValidStoredChoice() {
        let stored = StoredSelection(provider: "claude", soulId: "s", model: "opus", effort: "max", fast: true, access: "plan")
        let selection = AgentSelection.resolve(providers, stored: stored)
        XCTAssertEqual(selection, AgentSelection(provider: "claude", soulId: "s", model: "opus", effort: "max", fast: true, access: "plan"))
    }

    func testAnOutOfDateChoiceFallsBackPartByPart() {
        let unknownModel = AgentSelection.resolve(providers, stored: StoredSelection(provider: "codex", model: "old", effort: "max", access: "nonsense"))
        XCTAssertEqual(unknownModel, AgentSelection(provider: "codex", soulId: nil, model: "gpt", effort: "high", fast: false, access: "full"))

        let unknownEffort = AgentSelection.resolve(providers, stored: StoredSelection(provider: "claude", model: "opus", effort: "none"))
        XCTAssertEqual(unknownEffort?.effort, "low")

        let noFast = AgentSelection.resolve(providers, stored: StoredSelection(provider: "claude", model: "haiku", fast: true))
        XCTAssertEqual(noFast?.fast, false)
        XCTAssertNil(noFast?.effort)
    }

    func testAnUnavailableProviderIsSkippedAndNoneGivesNoSelection() {
        let codexOnly = [AgentProviderModels(provider: "claude", available: false, reason: "no login", models: providers[0].models), providers[1]]
        XCTAssertEqual(AgentSelection.resolve(codexOnly, stored: StoredSelection(provider: "claude", model: "opus"))?.provider, "codex")
        XCTAssertNil(AgentSelection.resolve([], stored: nil))
    }

    func testPickingAModelKeepsSoulAccessAndAnEffortItHas() {
        let start = AgentSelection(provider: "claude", soulId: "s", model: "opus", effort: "high", fast: true, access: "plan")
        let codex = start.picking(providers[1].models[0], of: providers[1])
        XCTAssertEqual(codex, AgentSelection(provider: "codex", soulId: "s", model: "gpt", effort: "high", fast: false, access: "plan"))

        let start2 = AgentSelection(provider: "claude", soulId: nil, model: "opus", effort: "max", fast: false, access: "full")
        XCTAssertEqual(start2.picking(providers[1].models[0], of: providers[1]).effort, "high")
        XCTAssertNil(start2.picking(providers[0].models[2], of: providers[0]).effort)
    }

    func testLabelIsTheSoulModelAndEffortLikeWebChat() {
        let souls = [ChompAPI.Soul(id: "s", name: "Nova", description: "", isDefault: false)]
        let plain = AgentSelection(provider: "claude", soulId: nil, model: "opus", effort: "xhigh", fast: false, access: "full")
        XCTAssertEqual(plain.label(providers: providers, souls: souls), "Opus · Extra high")
        let all = AgentSelection(provider: "claude", soulId: "s", model: "opus", effort: "high", fast: true, access: "supervised")
        XCTAssertEqual(all.label(providers: providers, souls: souls), "Nova · Opus · High")
    }
}

final class ComposerMediaTests: XCTestCase {
    private let image = ChatAttachment(url: "/api/uploads/a.jpg", name: "photo.jpg", mimeType: "image/jpeg")

    func testMessageContentMatchesWhatTheServerSaves() {
        XCTAssertEqual(ChatAttachment.content(text: "Hi", attachments: []), "Hi")
        XCTAssertEqual(ChatAttachment.content(text: "Hi", attachments: [image]), "Hi\n\n![photo.jpg](/api/uploads/a.jpg)")
        XCTAssertEqual(ChatAttachment.content(text: "", attachments: [image]), "![photo.jpg](/api/uploads/a.jpg)")
        let file = ChatAttachment(url: "/api/uploads/b.pdf", name: "a[1].pdf", mimeType: "application/pdf")
        XCTAssertEqual(ChatAttachment.content(text: "", attachments: [file]), "[a 1 .pdf](/api/uploads/b.pdf)")
    }

    func testPartsSplitTextFromImages() {
        let both = UserMessageParts(content: "Look at this\n\n![photo.jpg](/api/uploads/a.jpg)\n![b](/api/uploads/b.jpg)")
        XCTAssertEqual(both.text, "Look at this")
        XCTAssertEqual(both.imageURLs, ["/api/uploads/a.jpg", "/api/uploads/b.jpg"])
        XCTAssertEqual(UserMessageParts(content: "![a](/x.jpg)").text, "")
        XCTAssertEqual(UserMessageParts(content: "2 * 3 [not an image](/y)").imageURLs, [])
    }

    func testPhotosAreScaledDownToJPEG() throws {
        func png(width: CGFloat, height: CGFloat) -> Data {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).pngData { context in
                UIColor.red.setFill()
                context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            }
        }
        let large = try XCTUnwrap(UIImage(data: try XCTUnwrap(ImagePreparation.jpeg(from: png(width: 4000, height: 3000)))))
        XCTAssertEqual(large.size.width, 2048)
        XCTAssertEqual(large.size.height, 1536)
        let small = try XCTUnwrap(UIImage(data: try XCTUnwrap(ImagePreparation.jpeg(from: png(width: 100, height: 50)))))
        XCTAssertEqual(small.size.width, 100)
        XCTAssertNil(ImagePreparation.jpeg(from: Data("not an image".utf8)))
    }
}

final class LocationReporterTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000_000)

    private func location(latitude: Double = 59.91, accuracy: Double = 50, after seconds: TimeInterval = 0) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: 10.75),
            altitude: 0,
            horizontalAccuracy: accuracy,
            verticalAccuracy: -1,
            timestamp: start.addingTimeInterval(seconds)
        )
    }

    func testTheFirstValidReadingIsSent() {
        XCTAssertTrue(LocationReporter.shouldReport(location(), after: nil))
        XCTAssertFalse(LocationReporter.shouldReport(location(accuracy: -1), after: nil))
    }

    func testSendsWhenMovedOrAfterAWhileButNotOtherwise() {
        let last = location()
        XCTAssertFalse(LocationReporter.shouldReport(location(after: 60), after: last))
        XCTAssertTrue(LocationReporter.shouldReport(location(after: 15 * 60), after: last))
        XCTAssertTrue(LocationReporter.shouldReport(location(latitude: 59.92, after: 60), after: last))
    }

    func testAnOlderReadingIsNotSent() {
        XCTAssertFalse(LocationReporter.shouldReport(location(latitude: 60.39, after: -60), after: location()))
    }
}
