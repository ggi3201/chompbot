import SwiftUI
import ThinkingOrbsKit

struct ThreadView: View {
    @EnvironmentObject private var store: ChatStore
    @EnvironmentObject private var voice: VoiceChat
    @State private var draft: String = ""
    @State private var showingAgentPicker = false
    @State private var showingInfo = false
    @State private var isNearBottom = true
    /// Stable, so rows that read it from the environment do not redraw when the thread does.
    @State private var actions = ThreadActions()
    @FocusState private var focused: Bool

    /// Past this, the composer offers to compact or hand off before the CLI compacts on its own. As web chat.
    private static let contextHintPercent = 80.0

    var body: some View {
        let entries = store.timeline
        VStack(spacing: 0) {
            GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    // Not lazy: rows that measure themselves as they appear would move the bottom anchor.
                    VStack(alignment: .leading, spacing: 16) {
                        if let id = store.activeConversationId, store.olderMessages.contains(id) {
                            Button(store.isLoadingOlder ? "Loading" : "Load older messages") {
                                Task { await store.loadOlderMessages() }
                            }
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 36)
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.hairline))
                            .disabled(store.isLoadingOlder)
                            .frame(maxWidth: .infinity)
                        }
                        if entries.isEmpty && !store.isAwaitingResponse && !store.isLoadingThread {
                            Text("No messages yet")
                                .font(.subheadline)
                                .foregroundStyle(Theme.textMuted)
                                .frame(maxWidth: .infinity)
                                .padding(.top, 64)
                        }
                        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                            TimelineRow(entry: entry, canImplementPlan: entry.id == actionablePlanId(in: entries))
                                .equatable()
                                .environment(\.canvasLocked, index < (lastUserIndex(in: entries) ?? 0))
                                .id(entry.id)
                        }
                        if store.isAwaitingResponse && !isStreamingText(entries.last) {
                            WorkingRow(status: store.status, orb: agentOrbState(for: entries.last))
                        }
                        if let question = store.pendingQuestion {
                            QuestionCard(question: question.question)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                            .background {
                                GeometryReader { edge in
                                    Color.clear.preference(key: BottomEdgeKey.self, value: edge.frame(in: .named("thread")).maxY)
                                }
                            }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 16)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .environment(\.threadActions, actions)
                .overlay(alignment: .bottomTrailing) {
                    if !isNearBottom {
                        Button {
                            withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down")
                                .font(.footnote)
                                .foregroundStyle(Theme.textSecondary)
                                .frame(width: 40, height: 40)
                                .background(Theme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.hairline))
                        }
                        .buttonStyle(.plain)
                        .padding(16)
                        .accessibilityLabel("Scroll to latest message")
                    }
                }
                // Hidden until loaded, so it appears at its end and does not scroll there in view.
                .opacity(store.isLoadingThread ? 0 : 1)
                .refreshable {
                    await store.refresh()
                }
                .coordinateSpace(name: "thread")
                .onPreferenceChange(BottomEdgeKey.self) { edge in
                    // iOS 18 and later: the scroll geometry below. This one stops updating while you scroll there.
                    if #unavailable(iOS 18) { isNearBottom = edge <= viewport.size.height + Self.followDistance }
                }
                .trackingNearBottom($isNearBottom, within: Self.followDistance)
                // Follows a live reply while you are at the end. Scrolling up to read stops it.
                .onChange(of: liveMark(of: entries)) { _, _ in
                    if isNearBottom { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: store.isAwaitingResponse) { _, awaiting in
                    // Sending always goes to the end.
                    if awaiting || isNearBottom { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            }
            if let todos = store.pinnedTodos {
                PinnedTodos(todos: todos)
                    .padding(.horizontal, 8)
                    .padding(.top, 6)
                    .background(Theme.surface)
            }
            if !store.isAwaitingResponse, let usage = context, usage.percent >= Self.contextHintPercent {
                HStack(spacing: 10) {
                    Text("Context is \(Int(usage.percent.rounded()))% full.")
                        .foregroundStyle(Theme.textMuted)
                    if usage.provider == "claude" {
                        Button("Compact") { store.send("/compact") }
                    }
                    Button("Hand off", action: startHandoff)
                }
                .font(.caption)
                .foregroundStyle(Theme.accentInk)
                .padding(.horizontal, 20)
                .padding(.top, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface)
            }
            ComposerView(
                draft: $draft,
                focused: $focused,
                placeholder: placeholder,
                isBusy: store.isAwaitingResponse,
                agentLabel: store.selectionLabel(store.selection, forNewChat: store.activeConversationId == nil),
                agentSelection: store.selection,
                context: context,
                onPickAgent: { showingAgentPicker = true },
                onStop: store.stop,
                onSendNow: { attachments in
                    let text = draft
                    draft = ""
                    store.send(text, attachments: attachments, interrupt: true)
                },
                onCompact: { store.send("/compact") },
                onHandoff: startHandoff,
                voice: voice
            ) { attachments in
                let text = draft
                draft = ""
                store.send(text, attachments: attachments)
            }
            .onAppear {
                actions.quote = { text in
                    let quoted = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        .split(separator: "\n", omittingEmptySubsequences: false)
                        .map { "> \($0)" }
                        .joined(separator: "\n")
                    let kept = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : draft.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) + "\n\n"
                    draft = kept + quoted + "\n\n"
                    focused = true
                }
                actions.fork = { messageId in
                    Task { await store.fork(at: messageId) }
                }
            }
            .onChange(of: store.handoffNote) { _, note in
                // The handoff note is written: this is now the new chat, with the note ready to send.
                guard let note else { return }
                draft = note
                store.handoffNote = nil
                focused = true
            }
            .onAppear {
                // Each pause sends; while the agent works, that adds to the running task.
                voice.onUtterance = { text, asDraft in
                    let message = draft.isEmpty ? text : "\(draft) \(text)"
                    if asDraft {
                        draft = message
                    } else {
                        draft = ""
                        store.send(message, spoken: true)
                    }
                }
            }
            .onChange(of: store.isAwaitingResponse) { _, awaiting in
                if !awaiting { speakReply() }
            }
            .onAppear { store.viewingThread = true }
            .onDisappear {
                store.viewingThread = false
                // Leaving the chat ends voice in it.
                voice.stop()
            }
        }
        .background(Theme.surface)
        .navigationTitle(store.activeConversation?.title ?? "New chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            if store.activeConversationId != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingInfo = true } label: {
                        Image(systemName: "sidebar.right")
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .accessibilityLabel("Chat info")
                }
            }
        }
        .sheet(isPresented: $showingInfo) {
            if let id = store.activeConversationId {
                ChatInfoView(conversationId: id)
                    .presentationDetents([.medium, .large])
            }
        }
        .sheet(isPresented: $showingAgentPicker) {
            if let selection = store.selection {
                AgentSelectionView(selection: selection, picksProject: store.activeConversationId == nil, onChange: store.select)
            }
        }
    }

    /// The chat's context, if it is for the engine now picked: another engine starts its own session.
    private var context: ChompAPI.ContextUsage? {
        store.contextUsage.flatMap { $0.provider == store.selection?.provider ? $0 : nil }
    }

    private var placeholder: String {
        if store.pendingQuestion != nil { return "Answer the agent's question" }
        if store.isAwaitingResponse { return "Add to the running task" }
        return "Message Chomp, or type @ for an agent"
    }

    private func startHandoff() {
        draft = "/handoff "
        focused = true
    }

    /// With voice on, reads out what the agent said since your last message (VoiceChat checks the setting).
    private func speakReply() {
        guard store.awaitingSpokenReply, voice.phase != .off, let messages = store.activeConversation?.messages else { return }
        store.awaitingSpokenReply = false
        let lastQuestion = messages.lastIndex { $0.role == .user } ?? -1
        let reply = messages[(lastQuestion + 1)...]
            .filter { $0.role == .assistant && !$0.isStreaming }
            .map(\.content)
            .joined(separator: "\n")
        if !reply.isEmpty { voice.speak(reply) }
    }

    /// How far from the end still counts as following, in points. More than one update's growth.
    private static let followDistance: CGFloat = 200

    /// Changes whenever the thread's end grows: a new row, or more text in the last one.
    private func liveMark(of entries: [TimelineEntry]) -> String {
        var length = 0
        switch entries.last {
        case .message(let message), .footer(let message):
            length = message.content.count
        case .item(let item):
            if case .assistantText(let text, _) = item.body { length = text.count }
            if case .reasoning(let text, _) = item.body { length = text.count }
        case .work(_, _, let items, _):
            length = items.count
        case nil:
            break
        }
        return "\(entries.count)-\(length)"
    }

    private func isStreamingText(_ entry: TimelineEntry?) -> Bool {
        switch entry {
        case .message(let message):
            return message.isStreaming
        case .item(let item):
            if case .assistantText(_, true) = item.body { return true }
            return false
        default:
            return false
        }
    }

    private func lastUserIndex(in entries: [TimelineEntry]) -> Int? {
        entries.lastIndex { entry in
            if case .message(let message) = entry { return message.role == .user }
            return false
        }
    }

    private func actionablePlanId(in entries: [TimelineEntry]) -> String? {
        guard !store.isAwaitingResponse else { return nil }
        return entries.last { entry in
            if case .item(let item) = entry, case .proposedPlan = item.body { return true }
            return false
        }?.id
    }
}

private extension View {
    /// Whether the end of the thread is within `distance` of the bottom of the screen.
    @ViewBuilder
    func trackingNearBottom(_ isNear: Binding<Bool>, within distance: CGFloat) -> some View {
        if #available(iOS 18, *) {
            onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height <= distance
            } action: { _, near in
                isNear.wrappedValue = near
            }
        } else {
            self
        }
    }
}

private struct BottomEdgeKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

/// Equatable, so a row only redraws when its own entry changes, not on every keystroke or status tick.
private struct TimelineRow: View, Equatable {
    let entry: TimelineEntry
    let canImplementPlan: Bool

    var body: some View {
        switch entry {
        case .message(let message):
            MessageRow(msg: message)
        case .footer(let message):
            MessageFooter(msg: message)
        case .item(let item):
            AgentItemView(item: item, canImplementPlan: canImplementPlan)
        case .work(_, _, let items, let live):
            WorkGroupView(items: items, live: live)
        }
    }
}

private struct MessageRow: View {
    let msg: ChatMessage

    var body: some View {
        switch msg.role {
        case .user:
            VStack(alignment: .trailing, spacing: 4) {
                let parts = UserMessageParts(content: msg.content)
                ForEach(parts.imageURLs, id: \.self) { url in
                    ChatImage(url: URL(string: url, relativeTo: AppConfig.shared.serverURL)?.absoluteURL)
                        .frame(maxWidth: 240)
                }
                // User messages stay plain to avoid surprising auto-formatting
                // of typed text (e.g. `*` getting eaten as italics).
                if !parts.text.isEmpty {
                    Text(parts.text)
                        .foregroundStyle(Theme.textPrimary)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Theme.raised)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.hairline)
                        }
                }
                MessageFooter(msg: msg)
            }
            .padding(.leading, 32)
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant:
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    if msg.isStreaming { AgentOrb(state: .composing) }
                    Text(msg.agentUsed?.trimmingCharacters(in: .whitespaces).nilIfEmpty ?? "Chomp")
                }
                .font(.caption.monospaced())
                .foregroundStyle(Theme.textMuted)
                MessageContent(text: msg.content, isStreaming: msg.isStreaming)
                MessageFooter(msg: msg)
            }
        case .system:
            ThemedCard {
                ChatMarkdown(text: msg.content)
            }
        }
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// What a message's buttons do in the open thread. A class, so its identity never changes.
final class ThreadActions {
    var quote: (String) -> Void = { _ in }
    var fork: (String) -> Void = { _ in }
}

private struct ThreadActionsKey: EnvironmentKey {
    static let defaultValue = ThreadActions()
}

extension EnvironmentValues {
    var threadActions: ThreadActions {
        get { self[ThreadActionsKey.self] }
        set { self[ThreadActionsKey.self] = newValue }
    }
}

/// Time and copy under a message; on a reply also quote and fork, as web chat.
private struct MessageFooter: View {
    let msg: ChatMessage
    @Environment(\.threadActions) private var actions

    var body: some View {
        HStack(spacing: 4) {
            Text(msg.createdAt, format: .dateTime.hour().minute())
                .font(.caption.monospaced())
                .padding(.trailing, 4)
            footerButton("doc.on.doc", label: "Copy message") {
                UIPasteboard.general.string = msg.content
            }
            if msg.role == .assistant && !msg.isStreaming {
                footerButton("text.quote", label: "Quote in your reply") { actions.quote(msg.content) }
                footerButton("arrow.triangle.branch", label: "Fork from here: a new chat with everything up to this reply") {
                    actions.fork(msg.id)
                }
            }
        }
        .foregroundStyle(Theme.textMuted)
    }

    private func footerButton(_ icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.caption)
                .frame(width: 32, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Shown while a turn runs. Surfaces the live status line (e.g. "Running grep…", "12s")
/// so long agent turns don't look stalled.
/// What the orb shows: what the latest entry is doing right now, else plain work.
func agentOrbState(for entry: TimelineEntry?) -> OrbState {
    guard case .item(let item) = entry else { return .working }
    switch item.body {
    case .reasoning(_, true): return .solving
    case .assistantText(_, true): return .composing
    case .toolCall(let tool, _, _, _, .running):
        return tool.range(of: "search|grep|glob|read|fetch|find|list|recall|^get_", options: [.regularExpression, .caseInsensitive]) != nil ? .searching : .working
    case .fileChange(_, .running): return .shaping
    default: return .working
    }
}

private struct WorkingRow: View {
    let status: String
    let orb: OrbState

    var body: some View {
        HStack(spacing: 10) {
            AgentOrb(state: orb, size: 32)
            Text(status == "Connected" || status == "idle" ? "Working" : status)
                .font(.caption.monospaced())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
        }
        .transition(.opacity)
    }
}

private struct QuestionCard: View {
    let question: String

    var body: some View {
        ThemedCard(emphasized: true) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Chomp is asking")
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.textMuted)
                ChatMarkdown(text: question)
            }
        }
    }
}
