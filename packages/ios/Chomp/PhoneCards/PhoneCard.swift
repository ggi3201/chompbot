import Foundation

/// A time-windowed card, as published by the `publish_phone_cards` tool.
struct PhoneCard: Codable, Equatable, Identifiable {
    struct Alert: Codable, Equatable {
        let at: Date
        let text: String
    }

    struct Row: Codable, Equatable {
        let label: String
        let value: String
    }

    enum Tone: String, Codable {
        case normal
        case urgent
    }

    /// Further away than this, a countdown shows the date instead of running.
    static let countdownRange: TimeInterval = 24 * 60 * 60

    let id: String
    let group: String
    let board: String
    let showFrom: Date
    let showUntil: Date
    let headline: String
    let detail: String?
    let countdownTo: Date?
    let alerts: [Alert]
    let icon: String?
    let tone: Tone
    let rows: [Row]
    let link: URL?
    let source: String?
    let checkedAt: Date?
}

extension Array where Element == PhoneCard {
    /// The cards to show at `date`, the one that ends first on top. A nil board means all boards.
    func showing(at date: Date, board: String?) -> [PhoneCard] {
        filter { $0.showFrom <= date && date < $0.showUntil && (board == nil || $0.board == board) }
            .sorted { $0.showUntil < $1.showUntil }
    }

    /// Cards that start after `date`, soonest first. The later stages of a group already
    /// showing are left out, because they say nothing new.
    func upcoming(after date: Date, board: String?) -> [PhoneCard] {
        let showingGroups = Set(showing(at: date, board: board).map(\.group))
        return filter { $0.showFrom > date && (board == nil || $0.board == board) && !showingGroups.contains($0.group) }
            .sorted { $0.showFrom < $1.showFrom }
    }

    /// The moments after `date` when the widget must look different.
    func changes(after date: Date, board: String?) -> [Date] {
        let moments = filter { board == nil || $0.board == board }.flatMap { card in
            [card.showFrom, card.showUntil, card.countdownTo?.addingTimeInterval(-PhoneCard.countdownRange)].compactMap { $0 }
        }
        return Set(moments).filter { $0 > date }.sorted()
    }
}
