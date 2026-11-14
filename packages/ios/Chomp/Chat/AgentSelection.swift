import Foundation

/// One selectable model, from `GET /api/chat/agent-models`.
struct AgentModelOption: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let description: String?
    let efforts: [String]
    let defaultEffort: String?
    let supportsFast: Bool
    let featured: Bool
}

struct AgentProviderModels: Decodable, Identifiable, Equatable {
    let provider: String
    let available: Bool
    let reason: String?
    let models: [AgentModelOption]

    var id: String { provider }
    var label: String { provider == "codex" ? "Codex" : "Claude" }
}

enum AccessMode {
    static let all: [(id: String, label: String)] = [
        ("plan", "Plan"),
        ("supervised", "Supervised"),
        ("auto-edits", "Auto-accept edits"),
        ("full", "Full access"),
    ]
}

/// A choice as stored or as the server recorded it. Any part may be missing or out of date.
struct StoredSelection: Codable, Equatable {
    var provider: String?
    var soulId: String?
    var model: String?
    var effort: String?
    var fast: Bool?
    var access: String?
}

/// What runs a turn, sent with every message. The same rules as `lib/agent-selection.ts`.
struct AgentSelection: Equatable {
    var provider: String
    var soulId: String?
    var model: String
    var effort: String?
    var fast: Bool
    var access: String

    /// Makes a stored choice fit what the server offers now: an unknown model falls back to the
    /// provider's first featured one, an effort the model lacks to its default, and fast off where
    /// the model has none. With nothing usable stored, the first available provider wins.
    static func resolve(_ providers: [AgentProviderModels], stored: StoredSelection?) -> AgentSelection? {
        let available = providers.filter { $0.available && !$0.models.isEmpty }
        guard let provider = available.first(where: { $0.provider == stored?.provider }) ?? available.first else { return nil }

        let sameProvider = provider.provider == stored?.provider
        let known = sameProvider ? provider.models.first { $0.id == stored?.model } : nil
        guard let model = known ?? provider.models.first(where: \.featured) ?? provider.models.first else { return nil }

        let keepsEffort = known != nil && stored?.effort.map(model.efforts.contains) == true
        return AgentSelection(
            provider: provider.provider,
            soulId: stored?.soulId,
            model: model.id,
            effort: keepsEffort ? stored?.effort : model.defaultEffort,
            fast: model.supportsFast && stored?.fast == true,
            access: AccessMode.all.contains { $0.id == stored?.access } ? stored!.access! : "full"
        )
    }

    /// The soul and access stay when the model changes, and so does an effort the new model has.
    func picking(_ model: AgentModelOption, of provider: AgentProviderModels) -> AgentSelection {
        var next = self
        next.provider = provider.provider
        next.model = model.id
        next.effort = effort.map(model.efforts.contains) == true ? effort : model.defaultEffort
        next.fast = model.supportsFast && fast
        return next
    }

    var stored: StoredSelection {
        StoredSelection(provider: provider, soulId: soulId, model: model, effort: effort, fast: fast, access: access)
    }

    /// For example "Nova · Opus · High", as web chat's model button. Only a soul picked on purpose
    /// earns room; fast shows as an icon next to it, and access lives in the picker.
    func label(providers: [AgentProviderModels], souls: [ChompAPI.Soul]) -> String {
        let modelLabel = providers.first { $0.provider == provider }?.models.first { $0.id == model }?.label ?? model
        return [
            souls.first { $0.id == soulId && !$0.isDefault }?.name,
            modelLabel,
            effort.map(Self.effortLabel),
        ].compactMap { $0 }.joined(separator: " · ")
    }

    static func effortLabel(_ effort: String) -> String {
        effort == "xhigh" ? "Extra high" : effort.prefix(1).uppercased() + effort.dropFirst()
    }
}

/// One choice per chat, plus the last one used as the seed for new chats.
enum SelectionStorage {
    private static let prefix = "chomp.agent-selection."
    private static let lastUsedKey = prefix + "last"

    private static func read(_ key: String) -> StoredSelection? {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(StoredSelection.self, from: $0) }
    }

    private static func write(_ selection: StoredSelection, key: String) {
        UserDefaults.standard.set(try? JSONEncoder().encode(selection), forKey: key)
    }

    static var lastUsed: StoredSelection? {
        get { read(lastUsedKey) }
        set { if let newValue { write(newValue, key: lastUsedKey) } }
    }

    static func selection(for conversationId: String) -> StoredSelection? {
        read(prefix + conversationId)
    }

    static func setSelection(_ selection: StoredSelection, for conversationId: String) {
        write(selection, key: prefix + conversationId)
    }
}
