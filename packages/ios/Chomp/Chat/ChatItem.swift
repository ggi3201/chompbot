import Foundation

/// One step of an agent's turn. Mirrors `ChatItem` in packages/shared/src/types/agent-items.ts.
/// Items are upserted: an update replaces the whole item and takes a new `seq`.
struct ChatItem: Decodable, Identifiable, Equatable {
    enum Status: String, Decodable {
        case running, completed, failed, declined
    }

    struct FileDiff: Decodable, Equatable {
        let path: String
        let diff: String
        let additions: Int
        let deletions: Int
    }

    struct Todo: Decodable, Equatable {
        let text: String
        let status: String
    }

    enum Body: Equatable {
        case assistantText(text: String, streaming: Bool)
        case reasoning(text: String, streaming: Bool)
        case toolCall(tool: String, title: String, input: String?, output: String?, status: Status)
        case command(command: String, cwd: String?, output: String, exitCode: Int?, status: Status)
        case fileChange(files: [FileDiff], status: Status)
        case todoList([Todo])
        case proposedPlan(markdown: String)
        case approval(requestId: String, title: String, detail: String, state: String, oneTime: Bool)
        case error(message: String)
        /// Subagents and any kind this version of the app does not know. Not shown in the timeline.
        case other
    }

    let id: String
    let conversationId: String
    let turnId: String
    let seq: Int
    let parentId: String?
    let createdAt: Date
    var body: Body

    private enum CodingKeys: String, CodingKey {
        case id, conversationId, turnId, seq, parentId, createdAt, kind
        case text, streaming, tool, title, input, output, status, command, cwd, exitCode
        case files, todos, markdown, requestId, detail, state, oneTime, message
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        turnId = try c.decode(String.self, forKey: .turnId)
        seq = try c.decode(Int.self, forKey: .seq)
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        createdAt = try c.decode(Date.self, forKey: .createdAt)

        func status() -> Status {
            (try? c.decode(Status.self, forKey: .status)) ?? .completed
        }
        func string(_ key: CodingKeys) -> String {
            (try? c.decode(String.self, forKey: key)) ?? ""
        }
        func optional(_ key: CodingKeys) -> String? {
            (try? c.decodeIfPresent(String.self, forKey: key)).flatMap { $0 }
        }
        func streaming() -> Bool {
            (try? c.decode(Bool.self, forKey: .streaming)) ?? false
        }

        switch try c.decode(String.self, forKey: .kind) {
        case "assistant_text":
            body = .assistantText(text: string(.text), streaming: streaming())
        case "reasoning":
            body = .reasoning(text: string(.text), streaming: streaming())
        case "tool_call":
            body = .toolCall(tool: string(.tool), title: string(.title), input: optional(.input), output: optional(.output), status: status())
        case "command":
            body = .command(
                command: string(.command),
                cwd: optional(.cwd),
                output: string(.output),
                exitCode: try? c.decodeIfPresent(Int.self, forKey: .exitCode),
                status: status()
            )
        case "file_change":
            body = .fileChange(files: (try? c.decode([FileDiff].self, forKey: .files)) ?? [], status: status())
        case "todo_list":
            body = .todoList((try? c.decode([Todo].self, forKey: .todos)) ?? [])
        case "proposed_plan":
            body = .proposedPlan(markdown: string(.markdown))
        case "approval":
            body = .approval(requestId: string(.requestId), title: string(.title), detail: string(.detail), state: string(.state), oneTime: (try? c.decode(Bool.self, forKey: .oneTime)) ?? false)
        case "error":
            body = .error(message: string(.message))
        default:
            body = .other
        }
    }

    var isWork: Bool {
        switch body {
        case .toolCall, .command, .fileChange: return true
        default: return false
        }
    }

    var status: Status? {
        switch body {
        case .toolCall(_, _, _, _, let status), .command(_, _, _, _, let status), .fileChange(_, let status): return status
        default: return nil
        }
    }
}

extension Array where Element == ChatItem {
    /// Upserts by id, never with an older `seq`, so a slow REST load cannot undo a live update.
    func upserting(_ incoming: [ChatItem]) -> [ChatItem] {
        var byId = Dictionary(map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        for item in incoming where (byId[item.id]?.seq ?? Int.min) <= item.seq {
            byId[item.id] = item
        }
        return byId.values.sorted { $0.seq < $1.seq }
    }

    var maxSeq: Int {
        map(\.seq).max() ?? 0
    }
}
