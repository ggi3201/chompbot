import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// A file sent with a message, after `POST /api/uploads`.
struct ChatAttachment: Codable, Equatable {
    let url: String
    let name: String
    let mimeType: String

    /// The saved form of a user message: its text, then its files as markdown. As `buildContentWithAttachments` on the server.
    static func content(text: String, attachments: [ChatAttachment]) -> String {
        guard !attachments.isEmpty else { return text }
        let trailer = attachments.map { attachment in
            let label = attachment.name.replacingOccurrences(of: "[\\[\\]\\n]", with: " ", options: .regularExpression)
            return "\(attachment.mimeType.hasPrefix("image/") ? "!" : "")[\(label)](\(attachment.url))"
        }.joined(separator: "\n")
        return text.isEmpty ? trailer : "\(text)\n\n\(trailer)"
    }
}

/// A user message split into its text and its images, so the bubble can show them.
struct UserMessageParts: Equatable {
    let text: String
    let imageURLs: [String]

    private static let image = try! NSRegularExpression(pattern: "!\\[[^\\]]*\\]\\(([^)\\s]+)\\)")

    init(content: String) {
        let source = content as NSString
        let matches = Self.image.matches(in: content, range: NSRange(location: 0, length: source.length))
        imageURLs = matches.map { source.substring(with: $0.range(at: 1)) }
        text = Self.image
            .stringByReplacingMatches(in: content, range: NSRange(location: 0, length: source.length), withTemplate: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum ImagePreparation {
    /// Full-size phone photos are far larger than a model can use, and HEIC does not open everywhere.
    static let maxDimension: CGFloat = 2048

    static func jpeg(from data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let scale = min(1, maxDimension / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.85) { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}

/// What the composer is attaching, before a message is sent. Voice lives in VoiceChat.
@MainActor
final class ComposerMedia: ObservableObject {
    struct PendingImage: Identifiable {
        let id = UUID()
        let preview: UIImage
        var attachment: ChatAttachment?
    }

    /// Anything that is not a photo, sent as it is.
    struct PendingFile: Identifiable {
        let id = UUID()
        let name: String
        var attachment: ChatAttachment?
    }

    @Published private(set) var images: [PendingImage] = []
    @Published private(set) var files: [PendingFile] = []
    @Published var error: String?

    private var api: ChompAPI { ChompAPI(config: AppConfig.shared) }

    var isUploading: Bool {
        images.contains { $0.attachment == nil } || files.contains { $0.attachment == nil }
    }

    var attachments: [ChatAttachment] {
        images.compactMap(\.attachment) + files.compactMap(\.attachment)
    }

    var isEmpty: Bool {
        images.isEmpty && files.isEmpty
    }

    func clear() {
        images = []
        files = []
    }

    func remove(_ id: UUID) {
        images.removeAll { $0.id == id }
        files.removeAll { $0.id == id }
    }

    /// A file from the Files app. A picture picked this way is shrunk like a photo.
    func addFile(_ url: URL) async {
        error = nil
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            error = "\(url.lastPathComponent) could not be read"
            return
        }
        let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        if mimeType.hasPrefix("image/"), ImagePreparation.jpeg(from: data) != nil {
            await add(data)
            return
        }
        let pending = PendingFile(name: url.lastPathComponent)
        files.append(pending)
        do {
            let attachment = try await api.upload(data, name: pending.name, mimeType: mimeType)
            if let index = files.firstIndex(where: { $0.id == pending.id }) {
                files[index].attachment = attachment
            }
        } catch {
            remove(pending.id)
            self.error = "Upload failed: \(error.localizedDescription)"
        }
    }

    func add(_ items: [PhotosPickerItem]) async {
        error = nil
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                error = "That photo could not be read"
                continue
            }
            await add(data)
        }
    }

    func add(_ data: Data) async {
        error = nil
        guard let jpeg = ImagePreparation.jpeg(from: data), let preview = UIImage(data: jpeg) else {
            error = "That photo could not be read"
            return
        }
        let pending = PendingImage(preview: preview)
        images.append(pending)
        do {
            let attachment = try await api.upload(jpeg, name: "photo.jpg", mimeType: "image/jpeg")
            if let index = images.firstIndex(where: { $0.id == pending.id }) {
                images[index].attachment = attachment
            }
        } catch {
            remove(pending.id)
            self.error = "Upload failed: \(error.localizedDescription)"
        }
    }
}

/// The system camera. Returns the photo, and asks for camera access itself on first use.
struct CameraPicker: UIViewControllerRepresentable {
    let onPhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let parent: CameraPicker

        init(parent: CameraPicker) {
            self.parent = parent
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let photo = info[.originalImage] as? UIImage {
                parent.onPhoto(photo)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
