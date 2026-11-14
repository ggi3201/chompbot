import Foundation

/// Merges messages and agent items into the thread's rows. The same rules as
/// `buildTimeline` in packages/web/src/lib/chat-timeline.ts.
enum TimelineEntry: Identifiable, Equatable {
    case message(ChatMessage)
    /// A reply whose text an item already shows: only its time and copy button remain.
    case footer(ChatMessage)
    case item(ChatItem)
    case work(id: String, turnId: String, items: [ChatItem], live: Bool)

    var id: String {
        switch self {
        case .message(let message): return "message-\(message.id)"
        case .footer(let message): return "footer-\(message.id)"
        case .item(let item): return "item-\(item.id)"
        case .work(let id, _, _, _): return "work-\(id)"
        }
    }
}

enum ChatTimeline {
    /// Its text already reaches the chat as a message, so a row for it would say the same thing twice.
    private static let replyTool = "mcp__chomp-api__reply"

    static func build(messages: [ChatMessage], items: [ChatItem], liveTurn: String?) -> [TimelineEntry] {
        var textsByTurn: [String: Set<String>] = [:]
        for item in items {
            if case .assistantText(let text, _) = item.body {
                textsByTurn[item.turnId, default: []].insert(trimmed(text))
            }
        }

        let visibleItems = items
            .filter { item in
                if item.parentId != nil { return false }
                switch item.body {
                case .other: return false
                case .toolCall(let tool, _, _, _, _): return tool != replyTool
                default: return true
                }
            }
            .sorted { ($0.createdAt, $0.seq) < ($1.createdAt, $1.seq) }

        var entries: [TimelineEntry] = []
        var nextMessage = 0
        var nextItem = 0
        while nextMessage < messages.count || nextItem < visibleItems.count {
            let message = nextMessage < messages.count ? messages[nextMessage] : nil
            let item = nextItem < visibleItems.count ? visibleItems[nextItem] : nil
            // On a tie the message goes first, so a user message stays above the work it started.
            if let message, item == nil || message.createdAt <= item!.createdAt {
                let hidden = message.role == .assistant
                    && message.turnId.map { textsByTurn[$0]?.contains(trimmed(message.content)) ?? false } ?? false
                entries.append(hidden ? .footer(message) : .message(message))
                nextMessage += 1
            } else if let item {
                append(item, to: &entries, liveTurn: liveTurn)
                nextItem += 1
            }
        }
        return entries
    }

    private static func append(_ item: ChatItem, to entries: inout [TimelineEntry], liveTurn: String?) {
        guard item.isWork else {
            entries.append(.item(item))
            return
        }
        let running = item.status == .running
        if case .work(let id, let turnId, let items, let live) = entries.last, turnId == item.turnId {
            entries[entries.count - 1] = .work(id: id, turnId: turnId, items: items + [item], live: live || running)
        } else {
            entries.append(.work(id: item.id, turnId: item.turnId, items: [item], live: item.turnId == liveTurn || running))
        }
    }

    private static func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// "Used 2 tools, ran 1 command, changed 3 files": the collapsed work group's line.
    static func summary(of items: [ChatItem]) -> String {
        var tools = 0
        var commands = 0
        var files = Set<String>()
        for item in items {
            switch item.body {
            case .toolCall: tools += 1
            case .command: commands += 1
            case .fileChange(let changed, _): files.formUnion(changed.map(\.path))
            default: break
            }
        }
        let parts = [
            tools > 0 ? "used \(tools) \(tools == 1 ? "tool" : "tools")" : nil,
            commands > 0 ? "ran \(commands) \(commands == 1 ? "command" : "commands")" : nil,
            !files.isEmpty ? "changed \(files.count) \(files.count == 1 ? "file" : "files")" : nil,
        ].compactMap { $0 }
        let text = parts.isEmpty ? "worked" : parts.joined(separator: ", ")
        return text.prefix(1).uppercased() + text.dropFirst()
    }
}
