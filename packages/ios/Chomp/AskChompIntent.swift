import AppIntents
import Foundation

/// Lets Shortcuts, Siri and the Action Button ask Chomp without opening the app.
/// With a screenshot as the image, this is how Chomp gets to see another app.
struct AskChompIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Chomp"
    static let description = IntentDescription("Asks Chomp a question, with an image if you want, and gives back the answer as text.")
    static let openAppWhenRun = false

    @Parameter(title: "Question")
    var question: String?

    @Parameter(title: "Image", supportedTypeIdentifiers: ["public.image"])
    var image: IntentFile?

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Chomp \(\.$question)") {
            \.$image
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let api = ChompAPI(config: AppConfig.shared)
        var attachments: [ChatAttachment] = []
        if let image {
            attachments.append(try await Self.upload(image, with: api))
        }
        var text = question?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.isEmpty, attachments.isEmpty {
            text = try await $question.requestValue("What do you want to ask?")
        }
        let reply = try await api.ask(text, attachments: attachments).reply ?? Self.stillWorking
        return .result(value: reply, dialog: "\(reply)")
    }

    static let stillWorking = "Still working on it. You get a notification when it is done."

    private static func upload(_ image: IntentFile, with api: ChompAPI) async throws -> ChatAttachment {
        guard let jpeg = ImagePreparation.jpeg(from: image.data) else {
            throw AskChompError.unreadableImage
        }
        return try await api.upload(jpeg, name: "image.jpg", mimeType: "image/jpeg")
    }
}

enum AskChompError: LocalizedError {
    case unreadableImage

    var errorDescription: String? {
        "Chomp could not read that image."
    }
}

struct ChompShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskChompIntent(),
            phrases: ["Ask \(.applicationName)"],
            shortTitle: "Ask Chomp",
            systemImageName: "bubble.left"
        )
    }
}
