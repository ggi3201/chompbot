import SwiftUI

/// A row that opens and closes. `defaultOpen` holds until the user toggles it, so a live block closes itself when the turn ends.
private struct Disclosure<Summary: View, Details: View>: View {
    let defaultOpen: Bool
    @ViewBuilder let summary: Summary
    @ViewBuilder let details: Details
    @State private var toggled: Bool?

    private var isOpen: Bool { toggled ?? defaultOpen }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                toggled = !isOpen
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                    summary
                    Spacer(minLength: 0)
                }
                .font(.footnote)
                .foregroundStyle(Theme.textMuted)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isOpen {
                details
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) {
                        Theme.hairline.frame(width: 1)
                    }
                    .padding(.leading, 4)
            }
        }
    }
}

private struct MonoBlock: View {
    let text: String
    var label: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let label {
                Text(label).font(.caption.monospaced()).foregroundStyle(Theme.textMuted)
            }
            ScrollView {
                Text(text)
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.textSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxHeight: 240)
            .fixedSize(horizontal: false, vertical: true)
            .background(Theme.deep)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Theme.hairline)
            }
        }
    }
}

/// Any non-work item, by kind.
struct AgentItemView: View {
    let item: ChatItem
    /// Only the newest plan can still be implemented, and only between turns.
    let canImplementPlan: Bool

    var body: some View {
        switch item.body {
        case .assistantText(let text, let streaming):
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || streaming {
                MessageContent(text: text, isStreaming: streaming)
            }
        case .reasoning(let text, let streaming):
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || streaming {
                Disclosure(defaultOpen: streaming) {
                    Text("Thinking")
                    if streaming { LiveDot() }
                } details: {
                    Text(text)
                        .font(.footnote)
                        .foregroundStyle(Theme.textMuted)
                        .textSelection(.enabled)
                }
            }
        case .todoList(let todos):
            TodoCard(todos: todos)
        case .proposedPlan(let markdown):
            PlanCard(markdown: markdown, canImplement: canImplementPlan)
        case .approval(let requestId, let title, let detail, let state, let oneTime):
            ApprovalCard(requestId: requestId, title: title, detail: detail, state: state, oneTime: oneTime)
        case .error(let message):
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.circle")
                Text(message)
            }
            .font(.footnote)
            .foregroundStyle(Theme.error)
        case .toolCall, .command, .fileChange, .other:
            EmptyView()
        }
    }
}

/// Consecutive tool calls, commands and edits of one turn. Open while the turn runs, one summary line after.
struct WorkGroupView: View {
    let items: [ChatItem]
    let live: Bool

    var body: some View {
        Disclosure(defaultOpen: live) {
            Text(ChatTimeline.summary(of: items)).lineLimit(1)
            if live { LiveDot() }
        } details: {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(items) { item in
                    WorkRow(item: item)
                }
            }
        }
    }
}

private struct WorkRow: View {
    let item: ChatItem
    @State private var isOpen = false

    private var icon: String {
        switch item.body {
        case .command: return "terminal"
        case .fileChange: return "square.and.pencil"
        case .toolCall(let tool, _, _, _, _):
            let name = tool.lowercased()
            if name == "read" { return "doc.text" }
            if name == "grep" || name == "glob" || name.contains("search") { return "magnifyingglass" }
            if name.contains("fetch") || name.contains("web") { return "globe" }
            if name == "task" || name == "agent" { return "person.crop.square" }
            return "wrench.adjustable"
        default: return "wrench.adjustable"
        }
    }

    private var hasDetails: Bool {
        switch item.body {
        case .toolCall(_, _, let input, let output, _): return input?.isEmpty == false || output?.isEmpty == false
        case .command: return true
        case .fileChange(let files, _): return !files.isEmpty
        default: return false
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                isOpen.toggle()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: icon)
                        .font(.footnote)
                        .foregroundStyle(Theme.textMuted)
                        .frame(width: 16)
                    title
                    Spacer(minLength: 0)
                    statusMark
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // Not `.disabled`, which would dim the row and its status.
            .allowsHitTesting(hasDetails)
            if isOpen && hasDetails {
                details.padding(.leading, 24)
            }
        }
    }

    @ViewBuilder
    private var title: some View {
        switch item.body {
        case .toolCall(let tool, let title, _, _, _):
            Text(title.isEmpty ? tool : title)
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
        case .command(let command, _, _, _, _):
            Text(command)
                .font(.caption.monospaced())
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
        case .fileChange(let files, _):
            HStack(spacing: 8) {
                Text(files.first.map { $0.path + (files.count > 1 ? " and \(files.count - 1) more" : "") } ?? "Files")
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                DiffStat(additions: files.map(\.additions).reduce(0, +), deletions: files.map(\.deletions).reduce(0, +))
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var statusMark: some View {
        switch item.status {
        case .running: LiveDot()
        case .failed: Text("Failed").font(.caption.monospaced()).foregroundStyle(Theme.error)
        case .declined: Text("Declined").font(.caption.monospaced()).foregroundStyle(Theme.textMuted)
        default: EmptyView()
        }
    }

    @ViewBuilder
    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch item.body {
            case .toolCall(_, _, let input, let output, _):
                if let input, !input.isEmpty { MonoBlock(text: input, label: "Input") }
                if let output, !output.isEmpty { MonoBlock(text: output, label: "Output") }
            case .command(_, let cwd, let output, let exitCode, _):
                if let cwd {
                    Text(cwd).font(.caption.monospaced()).foregroundStyle(Theme.textMuted).lineLimit(1)
                }
                if !output.isEmpty { MonoBlock(text: output) }
                if let exitCode {
                    Text("Exit code \(exitCode)")
                        .font(.caption.monospaced())
                        .foregroundStyle(exitCode == 0 ? Theme.textMuted : Theme.error)
                }
            case .fileChange(let files, _):
                ForEach(files, id: \.path) { file in
                    DiffBlock(file: file)
                }
            default:
                EmptyView()
            }
        }
    }
}

private struct DiffStat: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 4) {
            Text("+\(additions)").foregroundStyle(Theme.success)
            Text("-\(deletions)").foregroundStyle(Theme.error)
        }
        .font(.caption.monospaced())
    }
}

private struct DiffBlock: View {
    let file: ChatItem.FileDiff

    private func color(_ line: Substring) -> Color {
        if line.hasPrefix("+") { return Theme.success }
        if line.hasPrefix("-") { return Theme.error }
        return Theme.textSecondary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(file.path).font(.caption.monospaced()).foregroundStyle(Theme.textMuted).lineLimit(1)
            ScrollView([.horizontal, .vertical]) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(file.diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                        Text(String(line).isEmpty ? " " : String(line))
                            .font(.caption.monospaced())
                            .foregroundStyle(color(line))
                    }
                }
                .padding(8)
            }
            .frame(maxHeight: 240)
            .fixedSize(horizontal: false, vertical: true)
            .background(Theme.deep)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }
}

/// The task list pinned above the composer: one line with the task in hand, tap for all of it.
struct PinnedTodos: View {
    let todos: [ChatItem.Todo]
    @State private var open = false

    private var current: ChatItem.Todo? {
        todos.first { $0.status == "in_progress" } ?? todos.first { $0.status == "pending" } ?? todos.last
    }

    var body: some View {
        Button {
            withAnimation(.snappy) { open.toggle() }
        } label: {
            if open {
                TodoCard(todos: todos)
                    .overlay(alignment: .topTrailing) {
                        Image(systemName: "chevron.down").font(.caption2).foregroundStyle(Theme.textMuted).padding(12)
                    }
            } else {
                ThemedCard {
                    HStack(spacing: 8) {
                        if current?.status == "in_progress" {
                            LiveDot().frame(width: 16)
                        } else {
                            Image(systemName: current?.status == "completed" ? "checkmark.circle" : "circle")
                                .foregroundStyle(Theme.textMuted).frame(width: 16)
                        }
                        Text(current?.text ?? "").lineLimit(1).foregroundStyle(Theme.textPrimary)
                        Spacer(minLength: 4)
                        Text("\(todos.filter { $0.status == "completed" }.count)/\(todos.count)")
                            .font(.caption.monospaced()).foregroundStyle(Theme.textMuted)
                        Image(systemName: "chevron.up").font(.caption2).foregroundStyle(Theme.textMuted)
                    }
                    .font(.footnote)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(open ? "Task list. Tap to show only the current task" : "Current task: \(current?.text ?? ""). Tap to show all")
    }
}

private struct TodoCard: View {
    let todos: [ChatItem.Todo]

    var body: some View {
        ThemedCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Plan").font(.footnote).foregroundStyle(Theme.textPrimary)
                    Spacer()
                    Text("\(todos.filter { $0.status == "completed" }.count) of \(todos.count) done")
                        .font(.caption.monospaced())
                        .foregroundStyle(Theme.textMuted)
                }
                ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        switch todo.status {
                        case "in_progress": LiveDot().frame(width: 16)
                        case "completed": Image(systemName: "checkmark.circle").foregroundStyle(Theme.textMuted).frame(width: 16)
                        default: Image(systemName: "circle").foregroundStyle(Theme.textMuted).frame(width: 16)
                        }
                        Text(todo.text)
                            .strikethrough(todo.status == "completed")
                            .foregroundStyle(todo.status == "completed" ? Theme.textMuted : Theme.textSecondary)
                    }
                    .font(.footnote)
                }
            }
        }
    }
}

private struct ApprovalCard: View {
    @EnvironmentObject private var store: ChatStore
    let requestId: String
    let title: String
    let detail: String
    let state: String
    let oneTime: Bool

    private var decisionLabel: String {
        switch state {
        case "accept": return "Approved"
        case "accept-session": return "Approved for this session"
        case "decline": return "Declined"
        default: return "Expired"
        }
    }

    var body: some View {
        ThemedCard(emphasized: state == "pending") {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.shield").foregroundStyle(Theme.textMuted)
                    Text(title).foregroundStyle(Theme.textPrimary)
                }
                .font(.footnote)
                if !detail.isEmpty { MonoBlock(text: detail) }
                if state == "pending" {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { buttons }
                        VStack(alignment: .leading, spacing: 8) { buttons }
                    }
                } else {
                    Text(decisionLabel).font(.caption.monospaced()).foregroundStyle(Theme.textMuted)
                }
            }
        }
    }

    @ViewBuilder
    private var buttons: some View {
        SmallButton(label: "Approve", isPrimary: true) { store.answerApproval(requestId: requestId, decision: "accept") }
        if !oneTime {
            SmallButton(label: "Approve for session") { store.answerApproval(requestId: requestId, decision: "accept-session") }
        }
        SmallButton(label: "Decline") { store.answerApproval(requestId: requestId, decision: "decline") }
    }
}

/// The plan a plan-mode turn ended with. Implementing it is a new message in a mode that allows changes.
private struct PlanCard: View {
    @EnvironmentObject private var store: ChatStore
    let markdown: String
    let canImplement: Bool

    var body: some View {
        ThemedCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Proposed plan", systemImage: "checklist")
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
                ChatMarkdown(text: markdown)
                if canImplement {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { buttons }
                        VStack(alignment: .leading, spacing: 8) { buttons }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var buttons: some View {
        SmallButton(label: "Implement", isPrimary: true) { store.send("Implement the plan.", access: "auto-edits") }
        SmallButton(label: "Implement with full access") { store.send("Implement the plan.", access: "full") }
    }
}

private struct SmallButton: View {
    let label: String
    var isPrimary = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.footnote.weight(.medium))
                .lineLimit(1)
                .foregroundStyle(isPrimary ? Theme.onAccent : Theme.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(isPrimary ? Theme.accent : Theme.raised)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
