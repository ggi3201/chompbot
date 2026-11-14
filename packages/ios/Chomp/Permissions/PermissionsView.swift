import SwiftUI

struct PermissionsView: View {
    @EnvironmentObject private var permissions: PermissionsManager
    @State private var requesting = false

    var body: some View {
        ThemedList {
            Section {
                Button {
                    requesting = true
                    Task {
                        defer { requesting = false }
                        await permissions.requestAll()
                    }
                } label: {
                    HStack {
                        if requesting { ProgressView().padding(.trailing, 8) }
                        Text("Grant all in batch")
                    }
                }
                .disabled(requesting)
            } footer: {
                Text("Pre-asks every permission Chomp's tools may use so prompts don't appear mid-conversation. Each runs through the system dialog one at a time.")
            }

            Section("Current status") {
                row("Location", permissions.status.location, request: permissions.requestLocation)
                row("Calendar", permissions.status.calendar) { await permissions.requestEvents(.event) }
                row("Reminders", permissions.status.reminders) { await permissions.requestEvents(.reminder) }
                row("Contacts", permissions.status.contacts, request: permissions.requestContacts)
                row("Photos", permissions.status.photos, request: permissions.requestPhotos)
                row("Notifications", permissions.status.notifications, request: permissions.requestNotifications)
                row("HealthKit", permissions.status.healthKit, request: permissions.requestHealthKit)
            }

            Section {
                Button("Refresh status") { permissions.refresh() }
                    .foregroundStyle(Theme.textPrimary)
            }
        }
        .navigationTitle("Permissions")
        .onAppear { permissions.refresh() }
    }

    @ViewBuilder
    private func row(_ label: String, _ status: String, request: @escaping () async -> Void) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(status).foregroundStyle(Theme.textSecondary)
            Button {
                Task { await request() }
            } label: {
                Image(systemName: "arrow.up.right.square")
                    .foregroundStyle(Theme.textMuted)
            }
            .buttonStyle(.borderless)
        }
    }
}
