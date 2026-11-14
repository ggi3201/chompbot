import SwiftUI

/// How full the chat's agent session is, as web chat's ContextMeter. Tap for what fills it, the plan's
/// usage windows, and to compact or hand off. A new chat has no context yet, so it shows the plan's tightest window.
struct ContextMeter: View {
    let usage: ChompAPI.ContextUsage?
    let plan: ChompAPI.ProviderUsage?
    var modelLabel: String?
    var onCompact: (() -> Void)?
    var onHandoff: (() -> Void)?
    @State private var isOpen = false

    private var windows: [ChompAPI.ProviderUsage.Window] { plan?.windows ?? [] }

    var body: some View {
        if let percent = usage?.percent ?? windows.map(\.percent).max() {
            Button { isOpen = true } label: {
                HStack(spacing: 6) {
                    ContextRing(percent: percent)
                    Text("\(Int(percent.rounded()))%")
                        .font(.caption.monospaced())
                }
                .foregroundStyle(percent >= 80 ? Theme.accentInk : Theme.textMuted)
                .padding(.horizontal, 4)
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(usage == nil ? "Plan usage, \(Int(percent))%" : "Context \(Int(percent))% full")
            .popover(isPresented: $isOpen) {
                details
                    .presentationCompactAdaptation(.popover)
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let usage {
                Text("Context · \(modelLabel ?? usage.model ?? usage.provider)")
                    .font(.caption)
                    .foregroundStyle(Theme.textMuted)
                ContextDetails(usage: usage)
            }
            if let plan, !windows.isEmpty {
                if usage != nil { Divider().overlay(Theme.hairline) }
                Text("Plan usage · \(plan.plan ?? (plan.provider == "codex" ? "Codex" : "Claude"))")
                    .font(.caption)
                    .foregroundStyle(Theme.textMuted)
                ForEach(windows) { UsageBar(window: $0) }
            }
            if let usage {
                HStack(spacing: 8) {
                    if usage.provider == "claude", let onCompact {
                        actionButton("Compact", action: onCompact)
                    }
                    if let onHandoff {
                        actionButton("Hand off to a new chat", action: onHandoff)
                    }
                }
            }
        }
        .padding(14)
        .frame(width: 320, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(Theme.card)
    }

    private func actionButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button {
            isOpen = false
            action()
        } label: {
            Text(title)
                .font(.footnote)
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.hairline))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A ring that fills with the window, small enough to sit in the composer row.
struct ContextRing: View {
    let percent: Double

    var body: some View {
        ZStack {
            Circle().stroke(lineWidth: 1.5).opacity(0.25)
            Circle()
                .trim(from: 0, to: min(1, percent / 100))
                .stroke(style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 11, height: 11)
        .padding(1.5)
    }
}

/// The window's fill and what fills it. The meter's popover and the info sheet share it.
struct ContextDetails: View {
    let usage: ChompAPI.ContextUsage

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(formatTokens(usage.usedTokens)) of \(formatTokens(usage.maxTokens)) tokens")
                    .font(.footnote)
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                Text("\(Int(usage.percent.rounded()))%")
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.textSecondary)
            }
            UsageTrack(percent: usage.percent)
            if usage.categories.isEmpty {
                Text("Codex reports the total only.")
                    .font(.caption)
                    .foregroundStyle(Theme.textMuted)
            } else {
                ForEach(usage.categories.sorted { $0.tokens > $1.tokens }, id: \.name) { category in
                    HStack(alignment: .firstTextBaseline) {
                        Text(category.name)
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                        Spacer()
                        Text(formatTokens(category.tokens))
                            .font(.caption.monospaced())
                            .foregroundStyle(Theme.textMuted)
                    }
                }
            }
        }
    }
}

struct UsageBar: View {
    let window: ChompAPI.ProviderUsage.Window

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(window.label)
                    .font(.footnote)
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                if let resetsAt = window.resetsAt {
                    Text(resetText(resetsAt))
                        .font(.caption.monospaced())
                        .foregroundStyle(Theme.textMuted)
                }
                Text("\(Int(window.percent.rounded()))%")
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.textSecondary)
                    .frame(minWidth: 36, alignment: .trailing)
            }
            UsageTrack(percent: window.percent)
        }
    }

    private func resetText(_ date: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        return Calendar.current.isDateInToday(date)
            ? "Resets at \(time)"
            : "Resets \(date.formatted(.dateTime.weekday(.abbreviated))) \(time)"
    }
}

/// The bar steps up in color only when it matters: past 80% it is worth a glance.
private struct UsageTrack: View {
    let percent: Double

    private var fill: Color {
        if percent >= 90 { return Theme.error }
        if percent >= 80 { return Theme.accent }
        return Theme.textSecondary
    }

    var body: some View {
        GeometryReader { track in
            Capsule().fill(Theme.raised)
                .overlay(alignment: .leading) {
                    Capsule().fill(fill).frame(width: track.size.width * min(1, percent / 100))
                }
        }
        .frame(height: 4)
    }
}

func formatTokens(_ tokens: Int) -> String {
    if tokens >= 1_000_000 {
        return tokens % 1_000_000 == 0 ? "\(tokens / 1_000_000)M" : String(format: "%.1fM", Double(tokens) / 1_000_000)
    }
    if tokens >= 1000 {
        return tokens >= 100_000 ? "\(Int((Double(tokens) / 1000).rounded()))k" : String(format: "%.1fk", Double(tokens) / 1000)
    }
    return "\(tokens)"
}
