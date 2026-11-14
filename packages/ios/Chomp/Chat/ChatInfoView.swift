import SwiftUI

/// What a chat is made of beyond its messages, as web chat's info panel: its project's git state, where its
/// agents run and how to resume their sessions, how full the context is, the files they changed, and the
/// chats it was forked or handed off from or to.
struct ChatInfoView: View {
    let conversationId: String
    @EnvironmentObject private var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    @State private var info: ChompAPI.ConversationInfo?
    @State private var problem: String?

    private var files: [ChangedFile] {
        ChangedFile.from(store.itemsByConversation[conversationId] ?? [])
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let problem {
                        Text(problem).font(.footnote).foregroundStyle(Theme.error)
                    }
                    if let project = info?.project {
                        section("Project") {
                            row("folder") {
                                Text(project.name).font(.footnote).foregroundStyle(Theme.textSecondary)
                                mono(project.path)
                            }
                            if let git = project.git {
                                gitState(git)
                            } else {
                                Text("Git did not answer for this directory.").font(.caption).foregroundStyle(Theme.textMuted)
                            }
                        }
                    }
                    section("Sessions") {
                        if let info {
                            row("laptopcomputer") {
                                Text(info.host).font(.footnote).foregroundStyle(Theme.textSecondary)
                            }
                            ForEach(info.sessions) { session in
                                HStack(alignment: .top, spacing: 8) {
                                    ProviderMark(provider: session.provider).padding(.top, 2)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(modelLabel(session)).font(.footnote).foregroundStyle(Theme.textSecondary)
                                        if let cwd = session.cwd { mono(cwd) }
                                    }
                                    Spacer()
                                    Button {
                                        UIPasteboard.general.string = session.resume
                                    } label: {
                                        Image(systemName: "doc.on.doc").font(.caption).frame(width: 32, height: 32)
                                    }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(Theme.textMuted)
                                    .accessibilityLabel("Copy the command that resumes the \(session.provider) session")
                                }
                            }
                            if info.sessions.isEmpty {
                                Text("No agent session yet.").font(.caption).foregroundStyle(Theme.textMuted)
                            }
                        } else if problem == nil {
                            ProgressView().controlSize(.small)
                        }
                    }
                    section("Context") {
                        if let usage = store.contextUsage {
                            ContextDetails(usage: usage)
                        } else {
                            Text("Shows after the next agent turn.").font(.caption).foregroundStyle(Theme.textMuted)
                        }
                    }
                    section("Files changed") {
                        if files.isEmpty {
                            Text("No files changed in this chat.").font(.caption).foregroundStyle(Theme.textMuted)
                        }
                        ForEach(files) { file in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(file.name).font(.footnote).foregroundStyle(Theme.textSecondary).lineLimit(1)
                                    if !file.dir.isEmpty { mono(file.dir) }
                                }
                                Spacer()
                                diffStat(file.additions, file.deletions)
                            }
                        }
                    }
                    if let info, info.parent != nil || !info.children.isEmpty {
                        section("Lineage") {
                            if let parent = info.parent {
                                link(parent, prefix: parent.kind == "handoff" ? "Handed off from" : "Forked from")
                            }
                            ForEach(info.children) { child in
                                link(child, prefix: child.kind == "handoff" ? "Handed off to" : "Fork")
                            }
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.surface)
            .navigationTitle("Chat info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            do {
                info = try await ChompAPI(config: AppConfig.shared).info(conversationId: conversationId)
            } catch {
                problem = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    private func modelLabel(_ session: ChompAPI.ConversationInfo.Session) -> String {
        let models = store.agentProviders.first { $0.provider == session.provider }?.models
        return session.model.map { model in models?.first { $0.id == model }?.label ?? model } ?? (session.provider == "codex" ? "Codex" : "Claude")
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.caption).foregroundStyle(Theme.textMuted)
            content()
        }
    }

    private func row<Content: View>(_ icon: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).font(.caption).foregroundStyle(Theme.textMuted).frame(width: 14).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) { content() }
        }
    }

    private func mono(_ text: String) -> some View {
        Text(text).font(.caption.monospaced()).foregroundStyle(Theme.textMuted).lineLimit(1).truncationMode(.head)
    }

    private func gitState(_ git: ChompAPI.ConversationInfo.Git) -> some View {
        let sync = [git.ahead > 0 ? "↑\(git.ahead)" : nil, git.behind > 0 ? "↓\(git.behind)" : nil].compactMap { $0 }.joined(separator: " ")
        return VStack(alignment: .leading, spacing: 10) {
            row("arrow.triangle.branch") {
                HStack {
                    Text(git.branch ?? "Detached HEAD").font(.footnote).foregroundStyle(Theme.textSecondary).lineLimit(1)
                    Spacer()
                    if !sync.isEmpty { Text(sync).font(.caption.monospaced()).foregroundStyle(Theme.textSecondary) }
                }
                mono(git.upstream ?? "No upstream")
            }
            row("doc.badge.plus") {
                HStack {
                    Text(git.files == 0 ? "No uncommitted changes" : "\(git.files) \(git.files == 1 ? "file" : "files") uncommitted")
                        .font(.footnote).foregroundStyle(Theme.textSecondary)
                    Spacer()
                    if git.files > 0 { diffStat(git.insertions, git.deletions) }
                }
            }
        }
    }

    private func diffStat(_ additions: Int, _ deletions: Int) -> some View {
        HStack(spacing: 6) {
            Text("+\(additions)").foregroundStyle(Theme.success)
            Text("−\(deletions)").foregroundStyle(Theme.error)
        }
        .font(.caption.monospaced())
    }

    private func link(_ link: ChompAPI.ConversationInfo.Link, prefix: String) -> some View {
        Button {
            store.selectConversation(link.id)
            dismiss()
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(prefix).font(.caption).foregroundStyle(Theme.textMuted)
                Text(link.title ?? "Untitled").font(.footnote).foregroundStyle(Theme.accentInk).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A file the chat's agents changed, with its lines summed over every change. As web's `changedFiles`.
struct ChangedFile: Identifiable, Equatable {
    let path: String
    var additions: Int
    var deletions: Int
    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }
    var dir: String { (path as NSString).deletingLastPathComponent }

    static func from(_ items: [ChatItem]) -> [ChangedFile] {
        var byPath: [String: ChangedFile] = [:]
        var order: [String] = []
        for item in items {
            guard case .fileChange(let files, let status) = item.body, status != .declined, status != .failed else { continue }
            for file in files {
                if byPath[file.path] == nil {
                    order.append(file.path)
                    byPath[file.path] = ChangedFile(path: file.path, additions: 0, deletions: 0)
                }
                byPath[file.path]!.additions += file.additions
                byPath[file.path]!.deletions += file.deletions
            }
        }
        return order.compactMap { byPath[$0] }
    }
}
