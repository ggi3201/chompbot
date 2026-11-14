import SwiftUI

/// The first screen: today's headline, what matters now and the way back into a chat.
struct HomeView: View {
    @EnvironmentObject private var store: ChatStore
    @EnvironmentObject private var voice: VoiceChat
    @Environment(\.scenePhase) private var scenePhase
    @State private var today: ChompAPI.Today?
    @State private var cards: [PhoneCard] = PhoneCardStore.saved()
    @State private var draft = ""
    @State private var showingThread = false
    @State private var showingAgentPicker = false
    @FocusState private var focused: Bool

    private func load() async {
        async let loadedCards = PhoneCardStore.refresh()
        async let loadedToday = try? ChompAPI(config: AppConfig.shared).today()
        cards = await loadedCards
        today = await loadedToday ?? today
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    HomeHeader(isLive: store.status != "Disconnected" && store.status != "Not configured")
                    if let report = today?.report {
                        HeadlineView(report: report, url: today?.reportUrl)
                    }
                    // Rebuilds as cards start and end, with no network.
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        HomeCards(
                            now: cards.showing(at: context.date, board: nil),
                            next: Array(cards.upcoming(after: context.date, board: nil).prefix(3)),
                            date: context.date
                        )
                    }
                    RecentChats { id in
                        store.selectConversation(id)
                        showingThread = true
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 32)
            }
            .background(Theme.surface)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable {
                await load()
                await store.refresh()
            }
            .task {
                await load()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await load() } }
            }
            .safeAreaInset(edge: .bottom) {
                ComposerView(
                    draft: $draft,
                    focused: $focused,
                    agentLabel: store.selectionLabel(store.newChatSelection, forNewChat: true),
                    agentSelection: store.newChatSelection,
                    onPickAgent: { showingAgentPicker = true },
                    voice: voice
                ) { attachments in
                    startChat(attachments)
                }
                .onAppear {
                    voice.onUtterance = { text, asDraft in
                        let message = draft.isEmpty ? text : "\(draft) \(text)"
                        if asDraft { draft = message } else { startChat([], text: message, spoken: true) }
                    }
                }
            }
            .navigationDestination(isPresented: $showingThread) {
                ThreadView()
            }
            .sheet(isPresented: $showingAgentPicker) {
                if let selection = store.newChatSelection {
                    AgentSelectionView(selection: selection, picksProject: true, onChange: store.selectForNewChat)
                }
            }
        }
    }
}

extension HomeView {
    /// Sends the draft as the first message of a new chat and opens it.
    fileprivate func startChat(_ attachments: [ChatAttachment], text: String? = nil, spoken: Bool = false) {
        let text = text ?? draft
        draft = ""
        focused = false
        store.newConversation()
        store.send(text, attachments: attachments, spoken: spoken)
        showingThread = true
    }
}

private struct HomeHeader: View {
    let isLive: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(Date.now, format: .dateTime.weekday(.wide).day().month(.wide))
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
            Spacer()
            if isLive {
                LiveDot().accessibilityLabel("Connected")
            }
        }
    }
}

/// The screen's one rich moment. Set like the morning report's front page.
private struct HeadlineView: View {
    let report: ChompAPI.Today.Report
    let url: URL?

    private var weatherLine: String {
        var parts = [report.place]
        if let weather = report.weather {
            parts.append(weather.summary)
            if let high = weather.high, let low = weather.low {
                parts.append("\(Int(high.rounded()))° / \(Int(low.rounded()))°")
            }
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(report.headline)
                .font(.system(size: 34, weight: .regular, design: .serif))
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.leading)
            Text(weatherLine)
                .font(.caption.monospaced())
                .foregroundStyle(Theme.textMuted)
            if url != nil {
                HStack(spacing: 4) {
                    Text("Morning report")
                    Image(systemName: "chevron.right").font(.caption2)
                }
                .font(.footnote)
                .foregroundStyle(Theme.accentInk)
            }
        }
    }

    var body: some View {
        if let url {
            Link(destination: url) { content }
        } else {
            content
        }
    }
}

private struct HomeCards: View {
    let now: [PhoneCard]
    let next: [PhoneCard]
    let date: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            if !now.isEmpty {
                HomeSection(title: "Now") {
                    ForEach(now) { card in
                        HomeCardRow(card: card, date: date)
                    }
                }
            }
            if !next.isEmpty {
                HomeSection(title: "Up next") {
                    ThemedCard {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(next) { card in
                                VStack(alignment: .leading, spacing: 2) {
                                    if !Calendar.current.isDate(card.showFrom, inSameDayAs: date) {
                                        Text(card.showFrom, format: .dateTime.weekday(.wide))
                                            .font(.caption)
                                            .foregroundStyle(Theme.textMuted)
                                    }
                                    Text(card.headline)
                                        .font(.subheadline)
                                        .foregroundStyle(Theme.textPrimary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct HomeSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.textSecondary)
            content
        }
    }
}

private struct HomeCardRow: View {
    let card: PhoneCard
    let date: Date

    private var emphasis: Color {
        card.tone == .urgent ? Theme.error : Theme.textPrimary
    }

    @ViewBuilder
    private var content: some View {
        ThemedCard(emphasized: card.tone == .urgent) {
            VStack(alignment: .leading, spacing: 4) {
                Group {
                    if let icon = card.icon {
                        Text("\(Image(systemName: icon)) \(card.headline)")
                    } else {
                        Text(card.headline)
                    }
                }
                .font(.headline)
                .foregroundStyle(emphasis)
                if let target = card.countdownTo {
                    if target.timeIntervalSince(date) < PhoneCard.countdownRange {
                        Text(timerInterval: date...max(date, target), countsDown: true)
                            .font(.title.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(emphasis)
                    } else {
                        Text(target, format: .dateTime.weekday().hour().minute())
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(emphasis)
                    }
                }
                if let detail = card.detail {
                    Text(detail).font(.footnote).foregroundStyle(Theme.textSecondary)
                }
                ForEach(card.rows, id: \.label) { row in
                    HStack {
                        Text(row.label).foregroundStyle(Theme.textSecondary)
                        Spacer()
                        Text(row.value).fontWeight(.semibold).foregroundStyle(Theme.textPrimary)
                    }
                    .font(.footnote)
                }
            }
        }
    }

    var body: some View {
        if let link = card.link {
            Link(destination: link) { content }
                .buttonStyle(.plain)
        } else {
            content
        }
    }
}

private struct RecentChats: View {
    @EnvironmentObject private var store: ChatStore
    let onOpen: (String) -> Void

    var body: some View {
        if !store.conversations.isEmpty {
            HomeSection(title: "Recent chats") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(store.conversations.prefix(5).enumerated()), id: \.element.id) { index, conversation in
                        if index > 0 {
                            Theme.hairline.frame(height: 1)
                        }
                        Button {
                            onOpen(conversation.id)
                        } label: {
                            HStack(spacing: 8) {
                                Text(conversation.title)
                                    .font(.subheadline)
                                    .foregroundStyle(Theme.textPrimary)
                                    .lineLimit(1)
                                Spacer()
                                Text(conversation.updatedAt, format: .relative(presentation: .named))
                                    .font(.caption.monospaced())
                                    .foregroundStyle(Theme.textMuted)
                                    .lineLimit(1)
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12)
                .background(Theme.card)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.hairline)
                }
            }
        }
    }
}
