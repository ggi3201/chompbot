import UserNotifications
import XCTest
@testable import Chomp

final class LockScreenAnswersTests: XCTestCase {
    private let approval: [AnyHashable: Any] = ["chomp": ["id": "r1", "kind": "approval", "conversationId": "c1", "requestId": "r1"]]
    private let question: [AnyHashable: Any] = ["chomp": ["id": "q1", "kind": "question", "sessionId": "s1", "questionId": "q1"]]

    private func config() -> AppConfig {
        let store = UserDefaults(suiteName: "LockScreenAnswersTests.\(UUID().uuidString)")!
        let config = AppConfig(store: store)
        config.serverHost = "chomp.test"
        config.jwt = "token"
        return config
    }

    private func session(status: Int? = nil) -> URLSession {
        StubProtocol.status = status
        StubProtocol.requests = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    private func answerToApprove() throws -> LockScreenAnswers.Answer {
        try XCTUnwrap(LockScreenAnswers.answer(userInfo: approval, action: LockScreenAnswers.approveAction, text: nil))
    }

    func testApproveNeedsFaceIDAndDeclineDoesNot() throws {
        let category = try XCTUnwrap(LockScreenAnswers.categories.first { $0.identifier == LockScreenAnswers.approvalCategory })
        let options = Dictionary(uniqueKeysWithValues: category.actions.map { ($0.identifier, $0.options) })
        XCTAssertEqual(options[LockScreenAnswers.approveAction]?.contains(.authenticationRequired), true)
        XCTAssertEqual(options[LockScreenAnswers.declineAction]?.contains(.authenticationRequired), false)
    }

    func testReplyTakesTextAndNeedsFaceID() throws {
        let category = try XCTUnwrap(LockScreenAnswers.categories.first { $0.identifier == LockScreenAnswers.questionCategory })
        let reply = try XCTUnwrap(category.actions.first as? UNTextInputNotificationAction)
        XCTAssertTrue(reply.options.contains(.authenticationRequired))
    }

    func testAnswersCarryTheIdsThePushCameWith() throws {
        XCTAssertEqual(try answerToApprove().body, ["conversationId": "c1", "requestId": "r1", "decision": "accept"])
        XCTAssertEqual(LockScreenAnswers.answer(userInfo: approval, action: LockScreenAnswers.declineAction, text: nil)?.body["decision"], "decline")
        XCTAssertEqual(
            LockScreenAnswers.answer(userInfo: question, action: LockScreenAnswers.replyAction, text: "Blue")?.body,
            ["sessionId": "s1", "questionId": "q1", "answer": "Blue"]
        )
    }

    func testATapOnTheNotificationOrAnEmptyReplyAnswersNothing() {
        XCTAssertNil(LockScreenAnswers.answer(userInfo: approval, action: UNNotificationDefaultActionIdentifier, text: nil))
        XCTAssertNil(LockScreenAnswers.answer(userInfo: question, action: LockScreenAnswers.replyAction, text: ""))
        XCTAssertNil(LockScreenAnswers.answer(userInfo: ["aps": [:]], action: LockScreenAnswers.approveAction, text: nil))
    }

    func testServerResponsesBecomeOutcomes() async throws {
        let answer = try answerToApprove()
        let cases: [(Int, LockScreenAnswers.Outcome)] = [(200, .sent), (409, .ended), (401, .signedOut), (500, .notSent)]
        for (status, outcome) in cases {
            let result = await LockScreenAnswers.send(answer, config: config(), session: session(status: status))
            XCTAssertEqual(result, outcome)
        }
        XCTAssertEqual(StubProtocol.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer token")
        XCTAssertEqual(StubProtocol.requests.last?.url?.absoluteString, "https://chomp.test/api/agent-requests/approval")
    }

    func testAnUnreachableServerIsTriedTwiceAndReportedAsNotSent() async throws {
        let result = await LockScreenAnswers.send(try answerToApprove(), config: config(), session: session())
        XCTAssertEqual(result, .notSent)
        XCTAssertEqual(StubProtocol.requests.count, 2)
    }

    func testOnlyASentAnswerStaysQuiet() throws {
        let answer = try answerToApprove()
        XCTAssertNil(LockScreenAnswers.notice(for: .sent, answer: answer))
        for outcome in [LockScreenAnswers.Outcome.ended, .signedOut, .notSent] {
            XCTAssertNotNil(LockScreenAnswers.notice(for: outcome, answer: answer))
        }
        XCTAssertTrue(try XCTUnwrap(LockScreenAnswers.notice(for: .notSent, answer: answer)).body.contains("Nothing was approved"))
    }
}

/// Answers with `status`, or fails like a server that cannot be reached when it is nil.
private final class StubProtocol: URLProtocol {
    static var status: Int?
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        guard let status = Self.status else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
