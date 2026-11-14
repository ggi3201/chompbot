import SwiftUI
import UniformTypeIdentifiers

/// Settings sub-screen letting the user pick + persist files Chomp can later read.
struct FilePickerView: View {
    @EnvironmentObject private var bookmarks: FileBookmarkStore
    @State private var showPicker = false
    @State private var error: String?

    var body: some View {
        ThemedList {
            Section {
                Button {
                    showPicker = true
                } label: {
                    Label("Pick a file…", systemImage: "doc.badge.plus")
                }
            } footer: {
                Text("Files you pick here become readable by Chomp's agent via the `read_picked_file` tool. iOS keeps the access scoped to these exact files — nothing else.")
            }
            if let error {
                Section { Text(error).foregroundStyle(Theme.error) }
            }
            Section("Picked files") {
                if bookmarks.bookmarks.isEmpty {
                    Text("No files picked yet.").font(.footnote).foregroundStyle(Theme.textSecondary)
                }
                ForEach(bookmarks.bookmarks) { b in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(b.name).font(.body)
                        Text("id: \(b.id) · added \(b.addedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption2)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            bookmarks.remove(id: b.id)
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("Picked files")
        .fileImporter(isPresented: $showPicker, allowedContentTypes: [.item]) { result in
            switch result {
            case .success(let url):
                do {
                    _ = try bookmarks.add(url: url)
                    error = nil
                } catch {
                    self.error = error.localizedDescription
                }
            case .failure(let err):
                self.error = err.localizedDescription
            }
        }
    }
}
