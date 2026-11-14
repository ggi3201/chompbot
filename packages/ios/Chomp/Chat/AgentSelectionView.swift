import SwiftUI

/// The composer's choice of who answers and how: model, reasoning, speed, access and agent.
/// What changes most comes first, after the project, which a new chat picks once.
/// The same options as the web chat's project menu, soul menu and model picker.
struct AgentSelectionView: View {
    @EnvironmentObject private var store: ChatStore
    @Environment(\.dismiss) private var dismiss

    let selection: AgentSelection
    /// True until the chat's first message: the server fixes the project from then on.
    var picksProject = false
    let onChange: (AgentSelection) -> Void

    @State private var browsing: String?
    @State private var query = ""
    @State private var showMore = false

    private var browsed: AgentProviderModels? {
        let id = browsing ?? selection.provider
        return store.agentProviders.first { $0.provider == id } ?? store.agentProviders.first
    }

    private var selectedModel: AgentModelOption? {
        store.agentProviders.first { $0.provider == selection.provider }?.models.first { $0.id == selection.model }
    }

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var listedModels: [AgentModelOption] {
        (browsed?.models ?? []).filter { model in
            guard isSearching else { return model.featured || showMore }
            return [model.label, model.id, model.description ?? ""].contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    var body: some View {
        NavigationStack {
            ThemedList {
                if picksProject && !store.projects.isEmpty {
                    Section {
                        NavigationLink {
                            ProjectPickerView()
                        } label: {
                            LabeledContent("Project", value: store.newChatProjectName ?? "None")
                        }
                        if store.newChatProject != nil {
                            Toggle("Own worktree", isOn: $store.newChatWorktree)
                        }
                    } footer: {
                        if store.newChatProject != nil {
                            Text(store.newChatWorktree ? "The main checkout stays untouched." : "Works in the main checkout.")
                        }
                    }
                }

                Section("Model") {
                    Picker("Provider", selection: Binding(
                        get: { browsed?.provider ?? selection.provider },
                        set: { browsing = $0; showMore = false }
                    )) {
                        ForEach(store.agentProviders) { provider in
                            Text(provider.label).tag(provider.provider)
                        }
                    }
                    .pickerStyle(.segmented)

                    if let browsed, !browsed.available {
                        Text("\(browsed.label) is not available" + (browsed.reason.map { ": \($0)" } ?? ""))
                            .font(.footnote)
                            .foregroundStyle(Theme.textMuted)
                    } else if let browsed {
                        ForEach(listedModels) { model in
                            row(
                                title: model.label,
                                detail: model.description,
                                isSelected: browsed.provider == selection.provider && model.id == selection.model
                            ) {
                                onChange(selection.picking(model, of: browsed))
                            }
                        }
                        if listedModels.isEmpty {
                            Text("No models match").font(.footnote).foregroundStyle(Theme.textMuted)
                        }
                        let hidden = browsed.models.filter { !$0.featured }.count
                        if !isSearching && hidden > 0 {
                            Button(showMore ? "Show fewer" : "Show more (\(hidden))") {
                                showMore.toggle()
                            }
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                        }
                    }
                }

                if let selectedModel, !selectedModel.efforts.isEmpty {
                    Section("Reasoning") {
                        ForEach(selectedModel.efforts, id: \.self) { effort in
                            row(
                                title: AgentSelection.effortLabel(effort),
                                detail: effort == selectedModel.defaultEffort ? "Default" : nil,
                                isSelected: effort == (selection.effort ?? selectedModel.defaultEffort)
                            ) {
                                change { $0.effort = effort }
                            }
                        }
                    }
                }

                Section {
                    Picker("Speed", selection: Binding(
                        get: { selection.fast },
                        set: { value in change { $0.fast = value } }
                    )) {
                        Text("Standard").tag(false)
                        Text("Fast").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .disabled(selectedModel?.supportsFast != true)
                } header: {
                    Text("Speed")
                }

                Section {
                    Picker("Access", selection: Binding(
                        get: { selection.access },
                        set: { value in change { $0.access = value } }
                    )) {
                        ForEach(AccessMode.all, id: \.id) { mode in
                            Text(mode.label).tag(mode.id)
                        }
                    }
                } footer: {
                    Text("Supervised and Auto-accept edits stop to ask you in the chat. Plan only reads, and ends with a plan.")
                }

                if !store.souls.isEmpty {
                    Section("Agent") {
                        row(
                            title: "Default",
                            detail: store.souls.first(where: \.isDefault)?.name,
                            isSelected: !store.souls.contains { $0.id == selection.soulId }
                        ) {
                            change { $0.soulId = nil }
                        }
                        ForEach(store.souls) { soul in
                            row(title: soul.name, detail: soul.description, isSelected: soul.id == selection.soulId) {
                                change { $0.soulId = soul.id }
                            }
                        }
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search \(browsed?.label ?? "") models")
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func change(_ update: (inout AgentSelection) -> Void) {
        var next = selection
        update(&next)
        onChange(next)
    }
}

/// The repos on the host, or none for a plain chat.
private struct ProjectPickerView: View {
    @EnvironmentObject private var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var listed: [ChompAPI.Project] {
        isSearching ? store.projects.filter { $0.name.localizedCaseInsensitiveContains(query) } : store.projects
    }

    var body: some View {
        ThemedList {
            // "None" is a choice, not a repo: it only shows while nothing is typed.
            if !isSearching {
                row(title: "None", detail: "Plain chat", isSelected: store.newChatProject == nil) { pick(nil) }
            }
            ForEach(listed) { project in
                row(title: project.name, detail: nil, isSelected: project.path == store.newChatProject) { pick(project.path) }
            }
            if listed.isEmpty {
                Text("No project matches").font(.footnote).foregroundStyle(Theme.textMuted)
            }
        }
        .searchable(text: $query, prompt: "Search projects")
        .navigationTitle("Project")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func pick(_ path: String?) {
        store.newChatProject = path
        dismiss()
    }
}

private func row(title: String, detail: String?, isSelected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Theme.textPrimary)
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                }
            }
            Spacer()
            if isSelected {
                Image(systemName: "checkmark").foregroundStyle(Theme.accentInk)
            }
        }
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
}
