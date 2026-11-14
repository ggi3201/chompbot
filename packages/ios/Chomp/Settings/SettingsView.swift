import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var chatStore: ChatStore
    @EnvironmentObject private var bridge: DeviceBridgeClient

    var body: some View {
        NavigationStack {
            ThemedList {
                Section("Server") {
                    TextField("Host", text: $config.serverHost)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Toggle("TLS (wss/https)", isOn: $config.useTLS)
                }
                Section {
                    SecureField("Chat JWT", text: $config.jwt)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Chat auth")
                } footer: {
                    Text("Long-lived JWT signed with the server's JWT_SECRET. Generated once on the Chomp host; paste it here.")
                }
                Section {
                    TextField("Device ID", text: $config.deviceId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Device name", text: $config.deviceName)
                } header: {
                    Text("Device bridge")
                } footer: {
                    Text("These identify this phone in Chomp's phone_list_devices tool. Phone tools sign in with your Chomp login.")
                }
                Section("Native tools") {
                    NavigationLink {
                        PermissionsView()
                    } label: {
                        Label("Permissions", systemImage: "lock.shield")
                            .labelStyle(MutedIconLabelStyle())
                    }
                    NavigationLink {
                        FilePickerView()
                    } label: {
                        Label("Picked files", systemImage: "doc.text")
                            .labelStyle(MutedIconLabelStyle())
                    }
                }
                LocationAccessSection()
                Section {
                    ConnectionStatusRow(title: "Chat", status: chatStore.connection)
                    ConnectionStatusRow(title: "Phone tools", status: bridge.connection)
                    ReconnectButton {
                        await chatStore.reconnect()
                        bridge.disconnect()
                        await bridge.connectIfConfigured()
                    }
                } header: {
                    Text("Connection")
                } footer: {
                    Text("Chat brings your messages and replies. Phone tools let agents use this phone, like its calendar and contacts. Both reconnect by themselves. Use Reconnect if replies stop arriving.")
                }
                Section {
                    Button("Sign out", role: .destructive) {
                        config.jwt = ""
                        Task {
                            await chatStore.reconnect()
                            bridge.disconnect()
                        }
                    }
                    .foregroundStyle(Theme.error)
                }
            }
            .navigationTitle("Settings")
        }
    }
}
