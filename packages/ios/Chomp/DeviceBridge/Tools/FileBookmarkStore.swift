import Foundation
import SwiftUI
import UniformTypeIdentifiers

/// Persistent registry of security-scoped bookmarks the user has granted Chomp
/// access to via `pick_file`. Stored as base64 strings in UserDefaults under
/// short IDs the agent can refer to later.
@MainActor
final class FileBookmarkStore: ObservableObject {
    @Published private(set) var bookmarks: [BookmarkEntry] = []

    struct BookmarkEntry: Identifiable, Codable {
        let id: String
        let name: String
        let addedAt: Date
        let bookmarkData: Data
    }

    private let store: UserDefaults
    private let key = "fileBookmarks.v1"

    init(store: UserDefaults = .standard) {
        self.store = store
        load()
    }

    private func load() {
        guard let data = store.data(forKey: key) else { return }
        if let decoded = try? JSONDecoder().decode([BookmarkEntry].self, from: data) {
            bookmarks = decoded
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(bookmarks) {
            store.set(data, forKey: key)
        }
    }

    func add(url: URL) throws -> BookmarkEntry {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try url.bookmarkData(
            options: .minimalBookmark,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        let entry = BookmarkEntry(
            id: String(UUID().uuidString.prefix(8)).lowercased(),
            name: url.lastPathComponent,
            addedAt: Date(),
            bookmarkData: data
        )
        bookmarks.append(entry)
        save()
        return entry
    }

    func remove(id: String) {
        bookmarks.removeAll { $0.id == id }
        save()
    }

    func list() -> [[String: Any]] {
        bookmarks.map { b in
            [
                "id": b.id,
                "name": b.name,
                "addedAt": ISO8601DateFormatter().string(from: b.addedAt),
            ]
        }
    }

    enum BookmarkError: LocalizedError {
        case notFound
        case stale
        case readFailed(String)
        var errorDescription: String? {
            switch self {
            case .notFound: return "No bookmark with that id"
            case .stale: return "Bookmark is stale; ask the user to re-pick the file"
            case .readFailed(let s): return s
            }
        }
    }

    /// Returns the file contents (up to maxBytes) along with metadata.
    func read(id: String, maxBytes: Int) throws -> [String: Any] {
        guard let entry = bookmarks.first(where: { $0.id == id }) else {
            throw BookmarkError.notFound
        }
        var stale = false
        let url: URL
        do {
            url = try URL(
                resolvingBookmarkData: entry.bookmarkData,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )
        } catch {
            throw BookmarkError.readFailed(error.localizedDescription)
        }
        if stale { throw BookmarkError.stale }
        let didAccess = url.startAccessingSecurityScopedResource()
        defer { if didAccess { url.stopAccessingSecurityScopedResource() } }

        let cap = max(1, min(maxBytes, 5_000_000))
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: cap) ?? Data()
        let text = String(data: data, encoding: .utf8)
        return [
            "id": entry.id,
            "name": entry.name,
            "bytes": data.count,
            "truncated": data.count == cap,
            "text": text as Any,
            "base64": text == nil ? data.base64EncodedString() : NSNull(),
        ]
    }
}
