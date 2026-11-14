import SwiftUI

/// What `/` and `@` offer as you type, as web chat's composer: commands and skills after `/`,
/// souls and other chats after `@`. Matches the word at the end of the draft.
struct ComposerSuggestion: Identifiable, Equatable {
    let label: String
    let detail: String
    /// What replaces the typed word, with a trailing space.
    let insert: String
    var id: String { insert }
}

enum ComposerAutocomplete {
    /// As web chat's CHAT_MENTIONS.
    static let chatMentions = 6
    private static let word = try! NSRegularExpression(pattern: "(^|\\s)([/@]\\S*)$")

    /// The suggestions for the draft, and where the word they replace starts. Nil when nothing is being typed.
    static func match(
        _ draft: String,
        completions: ChompAPI.Completions?,
        chats: [Conversation],
        activeId: String?
    ) -> (items: [ComposerSuggestion], start: String.Index)? {
        guard let completions,
              let found = word.firstMatch(in: draft, range: NSRange(draft.startIndex..., in: draft)),
              let range = Range(found.range(at: 2), in: draft) else { return nil }
        let typed = draft[range].lowercased()

        if typed.hasPrefix("/") {
            let items = completions.commands
                .filter { $0.trigger.lowercased().hasPrefix(typed) }
                .map { ComposerSuggestion(label: $0.trigger, detail: $0.description, insert: $0.trigger + " ") }
            return (items, range.lowerBound)
        }

        let query = String(typed.dropFirst())
        let agents = completions.agents
            .filter { agent in ([agent.name] + agent.shorthands).contains { $0.lowercased().hasPrefix(query) } }
            .map { ComposerSuggestion(label: "@\($0.name)", detail: $0.type, insert: "@\($0.name) ") }
        // Other chats, newest first. The server tells the agent which chat each reference is.
        let others = chats
            .filter { $0.id != activeId && (query.isEmpty || $0.title.lowercased().contains(query)) }
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(chatMentions)
            .map { ComposerSuggestion(label: "@\($0.title)", detail: "Chat · \($0.updatedAt.formatted(.relative(presentation: .named)))", insert: "@session:\($0.id.prefix(8)) ") }
        return (agents + others, range.lowerBound)
    }
}

/// The list above the composer. A tap puts the choice in place of the typed word.
struct ComposerSuggestions: View {
    let items: [ComposerSuggestion]
    let onPick: (ComposerSuggestion) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(items) { item in
                    Button { onPick(item) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.label)
                                .font(.footnote.monospaced())
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                            Text(item.detail)
                                .font(.caption)
                                .foregroundStyle(Theme.textMuted)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 4)
        }
        .frame(maxHeight: min(CGFloat(items.count) * 48 + 8, 240))
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.hairline))
    }
}
