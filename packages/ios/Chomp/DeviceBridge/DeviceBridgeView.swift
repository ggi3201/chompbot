import SwiftUI

struct DeviceBridgeView: View {
    @EnvironmentObject private var bridge: DeviceBridgeClient
    @EnvironmentObject private var config: AppConfig

    var body: some View {
        NavigationStack {
            ThemedList {
                Section {
                    ConnectionStatusRow(title: "Phone tools", status: bridge.connection)
                    LabeledContent("Device ID", value: config.deviceId)
                    LabeledContent("Device name", value: config.deviceName)
                    ReconnectButton {
                        bridge.disconnect()
                        await bridge.connectIfConfigured()
                    }
                } header: {
                    Text("Status")
                } footer: {
                    Text("This lets agents use this phone, like its calendar and contacts. It reconnects by itself. Use Reconnect if an agent cannot reach this phone.")
                }
                Section("Tools advertised") {
                    ForEach(bridge.availableToolNames, id: \.self) { name in
                        Label(name, systemImage: "wrench.adjustable")
                            .font(.callout.monospaced())
                            .labelStyle(MutedIconLabelStyle())
                    }
                }
                Section("Recent events") {
                    if bridge.lastEventLog.isEmpty {
                        Text("No events yet.")
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                    } else {
                        ForEach(bridge.lastEventLog.reversed(), id: \.self) { line in
                            Text(line)
                                .font(.caption.monospaced())
                        }
                    }
                }
            }
            .navigationTitle("Device bridge")
        }
    }
}
