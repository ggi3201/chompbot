import AppIntents
import SwiftUI
import WidgetKit

@main
struct PhoneCardsWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "PhoneCards", intent: SelectBoard.self, provider: CardsProvider()) { entry in
            CardsView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Chomp")
        .description("What matters right now.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
    }
}

struct BoardOptions: DynamicOptionsProvider {
    func results() async throws -> [String] {
        [SelectBoard.allBoards] + Set(PhoneCardStore.saved().map(\.board)).sorted()
    }
}

struct SelectBoard: WidgetConfigurationIntent {
    static let allBoards = "All boards"
    static var title: LocalizedStringResource = "Board"
    static var description = IntentDescription("Choose which board this widget shows.")

    @Parameter(title: "Board", optionsProvider: BoardOptions())
    var board: String?

    var boardFilter: String? {
        board == Self.allBoards ? nil : board
    }
}

struct CardsEntry: TimelineEntry {
    let date: Date
    let cards: [PhoneCard]
    let upcoming: [PhoneCard]

    init(date: Date, from cards: [PhoneCard], board: String?) {
        self.date = date
        self.cards = cards.showing(at: date, board: board)
        self.upcoming = cards.upcoming(after: date, board: board)
    }
}

struct CardsProvider: AppIntentTimelineProvider {
    private static let example = PhoneCard(
        id: "example",
        group: "example",
        board: "travel",
        showFrom: .distantPast,
        showUntil: .distantFuture,
        headline: "Leave the office at 12:50",
        detail: "Airport train 13:30 from the central station",
        countdownTo: .now.addingTimeInterval(20 * 60),
        alerts: [],
        icon: "tram.fill",
        tone: .normal,
        rows: [],
        link: nil,
        source: nil,
        checkedAt: nil
    )

    func placeholder(in context: Context) -> CardsEntry {
        CardsEntry(date: .now, from: [Self.example], board: nil)
    }

    func snapshot(for configuration: SelectBoard, in context: Context) async -> CardsEntry {
        let saved = PhoneCardStore.saved()
        return CardsEntry(date: .now, from: context.isPreview && saved.isEmpty ? [Self.example] : saved, board: configuration.boardFilter)
    }

    /// Lays out every change ahead, so the widget switches cards with no network.
    func timeline(for configuration: SelectBoard, in context: Context) async -> Timeline<CardsEntry> {
        let now = Date.now
        let cards = await PhoneCardStore.refresh()
        let board = configuration.boardFilter
        let dates = [now] + cards.changes(after: now, board: board).prefix(60)
        let entries = dates.map { CardsEntry(date: $0, from: cards, board: board) }
        return Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60)))
    }
}

struct CardsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: CardsEntry

    private var top: PhoneCard? { entry.cards.first }

    var body: some View {
        content.widgetURL(top?.link.flatMap(PhoneCardLink.opening))
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryInline:
            CardHeadline(card: top)
        case .accessoryRectangular:
            VStack(alignment: .leading) {
                CardHeadline(card: top)
                    .font(.headline)
                    .lineLimit(2)
                if let target = top?.countdownTo {
                    Countdown(target: target, now: entry.date)
                } else if let detail = top?.detail {
                    Text(detail).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .systemMedium:
            HStack(alignment: .top, spacing: 16) {
                column(for: top)
                if entry.cards.count > 1 {
                    Divider()
                    column(for: entry.cards[1])
                } else if top != nil, !entry.upcoming.isEmpty {
                    Divider()
                    UpNext(cards: Array(entry.upcoming.prefix(2)), now: entry.date)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
        case .systemLarge:
            VStack(alignment: .leading, spacing: 12) {
                if entry.cards.isEmpty {
                    NothingNow(upcoming: entry.upcoming, now: entry.date)
                }
                ForEach(entry.cards.prefix(3)) { card in
                    TappableCard(card: card, now: entry.date)
                    Divider()
                }
                if !entry.cards.isEmpty, !entry.upcoming.isEmpty {
                    UpNext(cards: Array(entry.upcoming.prefix(3)), now: entry.date)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        default:
            column(for: top)
        }
    }

    @ViewBuilder
    private func column(for card: PhoneCard?) -> some View {
        Group {
            if let card {
                if family == .systemSmall {
                    CardView(card: card, now: entry.date)
                } else {
                    TappableCard(card: card, now: entry.date)
                }
            } else {
                NothingNow(upcoming: entry.upcoming, now: entry.date)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Medium and large widgets can open a different link per card. Small ones cannot.
struct TappableCard: View {
    let card: PhoneCard
    let now: Date

    var body: some View {
        if let url = card.link.flatMap(PhoneCardLink.opening) {
            Link(destination: url) { CardView(card: card, now: now) }
        } else {
            CardView(card: card, now: now)
        }
    }
}

struct CardHeadline: View {
    let card: PhoneCard?

    var body: some View {
        if let card, let icon = card.icon {
            Text("\(Image(systemName: icon)) \(card.headline)")
        } else {
            Text(card?.headline ?? "Nothing right now")
        }
    }
}

struct CardView: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    let card: PhoneCard
    let now: Date

    /// On Clear and Tinted home screens the wallpaper shows through, and dimmed text gets hard to read.
    private var smallTextStyle: HierarchicalShapeStyle {
        renderingMode == .fullColor ? .secondary : .primary
    }

    /// Red only works in full colour. The other modes draw everything in one colour.
    private var emphasis: Color {
        card.tone == .urgent && renderingMode == .fullColor ? .red : .primary
    }

    /// For example "Airport train, checked 11:40".
    private var checkedLine: String? {
        let checked = card.checkedAt.map { "checked \($0.formatted(.dateTime.hour().minute()))" }
        let parts = [card.source, checked].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    var body: some View {
        // Takes the fullest layout that fits. The headline and countdown always stay.
        ViewThatFits(in: .vertical) {
            layout(rows: card.rows, showsChecked: true)
            layout(rows: Array(card.rows.prefix(2)), showsChecked: true)
            layout(rows: Array(card.rows.prefix(1)), showsChecked: false)
            layout(rows: [], showsChecked: true)
            layout(rows: [], showsChecked: false)
        }
    }

    private func layout(rows: [PhoneCard.Row], showsChecked: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            CardHeadline(card: card)
                .font(.headline)
                .foregroundStyle(emphasis)
                .lineLimit(3)
            if let target = card.countdownTo {
                Countdown(target: target, now: now)
                    .font(.title.weight(.semibold))
                    .foregroundStyle(emphasis)
            }
            if let detail = card.detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(smallTextStyle)
                    .lineLimit(2)
            }
            ForEach(rows, id: \.label) { row in
                HStack(spacing: 6) {
                    Text(row.label)
                        .foregroundStyle(smallTextStyle)
                    Spacer(minLength: 0)
                    Text(row.value)
                        .fontWeight(.semibold)
                }
                .font(.footnote)
                .lineLimit(1)
            }
            if showsChecked, let checkedLine {
                Spacer(minLength: 0)
                Text(checkedLine)
                    .font(.caption2)
                    .foregroundStyle(smallTextStyle)
                    .lineLimit(1)
            }
        }
    }
}

struct UpNext: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    let cards: [PhoneCard]
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Up next")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(renderingMode == .fullColor ? .secondary : .primary)
            ForEach(cards) { card in
                VStack(alignment: .leading, spacing: 0) {
                    // showFrom is when the card appears, not when the event is, so only its day is useful.
                    if !Calendar.current.isDate(card.showFrom, inSameDayAs: now) {
                        Text(card.showFrom, format: .dateTime.weekday(.wide))
                            .font(.caption)
                            .foregroundStyle(renderingMode == .fullColor ? .secondary : .primary)
                    }
                    CardHeadline(card: card)
                        .font(.footnote.weight(.semibold))
                        .lineLimit(2)
                }
            }
        }
    }
}

struct NothingNow: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    let upcoming: [PhoneCard]
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Nothing right now")
                .font(.subheadline)
                .foregroundStyle(renderingMode == .fullColor ? .secondary : .primary)
            if !upcoming.isEmpty {
                UpNext(cards: Array(upcoming.prefix(1)), now: now)
            }
        }
    }
}

struct Countdown: View {
    let target: Date
    let now: Date

    var body: some View {
        if target.timeIntervalSince(now) < PhoneCard.countdownRange {
            Text(timerInterval: now...max(now, target), countsDown: true)
                .monospacedDigit()
        } else {
            Text(target, format: .dateTime.weekday().hour().minute())
        }
    }
}
