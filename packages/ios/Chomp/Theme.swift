import SwiftUI
import ThinkingOrbsKit

/// The Graphite theme. These are the values of `packages/web/src/styles/global.css`.
/// Ember is only for the primary action, selection and the live state.
enum Theme {
    static let surface = Color(hex: 0x141415)
    static let deep = Color(hex: 0x0F0F10)
    static let card = Color(hex: 0x19191B)
    static let raised = Color(hex: 0x232325)

    static let textPrimary = Color(hex: 0xEDEDED)
    static let textSecondary = Color(hex: 0xA1A1A6)
    static let textMuted = Color(hex: 0x85858B)
    static let hairline = textPrimary.opacity(0.08)

    static let accent = Color(hex: 0xF2A33A)
    static let accentInk = Color(hex: 0xF5B55E)
    static let onAccent = Color(hex: 0x1A1206)
    static let error = Color(hex: 0xE5484D)
    static let success = Color(hex: 0x4CC38A)

    /// The hues canvas blocks may name, toned down to sit inside the ramp. As in `canvas/colors.ts`.
    private static let hues: [String: Color] = [
        "amber": accent,
        "emerald": success,
        "cyan": Color(hex: 0x6CB6C8),
        "pink": Color(hex: 0xD68BA8),
        "blue": Color(hex: 0x7AA5E0),
        "violet": textSecondary,
        "purple": textSecondary,
    ]

    private static let series = [
        accent, textMuted, Color(hex: 0x5C5C62), Color(hex: 0x6CB6C8), Color(hex: 0x7AA5E0), Color(hex: 0xD68BA8), success,
    ]

    static func hue(_ name: String?, fallback: Color = accent) -> Color {
        name.flatMap { hues[$0] } ?? fallback
    }

    /// The leading series takes the accent, the next two are greys, then the toned hues.
    static func seriesColor(_ index: Int) -> Color {
        series[index % series.count]
    }
}

/// The one signature detail: anything running right now.
struct LiveDot: View {
    var body: some View {
        Circle()
            .fill(Theme.accent)
            .frame(width: 8, height: 8)
    }
}

/// An agent at work. The ink is pinned to light because the app is always dark.
struct AgentOrb: View {
    let state: OrbState
    /// Points on screen. 20 and 64 are the sizes the orbs are tuned for.
    var size: Double = 20

    var body: some View {
        ThinkingOrb(state: state, size: size > 20 ? .px64 : .px20, theme: .dark, displaySize: size)
            .frame(width: size, height: size)
    }
}

/// A card surface with a hairline.
struct ThemedCard<Content: View>: View {
    var emphasized = false
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(emphasized ? Theme.accent.opacity(0.4) : Theme.hairline)
            }
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double(hex >> 16 & 0xFF) / 255,
            green: Double(hex >> 8 & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

/// A grouped list on the graphite surfaces. Used for every list and form in the app.
struct ThemedList<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        List {
            content
                .listRowBackground(Theme.card)
                .listRowSeparatorTint(Theme.hairline)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.surface)
    }
}

/// Keeps icons quiet, so a list of them does not read as a row of accents.
struct MutedIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        Label {
            configuration.title.foregroundStyle(Theme.textPrimary)
        } icon: {
            configuration.icon.foregroundStyle(Theme.textMuted)
        }
    }
}
