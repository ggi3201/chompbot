import SwiftUI

/// How a connection to the server is doing, in words a person can read.
enum ConnectionStatus: Equatable {
    case connected(since: Date?)
    case connecting
    case failed(String)
    case off(String)

    var isConnecting: Bool {
        self == .connecting
    }
}

struct ConnectionStatusRow: View {
    let title: String
    let status: ConnectionStatus

    private var detail: String? {
        switch status {
        case .connected(let since):
            return since.map { "Since \($0.formatted(.dateTime.hour().minute().second()))" }
        case .failed(let reason):
            return reason
        default:
            return nil
        }
    }

    private var label: String {
        switch status {
        case .connected: return "Connected"
        case .connecting: return "Connecting"
        case .failed: return "Not connected"
        case .off(let reason): return reason
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).foregroundStyle(Theme.textPrimary)
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                HStack(spacing: 8) {
                    switch status {
                    case .connected: LiveDot()
                    case .connecting: ProgressView().controlSize(.small)
                    case .failed: Circle().fill(Theme.error).frame(width: 8, height: 8)
                    case .off: EmptyView()
                    }
                    Text(label).foregroundStyle(Theme.textSecondary)
                }
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                }
            }
        }
    }
}

/// Stays on "Reconnecting" long enough to read, because a fast reconnect would otherwise show nothing.
struct ReconnectButton: View {
    let action: () async -> Void
    @State private var isReconnecting = false

    var body: some View {
        Button {
            isReconnecting = true
            Task {
                async let minimum: Void? = try? Task.sleep(for: .milliseconds(800))
                await action()
                _ = await minimum
                isReconnecting = false
            }
        } label: {
            HStack(spacing: 8) {
                if isReconnecting { ProgressView().controlSize(.small) }
                Text(isReconnecting ? "Reconnecting" : "Reconnect")
                    .foregroundStyle(isReconnecting ? Theme.textMuted : Theme.accentInk)
            }
        }
        .disabled(isReconnecting)
    }
}

/// What the phone shares with Chomp, and the iOS permission that allows it.
struct LocationAccessSection: View {
    @ObservedObject private var location = LocationReporter.shared

    private var permission: String {
        switch location.authorization {
        case .authorizedAlways: return "Always"
        case .authorizedWhenInUse: return "While using the app"
        case .notDetermined: return "Not asked"
        default: return "Off"
        }
    }

    private var needsAlways: Bool {
        location.mode == .whenIMove && location.authorization != .authorizedAlways
    }

    private var footer: String {
        switch location.mode {
        case .whenIMove:
            return "Your phone tells your Chomp server when you move or arrive somewhere, also with the app closed. It does not track you all the time, and it uses very little battery. iOS calls the permission for this Always. Force-quitting the app may stop it."
        case .whileOpen:
            return "Your phone tells your Chomp server where you are only when you open Chomp. Arrive and leave events from Home Assistant keep working. If iOS still says Always, Chomp does not use it, and you can lower it in iOS Settings."
        case .off:
            return "Chomp does not read or send your position. Positions it already has stay in your history. Arrive and leave events from Home Assistant keep working."
        }
    }

    var body: some View {
        Section {
            Picker("Share location", selection: Binding(get: { location.mode }, set: location.choose)) {
                ForEach(LocationMode.allCases) { Text($0.title).tag($0) }
            }
            .foregroundStyle(Theme.textPrimary)
            HStack(alignment: .firstTextBaseline) {
                Text("iOS permission").foregroundStyle(Theme.textPrimary)
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(permission).foregroundStyle(needsAlways ? Theme.error : Theme.textSecondary)
                    if let sent = location.lastSent {
                        Text("Last sent \(sent.formatted(.dateTime.hour().minute()))")
                            .font(.caption)
                            .foregroundStyle(Theme.textMuted)
                    }
                }
            }
            if needsAlways {
                Text("\"When I move\" needs Always. Choose it in iOS Settings, under Location.")
                    .font(.footnote)
                    .foregroundStyle(Theme.error)
            }
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Link("Change in iOS Settings", destination: url)
                    .foregroundStyle(Theme.accentInk)
            }
        } header: {
            Text("Location")
        } footer: {
            Text(footer)
        }
    }
}
