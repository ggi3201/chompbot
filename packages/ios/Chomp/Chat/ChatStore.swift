import Foundation
import Combine

@MainActor
final class ChatStore: ObservableObject {
    @Published var conversations: [Conversation] = []
    @Published var activeConversationId: String?
    @Published var status: String = "idle"
    /// The socket alone. `status` also says what a turn is doing.
    @Published private(set) var connection: ConnectionStatus = .off("Not signed in")
    @Published var lastError: String?
    @Published var souls: [ChompAPI.Soul] = []
    @Published private(set) var agentProviders: [AgentProviderModels] = []
    @Published private(set) var projects: [ChompAPI.Project] = []
    /// The repo a new chat's agents run in, sent with its first message and fixed after that.
    @Published var newChatProject: String?
    /// With a project: false works in the repo checkout itself, not the chat's own worktree.
    @Published var newChatWorktree = true
    /// True while a chat with nothing to show yet loads, so it can open already at its end.
    @Published private(set) var isLoadingThread = false
    /// The active chat's choice of agent and model. Resolved against what the server offers now.
    @Published private var storedSelection: StoredSelection? = SelectionStorage.lastUsed
    /// What a new chat starts with.
    @Published private var lastUsedSelection: StoredSelection? = SelectionStorage.lastUsed
    @Published var isRefreshing: Bool = false
    /// True from the moment the user sends until the assistant's reply (or an
    /// error) lands. Drives the typing/loading indicator in the thread.
    @Published var isAwaitingResponse: Bool = false
    /// The running turn answers a message said in voice mode, so its reply may be read aloud.
    /// Opening another chat clears it, so that chat's last reply is never read out.
    @Published var awaitingSpokenReply = false
    @Published private(set) var itemsByConversation: [String: [ChatItem]] = [:]
    /// What the agent asked with `ask_user`. The next message answers it.
    @Published private(set) var pendingQuestion: PendingQuestion?
    /// What `/` and `@` offer in the composer.
    @Published private(set) var completions: ChompAPI.Completions?
    /// How full the open chat's agent session is. Nil for a new chat and before its first agent turn.
    @Published private(set) var contextUsage: ChompAPI.ContextUsage?
    @Published private(set) var planUsage: [ChompAPI.ProviderUsage] = []
    /// Chats with messages older than the ones loaded.
    @Published private(set) var olderMessages: Set<String> = []
    @Published private(set) var isLoadingOlder = false
    /// A `/handoff` note for the composer of the new chat it opened. The thread takes it and clears it.
    @Published var handoffNote: String?
    /// The chat the handoff came from, linked when the new chat's first message goes out.
    private var handoffFrom: String?

    private let client = ChatClient()
    private var api: ChompAPI { ChompAPI(config: AppConfig.shared) }

    /// Conversation ids minted locally for a brand-new chat that the server
    /// hasn't yet assigned a real id to. We must NOT send these to the server
    /// as `conversationId` (it would 404-lookup and fork a second
    /// conversation); instead we send nil and migrate to the server's id when
    /// the `conversation` event arrives.
    private var localConversationIds: Set<String> = []

    var activeConversation: Conversation? {
        guard let id = activeConversationId else { return nil }
        return conversations.first(where: { $0.id == id })
    }

    // MARK: - Unread

    /// The chat on screen, if a thread is open. The active one stays set after you leave it.
    @Published var viewingThread = false {
        didSet { noteSeen() }
    }
    private var onScreenId: String? { viewingThread ? activeConversationId : nil }

    /// Something happened in it since you last looked, and it is not the open one.
    func isUnread(_ conversation: Conversation) -> Bool {
        conversation.unread && conversation.id != onScreenId && !conversation.running
    }

    /// The server keeps when each chat was last seen, so reading it here clears it on web too.
    private func noteSeen() {
        guard let id = onScreenId, let index = conversations.firstIndex(where: { $0.id == id }), conversations[index].unread else { return }
        conversations[index].unread = false
        Task { try? await api.markSeen(conversationId: id) }
    }

    /// The latest task list, pinned above the composer while the turn runs or tasks are left (as web chat).
    var pinnedTodos: [ChatItem.Todo]? {
        guard let id = activeConversationId else { return nil }
        let latest = (itemsByConversation[id] ?? [])
            .filter { if case .todoList = $0.body { true } else { false } }
            .max { ($0.createdAt, $0.seq) < ($1.createdAt, $1.seq) }
        guard let latest, case .todoList(let todos) = latest.body else { return nil }
        return isAwaitingResponse || todos.contains { $0.status != "completed" } ? todos : nil
    }

    /// The active conversation's messages and agent work, as the thread shows them.
    var timeline: [TimelineEntry] {
        guard let conversation = activeConversation else { return [] }
        // With older messages not loaded, their turns' work stays hidden too, or it would float above the first message.
        let since = olderMessages.contains(conversation.id) ? conversation.messages.first?.createdAt : nil
        let items = (itemsByConversation[conversation.id] ?? []).filter { since == nil || $0.createdAt >= since! }
        return ChatTimeline.build(
            messages: conversation.messages.filter { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
            items: items,
            liveTurn: isAwaitingResponse ? items.last?.turnId : nil
        )
    }

    func connectIfConfigured() async {
        guard let url = AppConfig.shared.chatWebSocketURL else {
            status = "Not configured"
            connection = .off("Not signed in")
            return
        }
        status = "Connecting…"
        client.connect(url: url) { [weak self] event in
            Task { @MainActor [weak self] in self?.handle(event) }
        } onState: { [weak self] state in
            Task { @MainActor [weak self] in self?.handle(state: state) }
        }
        await refresh()
    }

    func reconnect() async {
        client.disconnect()
        await connectIfConfigured()
    }

    func refresh() async {
        guard AppConfig.shared.isChatConfigured else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let list = try await api.listConversations()
            let existingById = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0) })
            var merged = list.map { item -> Conversation in
                let prev = existingById[item.id]
                return Conversation(
                    id: item.id,
                    title: item.title ?? prev?.title ?? "Conversation",
                    messages: prev?.messages ?? [],
                    updatedAt: item.updatedAt,
                    running: item.running ?? false,
                    needsInput: item.needsInput ?? false,
                    unread: item.unread ?? false
                )
            }
            // Preserve any in-flight local (not-yet-confirmed) conversation that
            // the server list doesn't know about yet, so a pull-to-refresh
            // mid-send doesn't wipe the message the user just typed.
            for conv in conversations where localConversationIds.contains(conv.id) {
                if !merged.contains(where: { $0.id == conv.id }) {
                    merged.insert(conv, at: 0)
                }
            }
            conversations = merged
            noteSeen()

            if let activeId = activeConversationId, !localConversationIds.contains(activeId) {
                await fetchMessages(for: activeId)
            }
            // At once, not one after another: the model list waits on the CLIs.
            async let fetchedSouls = try? api.listSouls()
            async let fetchedModels = try? api.agentModels()
            async let fetchedProjects = try? api.listProjects()
            async let fetchedCompletions = try? api.completions()
            async let fetchedUsage = try? api.usageLimits()
            if let fetched = await fetchedSouls { souls = fetched }
            if let fetched = await fetchedModels { agentProviders = fetched }
            if let fetched = await fetchedProjects { projects = fetched }
            if let fetched = await fetchedCompletions { completions = fetched }
            if let fetched = await fetchedUsage { planUsage = fetched }
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    var selection: AgentSelection? {
        AgentSelection.resolve(agentProviders, stored: storedSelection)
    }

    var newChatSelection: AgentSelection? {
        AgentSelection.resolve(agentProviders, stored: lastUsedSelection)
    }

    var newChatProjectName: String? {
        newChatProject.map { URL(fileURLWithPath: $0).lastPathComponent }
    }

    func selectionLabel(_ selection: AgentSelection?, forNewChat: Bool = false) -> String? {
        guard let label = selection?.label(providers: agentProviders, souls: souls) else { return nil }
        // First, because the label truncates and the project cannot change after sending.
        guard forNewChat, let newChatProjectName else { return label }
        return "\(newChatProjectName) · \(label)"
    }

    func select(_ next: AgentSelection) {
        storedSelection = next.stored
        selectForNewChat(next)
        if let id = activeConversationId, !localConversationIds.contains(id) {
            SelectionStorage.setSelection(next.stored, for: id)
        }
    }

    func selectForNewChat(_ next: AgentSelection) {
        lastUsedSelection = next.stored
        SelectionStorage.lastUsed = next.stored
    }

    /// A chat's own choice, or what it last ran with. Never another chat's change.
    private func loadSelection(for id: String) async {
        if let saved = SelectionStorage.selection(for: id) {
            storedSelection = saved
            return
        }
        storedSelection = lastUsedSelection
        let ranWith = (try? await api.lastSelection(conversationId: id)) ?? nil
        let choice = ranWith?.provider != nil ? ranWith : lastUsedSelection
        if let choice {
            SelectionStorage.setSelection(choice, for: id)
            if activeConversationId == id { storedSelection = choice }
        }
    }

    func newConversation() {
        activeConversationId = nil
        handoffFrom = nil
        contextUsage = nil
        awaitingSpokenReply = false
        isLoadingThread = false
        storedSelection = lastUsedSelection
        pendingQuestion = nil
        isAwaitingResponse = false
    }

    func selectConversation(_ id: String) {
        activeConversationId = id
        awaitingSpokenReply = false
        noteSeen()
        pendingQuestion = nil
        isAwaitingResponse = false
        isLoadingThread = conversations.first { $0.id == id }?.messages.isEmpty ?? true
        contextUsage = nil
        sync(id)
        Task {
            await loadSelection(for: id)
            await fetchMessages(for: id)
            if activeConversationId == id { isLoadingThread = false }
            await loadContext(for: id)
        }
    }

    /// Read when the chat opens and when a turn ends, which is when it changes.
    private func loadContext(for id: String) async {
        let usage = try? await api.context(conversationId: id)
        if activeConversationId == id { contextUsage = usage ?? nil }
    }

    /// Plan usage for the selected provider, or nil when it does not report any.
    var selectedPlanUsage: ChompAPI.ProviderUsage? {
        planUsage.first { $0.provider == selection?.provider && $0.available }
    }

    /// A new chat with everything up to the message, opened in place of this one.
    func fork(at messageId: String) async {
        guard let id = activeConversationId, !localConversationIds.contains(id) else { return }
        do {
            let forked = try await api.fork(conversationId: id, messageId: messageId)
            if let current = selection { SelectionStorage.setSelection(current.stored, for: forked) }
            selectConversation(forked)
            await refresh()
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    func loadOlderMessages() async {
        guard let id = activeConversationId, olderMessages.contains(id), !isLoadingOlder,
              let cursor = activeConversation?.messages.first?.cursor else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let page = try await api.listMessages(conversationId: id, before: cursor)
            guard let idx = conversations.firstIndex(where: { $0.id == id }) else { return }
            let known = Set(conversations[idx].messages.map(\.id))
            conversations[idx].messages.insert(contentsOf: page.messages.compactMap(Self.message).filter { !known.contains($0.id) }, at: 0)
            if !page.hasMore { olderMessages.remove(id) }
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    private static func message(from dto: ChompAPI.MessageDTO) -> ChatMessage? {
        guard let role = ChatMessage.Role(rawValue: dto.role) else { return nil }
        return ChatMessage(
            id: dto.id,
            role: role,
            content: dto.content,
            createdAt: dto.createdAt,
            agentUsed: dto.agentUsed,
            turnId: dto.turnId,
            cursor: dto.rawCreatedAt
        )
    }

    /// Asks for what the conversation is doing now, and for the items changed since the last one seen.
    private func sync(_ id: String) {
        client.send(ChatClient.OutgoingSync(conversationId: id, afterSeq: itemsByConversation[id]?.maxSeq ?? 0))
    }

    private func fetchMessages(for conversationId: String) async {
        // Applied together, so the thread does not rebuild twice as they arrive.
        async let loadedItems = try? api.listItems(conversationId: conversationId)
        async let loadedMessages = api.listMessages(conversationId: conversationId)
        do {
            let page = try await loadedMessages
            if let items = await loadedItems {
                apply(items, to: conversationId)
            }
            let mapped = page.messages.compactMap(Self.message)
            // Don't clobber a conversation that has more local messages than the
            // server returned (e.g. an optimistic message mid-flight).
            guard let idx = conversations.firstIndex(where: { $0.id == conversationId }) else {
                conversations.insert(
                    Conversation(id: conversationId, title: "Conversation", messages: mapped, updatedAt: Date()),
                    at: 0
                )
                if page.hasMore { olderMessages.insert(conversationId) }
                return
            }
            // This is the newest page. Pages loaded before it stay; the rest is replaced, unless the
            // server returned fewer than shown (e.g. an optimistic message mid-flight).
            let ids = Set(mapped.map(\.id))
            let cutoff = mapped.first?.createdAt ?? .distantFuture
            let older = conversations[idx].messages.filter { $0.createdAt < cutoff && !ids.contains($0.id) }
            if mapped.count >= conversations[idx].messages.count - older.count {
                conversations[idx].messages = older + mapped
            }
            if older.isEmpty {
                if page.hasMore { olderMessages.insert(conversationId) } else { olderMessages.remove(conversationId) }
            }
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// spoken: said in voice mode, so the agent is asked for a short answer.
    /// interrupt: send now, ending the running turn instead of adding to it.
    func send(_ text: String, attachments: [ChatAttachment] = [], access: String? = nil, spoken: Bool = false, interrupt: Bool = false) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }

        let activeId = activeConversationId
        upsertUserMessage(text: ChatAttachment.content(text: trimmed, attachments: attachments), conversationId: activeId)
        status = "Sending…"
        isAwaitingResponse = true
        if spoken { awaitingSpokenReply = true }

        // An answer is text only. A photo with no text starts a normal message.
        if let pendingQuestion, !trimmed.isEmpty {
            client.send(ChatClient.OutgoingAnswer(sessionId: pendingQuestion.sessionId, answer: trimmed))
            self.pendingQuestion = nil
            return
        }

        // For a brand-new (locally-minted) conversation, send nil so the server
        // creates a fresh conversation and tells us its id via the `conversation`
        // event. Only send a real, server-confirmed id back to the server.
        let outgoingId: String? = {
            guard let id = activeConversationId else { return nil }
            return localConversationIds.contains(id) ? nil : id
        }()
        // Implementing a plan leaves plan mode: the next turns may change things too.
        if let access, var changed = selection {
            changed.access = access
            select(changed)
        }
        let current = selection
        let project = outgoingId == nil ? newChatProject : nil
        let parent = outgoingId == nil ? handoffFrom : nil
        if outgoingId == nil {
            newChatProject = nil
            handoffFrom = nil
        }
        client.send(ChatClient.OutgoingChat(
            content: trimmed,
            conversationId: outgoingId,
            attachments: attachments.isEmpty ? nil : attachments,
            provider: current?.provider,
            model: current?.model,
            effort: current?.effort,
            fast: current?.fast,
            access: current?.access ?? access,
            // A soul deleted since it was picked falls back to the default.
            soulId: souls.contains { $0.id == current?.soulId } ? current?.soulId : nil,
            projectPath: project,
            worktree: project != nil && !newChatWorktree ? false : nil,
            channelContext: spoken ? VoiceChat.spokenContext : nil,
            interrupt: interrupt && outgoingId != nil ? true : nil,
            handoffFrom: parent
        ))
    }

    func stop() {
        client.send(ChatClient.OutgoingCancel())
        isAwaitingResponse = false
        status = "Connected"
    }

    func answerApproval(requestId: String, decision: String) {
        guard let convId = activeConversationId else { return }
        client.send(ChatClient.OutgoingApproval(conversationId: convId, requestId: requestId, decision: decision))
        // Show the answer at once. The server's upsert of the item confirms it.
        itemsByConversation[convId] = itemsByConversation[convId]?.map { item in
            guard case .approval(requestId, let title, let detail, _, let oneTime) = item.body else { return item }
            var answered = item
            answered.body = .approval(requestId: requestId, title: title, detail: detail, state: decision, oneTime: oneTime)
            return answered
        }
    }

    private func apply(_ items: [ChatItem], to conversationId: String) {
        itemsByConversation[conversationId] = (itemsByConversation[conversationId] ?? []).upserting(items)
    }

    private func isActive(_ conversationId: String?) -> Bool {
        conversationId == nil || conversationId == activeConversationId
    }

    private func handle(state: ChatClient.ConnectionState) {
        switch state {
        case .idle: status = "idle"
        case .connecting:
            status = "Connecting…"
            connection = .connecting
        case .connected:
            status = "Connected"
            if case .connected = connection {} else { connection = .connected(since: Date()) }
            if let activeConversationId, !localConversationIds.contains(activeConversationId) {
                sync(activeConversationId)
            }
            Task { await refresh() }
        case .disconnected(let reason):
            status = "Disconnected"
            lastError = reason
            connection = .failed(reason)
        }
    }

    private func handle(_ event: ChatEvent) {
        switch event {
        case .conversationStarted(let realId):
            migrateLocalConversation(to: realId)
        case .agentMessage(let id, let content, let agentUsed, let turnId, let convId):
            // A turn can reply several times, so this does not end the wait. `done` does.
            upsertAssistantMessage(id: id, content: content, agentUsed: agentUsed, turnId: turnId, conversationId: convId)
        case .items(let items):
            for (convId, changed) in Dictionary(grouping: items, by: \.conversationId) {
                apply(changed, to: convId)
            }
            // The agent has it now, so "Sending…" would no longer be true.
            if status == "Sending…" { status = "Connected" }
        case .chunk(let text, let convId):
            appendChunk(text, conversationId: convId)
        case .done(let reply, let messageId, let convId):
            finishStreaming(messageId: messageId, conversationId: convId)
            if let reply {
                upsertAssistantMessage(id: reply.id, content: reply.content, agentUsed: reply.agentUsed, turnId: reply.turnId, conversationId: convId)
            }
            if isActive(convId) {
                status = "Connected"
                isAwaitingResponse = false
                pendingQuestion = nil
            }
            // Brings server times and turn ids, so a reply an item already shows is not shown twice.
            if let id = convId ?? activeConversationId {
                Task {
                    await fetchMessages(for: id)
                    await loadContext(for: id)
                    if let usage = try? await api.usageLimits() { planUsage = usage }
                }
            }
        case .cancelled:
            isAwaitingResponse = false
            status = "Connected"
        case .agentProgress(let s, let elapsed, let convId):
            if isActive(convId) {
                status = "\(s) (\(elapsed)s)"
                isAwaitingResponse = true
            }
        case .agentActivity(let text, let convId):
            if isActive(convId) {
                status = text.isEmpty ? "Working…" : text
                isAwaitingResponse = true
            }
        case .question(let sessionId, let q, let convId):
            if isActive(convId) {
                pendingQuestion = PendingQuestion(sessionId: sessionId, question: q, conversationId: convId)
                isAwaitingResponse = false
            }
        case .syncComplete(let convId, let last):
            if let last, let convId {
                upsertAssistantMessage(id: last.id, content: last.content, agentUsed: last.agentUsed, turnId: nil, conversationId: convId)
            }
            if isActive(convId) {
                status = "Connected"
                isAwaitingResponse = false
            }
        case .handoff(let convId, let content):
            // shortcut: the new chat runs on the current choice; `/handoff opus high` words are not applied, as web does.
            guard convId == activeConversationId else { break }
            newConversation()
            handoffFrom = convId
            handoffNote = content
        case .heartbeat:
            break
        case .error(let msg):
            lastError = msg
            isAwaitingResponse = false
        case .unknown(let type):
            print("[chat] unknown event type: \(type)")
        }
    }

    /// Re-key the active locally-minted conversation onto the server's real id
    /// once the server announces it. Without this, the user's first message
    /// (stored under the local id) and the assistant's reply (tagged with the
    /// real id) end up in two different conversation objects — the first
    /// message appears to "vanish" when the reply arrives.
    private func migrateLocalConversation(to realId: String) {
        guard let localId = activeConversationId,
              localConversationIds.contains(localId),
              localId != realId else {
            // Nothing to migrate (already confirmed or no active local chat).
            // Still make sure the real id is the active one.
            return
        }
        localConversationIds.remove(localId)
        // The new chat keeps what it was started with.
        if let storedSelection {
            SelectionStorage.setSelection(storedSelection, for: realId)
        }

        guard let localIdx = conversations.firstIndex(where: { $0.id == localId }) else {
            activeConversationId = realId
            return
        }
        let localMessages = conversations[localIdx].messages
        let localTitle = conversations[localIdx].title

        if let realIdx = conversations.firstIndex(where: { $0.id == realId }) {
            // A conversation with the real id already exists (e.g. from refresh).
            // Merge local messages in, dedup by id, drop the placeholder.
            var merged = conversations[realIdx].messages
            for m in localMessages where !merged.contains(where: { $0.id == m.id }) {
                merged.append(m)
            }
            conversations[realIdx].messages = merged
            conversations.remove(at: localIdx)
        } else {
            // Rebuild the row under the real id (Conversation.id is immutable).
            let migrated = Conversation(
                id: realId,
                title: localTitle,
                messages: localMessages,
                updatedAt: Date()
            )
            conversations[localIdx] = migrated
        }
        activeConversationId = realId
    }

    private func upsertUserMessage(text: String, conversationId: String?) {
        let id = UUID().uuidString
        let msg = ChatMessage(id: id, role: .user, content: text, createdAt: Date(), agentUsed: nil)
        if let existingId = conversationId, conversations.contains(where: { $0.id == existingId }) {
            let idx = conversations.firstIndex(where: { $0.id == existingId })!
            conversations[idx].messages.append(msg)
            conversations[idx].updatedAt = Date()
            activeConversationId = existingId
        } else {
            // Brand-new chat: mint a local placeholder id and remember it's
            // unconfirmed so send() routes a nil conversationId to the server.
            let localId = UUID().uuidString
            localConversationIds.insert(localId)
            let conv = Conversation(
                id: localId,
                title: String(UserMessageParts(content: text).text.prefix(40)).nilIfEmpty ?? "Photo",
                messages: [msg],
                updatedAt: Date()
            )
            conversations.insert(conv, at: 0)
            activeConversationId = localId
        }
    }

    /// Direct `@chat` replies stream as chunks, into one message until `done` gives it its id.
    private func appendChunk(_ text: String, conversationId: String?) {
        guard let convId = conversationId ?? activeConversationId,
              let idx = conversations.firstIndex(where: { $0.id == convId }) else { return }
        if let last = conversations[idx].messages.indices.last, conversations[idx].messages[last].isStreaming {
            conversations[idx].messages[last].content += text
        } else {
            conversations[idx].messages.append(
                ChatMessage(id: UUID().uuidString, role: .assistant, content: text, createdAt: Date(), agentUsed: nil, isStreaming: true)
            )
        }
    }

    private func finishStreaming(messageId: String?, conversationId: String?) {
        guard let convId = conversationId ?? activeConversationId,
              let idx = conversations.firstIndex(where: { $0.id == convId }),
              let last = conversations[idx].messages.indices.last,
              conversations[idx].messages[last].isStreaming else { return }
        conversations[idx].messages[last].isStreaming = false
        if let messageId {
            conversations[idx].messages[last].id = messageId
        }
    }

    private func upsertAssistantMessage(id: String, content: String, agentUsed: String?, turnId: String?, conversationId: String?) {
        guard let convId = conversationId ?? activeConversationId else { return }
        if !conversations.contains(where: { $0.id == convId }) {
            conversations.insert(
                Conversation(id: convId, title: "New chat", messages: [], updatedAt: Date()),
                at: 0
            )
            activeConversationId = convId
        }
        guard let idx = conversations.firstIndex(where: { $0.id == convId }) else { return }
        if let mIdx = conversations[idx].messages.firstIndex(where: { $0.id == id }) {
            conversations[idx].messages[mIdx].content = content
        } else if conversations[idx].messages.last?.role != .assistant || conversations[idx].messages.last?.content != content {
            // A reply can arrive as both `agent_message` and `done`, under different ids.
            conversations[idx].messages.append(
                ChatMessage(id: id, role: .assistant, content: content, createdAt: Date(), agentUsed: agentUsed, turnId: turnId)
            )
        }
        conversations[idx].updatedAt = Date()
    }
}
