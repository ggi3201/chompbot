import SwiftUI

struct ChatListView: View {
    @EnvironmentObject private var store: ChatStore
    @State private var showingThread = false

    var body: some View {
        NavigationStack {
            ThemedList {
                Section {
                    Button {
                        store.newConversation()
                        showingThread = true
                    } label: {
                        Label("New chat", systemImage: "square.and.pencil")
                    }
                }
                Section("History") {
                    if store.conversations.isEmpty {
                        Text("No conversations yet — start one from the New chat row.")
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    ForEach(store.conversations) { conv in
                        Button {
                            store.selectConversation(conv.id)
                            showingThread = true
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    ChatMark(conversation: conv, unread: store.isUnread(conv))
                                    Text(conv.title)
                                        .font(.body.weight(conv.needsInput || store.isUnread(conv) ? .semibold : .regular))
                                        .foregroundStyle(Theme.textPrimary)
                                        .lineLimit(1)
                                }
                                if let last = conv.messages.last {
                                    Text(last.content)
                                        .font(.caption)
                                        .foregroundStyle(Theme.textSecondary)
                                        .lineLimit(2)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Chats")
            .refreshable {
                await store.refresh()
            }
            // Keeps the marks current while the list is open, as web chat polls its sidebar.
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(20))
                    await store.refresh()
                }
            }
            .navigationDestination(isPresented: $showingThread) {
                ThreadView()
            }
            .overlay(alignment: .bottom) {
                StatusBar()
            }
        }
    }
}

/// Waiting for you beats working, which beats unread. Nothing for a quiet chat.
private struct ChatMark: View {
    let conversation: Conversation
    let unread: Bool

    var body: some View {
        if conversation.needsInput {
            Circle().fill(Theme.accent).frame(width: 8, height: 8)
                .accessibilityLabel("Waiting for you")
        } else if conversation.running {
            // A spinner, not a dot, so amber stays the one mark that asks something of you.
            ProgressView().controlSize(.mini).accessibilityLabel("Agent working")
        } else if unread {
            Circle().fill(Theme.textPrimary).frame(width: 6, height: 6)
                .accessibilityLabel("Unread")
        }
    }
}

private struct StatusBar: View {
    @EnvironmentObject private var store: ChatStore
    var body: some View {
        HStack {
            Circle()
                .frame(width: 8, height: 8)
                .foregroundStyle(statusColor)
            Text(store.status)
                .font(.caption2)
                .foregroundStyle(Theme.textSecondary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(Theme.surface)
        .overlay(alignment: .top) {
            Theme.hairline.frame(height: 1)
        }
    }
    private var statusColor: Color {
        switch store.status {
        case "Connecting…": return Theme.textMuted
        case "Disconnected", "Not configured": return Theme.error
        default: return Theme.accent
        }
    }
}
