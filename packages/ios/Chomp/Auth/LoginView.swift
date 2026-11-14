import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var chatStore: ChatStore
    @EnvironmentObject private var bridge: DeviceBridgeClient

    @State private var password: String = ""
    @State private var longLived: Bool = true
    @State private var inFlight: Bool = false
    @State private var error: String?
    @FocusState private var passwordFocused: Bool

    var body: some View {
        NavigationStack {
            ThemedList {
                Section("Server") {
                    TextField("Host", text: $config.serverHost)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Toggle("TLS (https/wss)", isOn: $config.useTLS)
                }
                Section("Password") {
                    SecureField("Chomp password", text: $password)
                        .submitLabel(.go)
                        .focused($passwordFocused)
                        .onSubmit(submit)
                    Toggle("Stay logged in for a year", isOn: $longLived)
                }
                if let error {
                    Section { Text(error).foregroundStyle(Theme.error) }
                }
                Section {
                    Button {
                        submit()
                    } label: {
                        HStack {
                            if inFlight { ProgressView().padding(.trailing, 8) }
                            Text("Sign in")
                        }
                    }
                    .disabled(inFlight || password.isEmpty || config.serverHost.isEmpty)
                }
            }
            .navigationTitle("Sign in to Chomp")
            .onAppear { passwordFocused = true }
        }
    }

    private func submit() {
        guard !inFlight else { return }
        inFlight = true
        error = nil
        let client = AuthClient(host: config.serverHost, useTLS: config.useTLS)
        let pw = password
        let longLivedNow = longLived
        Task {
            defer { inFlight = false }
            do {
                let token = try await client.login(password: pw, longLived: longLivedNow)
                await MainActor.run {
                    config.jwt = token
                    password = ""
                }
                await chatStore.connectIfConfigured()
                await bridge.connectIfConfigured()
                // At launch these had no login to use: the push token was not sent and no cards were fetched.
                UIApplication.shared.registerForRemoteNotifications()
                await PhoneCardSync.run()
                await MainActor.run { LocationReporter.shared.start() }
            } catch {
                await MainActor.run { self.error = error.localizedDescription }
            }
        }
    }
}
