import Foundation
import UIKit
import AVFoundation
import EventKit
import HealthKit

/// A small typed wrapper so we can return arbitrary JSON-ish payloads from tool
/// handlers without dragging in a JSON DSL. `JSONSerialization` is what serializes.
typealias ToolResult = [String: Any]

struct BridgeToolDefinition {
    let name: String
    let description: String
    let inputSchema: [String: Any] // JSON Schema object

    func toDictionary() -> [String: Any] {
        ["name": name, "description": description, "inputSchema": inputSchema]
    }
}

/// Registry of tools the iPhone advertises to Chomp's agent. Each handler runs
/// on the main thread (UIKit/AVFoundation prefers that). Tools that don't need
/// user permission go in v0; permission-requiring tools (location, photos,
/// notifications) are deferred.
@MainActor
final class BridgeToolRegistry {
    typealias Handler = (_ args: [String: Any]) async throws -> Any

    private struct Entry {
        let def: BridgeToolDefinition
        let handle: Handler
    }

    private var entries: [String: Entry] = [:]
    private let synthesizer = AVSpeechSynthesizer()

    // Permission-gated tool collaborators.
    let location = LocationTools()
    let contacts = ContactsTools()
    let photos = PhotosTools()
    let notifications = NotificationTools()
    let shortcuts = ShortcutsTools.shared
    let bookmarks: FileBookmarkStore
    let calendar: CalendarTools
    let health: HealthKitTools

    init(eventStore: EKEventStore,
         healthStore: HKHealthStore,
         bookmarks: FileBookmarkStore) {
        self.bookmarks = bookmarks
        self.calendar = CalendarTools(store: eventStore)
        self.health = HealthKitTools(store: healthStore)
        registerCoreTools()
        registerPermissionedTools()
    }

    private func registerCoreTools() {
        register(.readClipboard) { _ in
            ["text": UIPasteboard.general.string ?? ""]
        }
        register(.setClipboard) { args in
            let text = args["text"] as? String ?? ""
            UIPasteboard.general.string = text
            return ["ok": true, "length": text.count]
        }
        register(.getBattery) { _ in
            UIDevice.current.isBatteryMonitoringEnabled = true
            let level = UIDevice.current.batteryLevel
            let state: String
            switch UIDevice.current.batteryState {
            case .charging: state = "charging"
            case .full: state = "full"
            case .unplugged: state = "unplugged"
            default: state = "unknown"
            }
            return [
                "level": Int((level < 0 ? 0 : level) * 100),
                "state": state,
            ]
        }
        register(.getDeviceInfo) { _ in
            [
                "name": UIDevice.current.name,
                "systemName": UIDevice.current.systemName,
                "systemVersion": UIDevice.current.systemVersion,
                "model": UIDevice.current.model,
                "identifierForVendor": UIDevice.current.identifierForVendor?.uuidString ?? "",
            ]
        }
        register(.speak) { [weak self] args in
            guard let self else { return ["ok": false] }
            let text = args["text"] as? String ?? ""
            let rate = (args["rate"] as? Double).map(Float.init) ?? AVSpeechUtteranceDefaultSpeechRate
            let utt = AVSpeechUtterance(string: text)
            utt.rate = rate
            self.synthesizer.speak(utt)
            return ["ok": true, "characters": text.count]
        }
        register(.vibrate) { args in
            let style = (args["style"] as? String) ?? "medium"
            let mapped: UIImpactFeedbackGenerator.FeedbackStyle = {
                switch style {
                case "light": return .light
                case "medium": return .medium
                case "heavy": return .heavy
                case "soft": return .soft
                case "rigid": return .rigid
                default: return .medium
                }
            }()
            let gen = UIImpactFeedbackGenerator(style: mapped)
            gen.impactOccurred()
            return ["ok": true, "style": style]
        }
    }

    private func registerPermissionedTools() {
        // ── Location ──
        // A silent push wakes the app with the phone locked. That only works with
        // Always access, and one read per request uses almost no battery.
        register(.getLocation) { [weak self] _ in
            guard let self else { return ["ok": false] }
            let loc = try await self.location.getLocation()
            return [
                "latitude": loc.coordinate.latitude,
                "longitude": loc.coordinate.longitude,
                "accuracyMeters": loc.horizontalAccuracy,
                "altitudeMeters": loc.altitude,
                "timestamp": ISO8601DateFormatter().string(from: loc.timestamp),
            ]
        }

        // ── Calendar / Reminders ──
        register(.listEvents) { [weak self] args in
            guard let self else { return ["events": [Any]()] }
            let now = Date()
            let from = (args["from"] as? String).flatMap(DateArg.parse) ?? Calendar.current.startOfDay(for: now)
            let to = (args["to"] as? String).flatMap(DateArg.parse) ?? Calendar.current.date(byAdding: .day, value: 1, to: from) ?? now
            let calName = args["calendar"] as? String
            let events = try self.calendar.listEvents(from: from, to: to, calendarName: calName)
            return ["events": events, "from": ISO8601DateFormatter().string(from: from), "to": ISO8601DateFormatter().string(from: to)]
        }
        register(.createEvent) { [weak self] args in
            guard let self else { return [:] }
            let title = args["title"] as? String ?? ""
            guard let startStr = args["start"] as? String, let start = DateArg.parse(startStr) else {
                throw CalendarTools.CalendarError.invalidDate(args["start"] as? String ?? "")
            }
            let end: Date
            if let endStr = args["end"] as? String, let parsed = DateArg.parse(endStr) {
                end = parsed
            } else {
                end = start.addingTimeInterval(3600)
            }
            let id = try self.calendar.createEvent(
                title: title, start: start, end: end,
                location: args["location"] as? String,
                notes: args["notes"] as? String,
                calendarName: args["calendar"] as? String
            )
            return ["id": id]
        }
        register(.listReminders) { [weak self] args in
            guard let self else { return ["reminders": [Any]()] }
            let includeCompleted = args["includeCompleted"] as? Bool ?? false
            let reminders = try await self.calendar.listReminders(includeCompleted: includeCompleted)
            return ["reminders": reminders]
        }
        register(.addReminder) { [weak self] args in
            guard let self else { return [:] }
            let title = args["title"] as? String ?? ""
            let due = (args["due"] as? String).flatMap(DateArg.parse)
            let id = try self.calendar.addReminder(title: title, due: due, notes: args["notes"] as? String)
            return ["id": id]
        }

        // ── Contacts ──
        register(.searchContact) { [weak self] args in
            guard let self else { return ["matches": [Any]()] }
            let query = args["query"] as? String ?? ""
            let limit = args["limit"] as? Int ?? 10
            let matches = try self.contacts.search(query: query, limit: limit)
            return ["matches": matches]
        }

        // ── Photos ──
        register(.listRecentPhotos) { [weak self] args in
            guard let self else { return ["photos": [Any]()] }
            let limit = args["limit"] as? Int ?? 10
            return ["photos": try self.photos.listRecent(limit: limit)]
        }
        register(.readPhoto) { [weak self] args in
            guard let self else { return [:] }
            let id = args["id"] as? String ?? ""
            let maxDimension = max(1, min(args["max_dimension"] as? Int ?? 1568, 4096))
            return try await self.photos.read(id: id, maxDimension: maxDimension)
        }
        register(.saveImage) { [weak self] args in
            guard let self else { return [:] }
            let base64 = args["base64"] as? String ?? ""
            let id = try await self.photos.saveImage(base64: base64)
            return ["assetId": id]
        }

        // ── Notifications ──
        register(.notify) { [weak self] args in
            guard let self else { return [:] }
            let title = args["title"] as? String ?? "Chomp"
            let body = args["body"] as? String ?? ""
            let after = args["after_seconds"] as? Double
            let id = try await self.notifications.notify(title: title, body: body, afterSeconds: after)
            return ["id": id]
        }

        // ── Shortcuts ──
        register(.runShortcut) { [weak self] args in
            guard let self else { return [:] }
            let name = args["name"] as? String ?? ""
            let input = args["input"] as? String
            return try await self.shortcuts.run(name: name, input: input)
        }
        register(.openUrl) { [weak self] args in
            guard let self else { return [:] }
            let link = args["url"] as? String ?? ""
            guard let url = URL(string: link), url.scheme != nil else { throw ShortcutsTools.ShortcutsError.invalidURL(link) }
            try await self.shortcuts.open(url)
            return ["opened": link]
        }

        // ── Files (security-scoped bookmarks) ──
        register(.listPickedFiles) { [weak self] _ in
            ["files": self?.bookmarks.list() ?? []]
        }
        register(.readPickedFile) { [weak self] args in
            guard let self else { return [:] }
            let id = args["id"] as? String ?? ""
            let maxBytes = args["max_bytes"] as? Int ?? 64_000
            return try self.bookmarks.read(id: id, maxBytes: maxBytes)
        }

        // ── HealthKit ──
        register(.getStepsToday) { [weak self] _ in
            try await self?.health.getStepsToday() ?? [:]
        }
        register(.getActiveEnergyToday) { [weak self] _ in
            try await self?.health.getActiveEnergyToday() ?? [:]
        }
        register(.getHeartRateRecent) { [weak self] args in
            let minutes = args["minutes"] as? Int ?? 30
            return try await self?.health.getHeartRateRecent(minutes: minutes) ?? [:]
        }
        register(.getSleepLastNight) { [weak self] _ in
            try await self?.health.getSleepLastNight() ?? [:]
        }
    }

    func list() -> [BridgeToolDefinition] { entries.values.map { $0.def } }

    func call(name: String, args: [String: Any]) async -> (ok: Bool, payload: Any) {
        guard let entry = entries[name] else {
            return (false, "Unknown tool: \(name)")
        }
        do {
            let result = try await entry.handle(args)
            return (true, result)
        } catch {
            return (false, error.localizedDescription)
        }
    }

    private func register(_ def: BridgeToolDefinition, _ handle: @escaping Handler) {
        entries[def.name] = Entry(def: def, handle: handle)
    }
}

// MARK: - Tool definitions

extension BridgeToolDefinition {
    static let readClipboard = BridgeToolDefinition(
        name: "read_clipboard",
        description: "Read the current clipboard contents from the device.",
        inputSchema: ["type": "object", "properties": [:]]
    )
    static let setClipboard = BridgeToolDefinition(
        name: "set_clipboard",
        description: "Replace the device clipboard with the given text.",
        inputSchema: [
            "type": "object",
            "properties": ["text": ["type": "string"]],
            "required": ["text"],
        ]
    )
    static let getBattery = BridgeToolDefinition(
        name: "get_battery",
        description: "Return the device's current battery level (0-100) and charging state.",
        inputSchema: ["type": "object", "properties": [:]]
    )
    static let getDeviceInfo = BridgeToolDefinition(
        name: "get_device_info",
        description: "Return the device name, model, OS name and version.",
        inputSchema: ["type": "object", "properties": [:]]
    )
    static let speak = BridgeToolDefinition(
        name: "speak",
        description: "Speak the given text out loud through the device speaker using the system text-to-speech voice.",
        inputSchema: [
            "type": "object",
            "properties": [
                "text": ["type": "string"],
                "rate": ["type": "number", "description": "Optional speech rate (0.0–1.0, default ~0.5)."],
            ],
            "required": ["text"],
        ]
    )
    static let vibrate = BridgeToolDefinition(
        name: "vibrate",
        description: "Trigger a haptic feedback impact on the device. style: light, medium, heavy, soft, or rigid.",
        inputSchema: [
            "type": "object",
            "properties": ["style": ["type": "string"]],
        ]
    )

    // ── Permission-gated tools ──────────────────────────────────────

    static let getLocation = BridgeToolDefinition(
        name: "get_location",
        description: "Return the device's current latitude and longitude (one-shot). Works with the phone locked when location access is Always.",
        inputSchema: ["type": "object", "properties": [:]]
    )
    static let listEvents = BridgeToolDefinition(
        name: "list_events",
        description: "List calendar events between `from` and `to` (ISO 8601). Defaults to today if omitted.",
        inputSchema: [
            "type": "object",
            "properties": [
                "from": ["type": "string"],
                "to": ["type": "string"],
                "calendar": ["type": "string", "description": "Optional calendar name to filter by."],
            ],
        ]
    )
    static let createEvent = BridgeToolDefinition(
        name: "create_event",
        description: "Create a calendar event. start required (ISO 8601); end defaults to start + 1h.",
        inputSchema: [
            "type": "object",
            "properties": [
                "title": ["type": "string"],
                "start": ["type": "string"],
                "end": ["type": "string"],
                "location": ["type": "string"],
                "notes": ["type": "string"],
                "calendar": ["type": "string"],
            ],
            "required": ["title", "start"],
        ]
    )
    static let listReminders = BridgeToolDefinition(
        name: "list_reminders",
        description: "List Reminders. By default only incomplete; pass includeCompleted:true for all.",
        inputSchema: ["type": "object", "properties": ["includeCompleted": ["type": "boolean"]]]
    )
    static let addReminder = BridgeToolDefinition(
        name: "add_reminder",
        description: "Add a reminder. Optional `due` ISO 8601 timestamp.",
        inputSchema: [
            "type": "object",
            "properties": [
                "title": ["type": "string"],
                "due": ["type": "string"],
                "notes": ["type": "string"],
            ],
            "required": ["title"],
        ]
    )
    static let searchContact = BridgeToolDefinition(
        name: "search_contact",
        description: "Search the user's contacts by name (matches given/family/nickname).",
        inputSchema: [
            "type": "object",
            "properties": [
                "query": ["type": "string"],
                "limit": ["type": "integer"],
            ],
            "required": ["query"],
        ]
    )
    static let listRecentPhotos = BridgeToolDefinition(
        name: "list_recent_photos",
        description: "List metadata for the N most recent photos, newest first, with isScreenshot. Does not return the image: pass an id to read_photo.",
        inputSchema: ["type": "object", "properties": ["limit": ["type": "integer"]]]
    )
    static let readPhoto = BridgeToolDefinition(
        name: "read_photo",
        description: "Get one photo so you can see it, by id from list_recent_photos. Comes back as a JPEG image. Pass a longer timeout_ms if it may need downloading from iCloud.",
        inputSchema: [
            "type": "object",
            "properties": [
                "id": ["type": "string"],
                "max_dimension": ["type": "integer", "description": "Longest side in pixels (default 1568, max 4096)."],
            ],
            "required": ["id"],
        ]
    )
    static let saveImage = BridgeToolDefinition(
        name: "save_image",
        description: "Save a base64-encoded PNG/JPEG image to the user's photo library and return the new asset's local identifier.",
        inputSchema: [
            "type": "object",
            "properties": ["base64": ["type": "string"]],
            "required": ["base64"],
        ]
    )
    static let notify = BridgeToolDefinition(
        name: "notify",
        description: "Schedule a local notification on the device. Optional after_seconds delay (default 1s).",
        inputSchema: [
            "type": "object",
            "properties": [
                "title": ["type": "string"],
                "body": ["type": "string"],
                "after_seconds": ["type": "number"],
            ],
            "required": ["title", "body"],
        ]
    )
    static let runShortcut = BridgeToolDefinition(
        name: "run_shortcut",
        description: "Run an Apple Shortcut by name and return its text output, up to 2 minutes later. Chomp must be on screen, and iOS comes back to Chomp when the Shortcut ends. Fails if the Shortcut does not exist. Only text output comes back, and iOS asks the user once to allow it.",
        inputSchema: [
            "type": "object",
            "properties": [
                "name": ["type": "string"],
                "input": ["type": "string", "description": "Optional text passed as the Shortcut's input."],
            ],
            "required": ["name"],
        ]
    )
    static let openUrl = BridgeToolDefinition(
        name: "open_url",
        description: "Open a URL on the phone: a website, a deep link into another app (spotify:, comgooglemaps:, maps:) or tel:. Chomp must be on screen. It opens the link and does not know what happens next.",
        inputSchema: [
            "type": "object",
            "properties": ["url": ["type": "string"]],
            "required": ["url"],
        ]
    )
    static let listPickedFiles = BridgeToolDefinition(
        name: "list_picked_files",
        description: "List files the user has previously picked in Settings → Picked files. Use the returned ids with read_picked_file.",
        inputSchema: ["type": "object", "properties": [:]]
    )
    static let readPickedFile = BridgeToolDefinition(
        name: "read_picked_file",
        description: "Read up to max_bytes (default 64000, max 5_000_000) from a previously picked file. Returns text if UTF-8, base64 otherwise.",
        inputSchema: [
            "type": "object",
            "properties": [
                "id": ["type": "string"],
                "max_bytes": ["type": "integer"],
            ],
            "required": ["id"],
        ]
    )
    static let getStepsToday = BridgeToolDefinition(
        name: "get_steps_today",
        description: "Return total step count from midnight in the user's local timezone (HealthKit).",
        inputSchema: ["type": "object", "properties": [:]]
    )
    static let getActiveEnergyToday = BridgeToolDefinition(
        name: "get_active_energy_today",
        description: "Return total active kilocalories burned from midnight (HealthKit).",
        inputSchema: ["type": "object", "properties": [:]]
    )
    static let getHeartRateRecent = BridgeToolDefinition(
        name: "get_heart_rate_recent",
        description: "Return min, max, and average heart rate over the last N minutes (default 30, HealthKit).",
        inputSchema: ["type": "object", "properties": ["minutes": ["type": "integer"]]]
    )
    static let getSleepLastNight = BridgeToolDefinition(
        name: "get_sleep_last_night",
        description: "Return total sleep duration last night (6pm yesterday → noon today window, HealthKit).",
        inputSchema: ["type": "object", "properties": [:]]
    )
}
