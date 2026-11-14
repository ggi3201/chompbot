import Foundation
import EventKit

@MainActor
final class CalendarTools {
    private let store: EKEventStore

    init(store: EKEventStore) {
        self.store = store
    }

    enum CalendarError: LocalizedError {
        case denied
        case noCalendar
        case invalidDate(String)
        var errorDescription: String? {
            switch self {
            case .denied: return "Calendar permission denied"
            case .noCalendar: return "No default calendar configured"
            case .invalidDate(let s): return "Invalid date: \(s)"
            }
        }
    }

    func listEvents(from: Date, to: Date, calendarName: String? = nil) throws -> [[String: Any]] {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            throw CalendarError.denied
        }
        var cals = store.calendars(for: .event)
        if let calendarName, !calendarName.isEmpty {
            cals = cals.filter { $0.title.localizedCaseInsensitiveContains(calendarName) }
        }
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: cals.isEmpty ? nil : cals)
        let events = store.events(matching: predicate)
        return events.map { e -> [String: Any] in
            var out: [String: Any] = [
                "id": e.eventIdentifier ?? "",
                "title": e.title ?? "(no title)",
                "start": ISO8601DateFormatter().string(from: e.startDate),
                "end": ISO8601DateFormatter().string(from: e.endDate),
                "allDay": e.isAllDay,
                "calendar": e.calendar?.title ?? "",
            ]
            if let location = e.location, !location.isEmpty { out["location"] = location }
            if let notes = e.notes, !notes.isEmpty { out["notes"] = notes }
            return out
        }
    }

    func createEvent(title: String, start: Date, end: Date, location: String?, notes: String?, calendarName: String?) throws -> String {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            throw CalendarError.denied
        }
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = start
        event.endDate = end
        if let location, !location.isEmpty { event.location = location }
        if let notes, !notes.isEmpty { event.notes = notes }
        let target: EKCalendar?
        if let calendarName, !calendarName.isEmpty {
            target = store.calendars(for: .event).first(where: { $0.title.localizedCaseInsensitiveContains(calendarName) })
        } else {
            target = store.defaultCalendarForNewEvents
        }
        guard let cal = target else { throw CalendarError.noCalendar }
        event.calendar = cal
        try store.save(event, span: .thisEvent, commit: true)
        return event.eventIdentifier
    }

    func listReminders(includeCompleted: Bool) async throws -> [[String: Any]] {
        guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else {
            throw CalendarError.denied
        }
        let predicate = includeCompleted
            ? store.predicateForReminders(in: nil)
            : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        return try await withCheckedThrowingContinuation { cont in
            store.fetchReminders(matching: predicate) { reminders in
                let arr = (reminders ?? []).map { r -> [String: Any] in
                    var out: [String: Any] = [
                        "id": r.calendarItemIdentifier,
                        "title": r.title ?? "(no title)",
                        "completed": r.isCompleted,
                    ]
                    if let due = r.dueDateComponents?.date {
                        out["due"] = ISO8601DateFormatter().string(from: due)
                    }
                    if let notes = r.notes, !notes.isEmpty { out["notes"] = notes }
                    return out
                }
                cont.resume(returning: arr)
            }
        }
    }

    func addReminder(title: String, due: Date?, notes: String?) throws -> String {
        guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else {
            throw CalendarError.denied
        }
        let r = EKReminder(eventStore: store)
        r.title = title
        if let notes, !notes.isEmpty { r.notes = notes }
        if let due {
            r.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
        }
        r.calendar = store.defaultCalendarForNewReminders()
        try store.save(r, commit: true)
        return r.calendarItemIdentifier
    }
}

/// Parse an ISO 8601 timestamp; falls back to common YYYY-MM-DD form.
enum DateArg {
    static func parse(_ raw: String) -> Date? {
        if let d = ISO8601DateFormatter().date(from: raw) { return d }
        let formatters: [String] = ["yyyy-MM-dd HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd"]
        for fmt in formatters {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = fmt
            if let d = f.date(from: raw) { return d }
        }
        return nil
    }
}
