import PhotosUI
import SwiftUI
import VoiceGlowKit

/// The bordered card from web chat: text on top, controls below.
struct ComposerView: View {
    @EnvironmentObject private var store: ChatStore
    @Binding var draft: String
    var focused: FocusState<Bool>.Binding
    var placeholder = "Message Chomp, or type @ for an agent"
    var isBusy = false
    var agentLabel: String? = nil
    var agentSelection: AgentSelection? = nil
    var context: ChompAPI.ContextUsage? = nil
    var onPickAgent: () -> Void = {}
    var onStop: () -> Void = {}
    /// Ends the running turn and sends this instead. Nil hides "Now".
    var onSendNow: (([ChatAttachment]) -> Void)? = nil
    var onCompact: (() -> Void)? = nil
    var onHandoff: (() -> Void)? = nil
    @ObservedObject var voice: VoiceChat
    let onSend: ([ChatAttachment]) -> Void

    @StateObject private var media = ComposerMedia()
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var showingPhotos = false
    @State private var showingCamera = false
    @State private var showingFiles = false

    private var hasText: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSend: Bool {
        (hasText || !media.attachments.isEmpty) && !media.isUploading
    }

    private var suggestions: (items: [ComposerSuggestion], start: String.Index)? {
        ComposerAutocomplete.match(draft, completions: store.completions, chats: store.conversations, activeId: store.activeConversationId)
    }

    private func send(now: Bool = false) {
        guard canSend else { return }
        (now ? onSendNow ?? onSend : onSend)(media.attachments)
        media.clear()
    }

    var body: some View {
        VStack(spacing: 8) {
            if let suggestions, !suggestions.items.isEmpty {
                ComposerSuggestions(items: suggestions.items) { item in
                    draft = String(draft[..<suggestions.start]) + item.insert
                }
            }
            card
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
        .background(Theme.surface)
        .photosPicker(isPresented: $showingPhotos, selection: $pickedPhotos, maxSelectionCount: 5, matching: .images)
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task { for url in urls { await media.addFile(url) } }
        }
        .fullScreenCover(isPresented: $showingCamera) {
            CameraPicker { photo in
                guard let data = photo.jpegData(compressionQuality: 1) else { return }
                Task { await media.add(data) }
            }
            .ignoresSafeArea()
        }
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            pickedPhotos = []
            Task { await media.add(items) }
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !media.isEmpty {
                pendingAttachments
            }
            if let error = media.error ?? voice.problem {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Theme.error)
            }
            TextField(placeholder, text: $draft, axis: .vertical)
                .font(.system(size: 16))
                .lineLimit(1...6)
                .foregroundStyle(Theme.textPrimary)
                .focused(focused)
                .submitLabel(.send)
                .onSubmit { send() }
                .padding(.horizontal, 4)
            HStack(spacing: 4) {
                Menu {
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button("Take photo", systemImage: "camera") { showingCamera = true }
                    }
                    Button("Choose photos", systemImage: "photo.on.rectangle") { showingPhotos = true }
                    Button("Choose files", systemImage: "doc") { showingFiles = true }
                } label: {
                    controlIcon("plus")
                }
                .accessibilityLabel("Attach")
                switch voice.phase {
                case .listening:
                    statusLabel("Listening") { LiveDot() }
                case .transcribing:
                    statusLabel("Transcribing") { ProgressView().controlSize(.small) }
                case .speaking:
                    statusLabel("Speaking") { LiveDot() }
                case .off:
                    if let agentLabel {
                        agentMenu(agentLabel)
                    }
                }
                Spacer(minLength: 4)
                // While a turn runs with something typed, "Now" takes its place, as on web.
                if !(isBusy && canSend) {
                    ContextMeter(
                        usage: context,
                        plan: store.planUsage.first { $0.provider == agentSelection?.provider && $0.available },
                        modelLabel: modelLabel,
                        onCompact: onCompact,
                        onHandoff: onHandoff
                    )
                }
                micButton
                actionButtons
            }
        }
        .padding(12)
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Theme.textPrimary.opacity(0.14))
        }
        // Follows your voice while it listens, and its own while it speaks.
        .voiceGlow(
            meter: voice.phase == .listening ? voice.meter : nil,
            levelProvider: voice.phase == .speaking ? { voice.playbackLevel() } : nil,
            active: voice.phase != .off,
            cornerRadius: 22
        )
    }

    private var modelLabel: String? {
        guard let agentSelection else { return nil }
        return store.agentProviders.first { $0.provider == agentSelection.provider }?.models.first { $0.id == agentSelection.model }?.label
    }

    private var pendingAttachments: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(media.images) { image in
                    Image(uiImage: image.preview)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay {
                            if image.attachment == nil {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(Theme.deep.opacity(0.6))
                                ProgressView().controlSize(.small)
                            }
                        }
                        .overlay(alignment: .topTrailing) { removeButton(image.id) }
                }
                ForEach(media.files) { file in
                    HStack(spacing: 6) {
                        if file.attachment == nil {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "doc").font(.footnote)
                        }
                        Text(file.name)
                            .font(.footnote)
                            .lineLimit(1)
                            .frame(maxWidth: 160, alignment: .leading)
                    }
                    .foregroundStyle(Theme.textSecondary)
                    .padding(.leading, 10)
                    .padding(.trailing, 28)
                    .frame(height: 64)
                    .background(Theme.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(alignment: .topTrailing) { removeButton(file.id) }
                }
            }
        }
    }

    private func removeButton(_ id: UUID) -> some View {
        Button {
            media.remove(id)
        } label: {
            Image(systemName: "xmark")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .frame(width: 20, height: 20)
                .background(Theme.deep.opacity(0.8))
                .clipShape(Circle())
                .padding(2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Remove attachment")
    }

    /// A frosted 40 pt circle with a hairline, thumb-sized, like the web composer's.
    private func controlIcon(_ name: String, tint: Color = Theme.textSecondary, fill: Color? = nil) -> some View {
        Image(systemName: name)
            .font(.body)
            .foregroundStyle(tint)
            .frame(width: 40, height: 40)
            .background(fill.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.ultraThinMaterial), in: Circle())
            .overlay(Circle().stroke(Color.white.opacity(0.12)))
            .contentShape(Circle())
    }

    private var micButton: some View {
        ZStack {
                switch voice.phase {
                case .off:
                    controlIcon("mic")
                case .transcribing:
                    ProgressView().controlSize(.small).frame(width: 40, height: 40)
                        .background(.ultraThinMaterial, in: Circle())
                case .speaking:
                    controlIcon("stop.fill", tint: Theme.error, fill: Theme.error.opacity(0.15))
                case .listening:
                    controlIcon("mic", tint: Theme.error, fill: Theme.error.opacity(0.15))
                }
                if voice.phase == .listening {
                    PauseRing(pause: voice.pause)
                }
                if voice.speakReplies {
                    Image(systemName: "speaker.wave.2.fill")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(Theme.onAccent)
                        .frame(width: 16, height: 16)
                        .background(Theme.accent, in: Circle())
                        .offset(x: 14, y: 14)
                        .allowsHitTesting(false)
                }
        }
        .contentShape(Circle())
        // Tap: voice on, off, or cut in. Hold: replies read aloud or not.
        .onTapGesture(perform: voice.tap)
        .onLongPressGesture(minimumDuration: 0.5) {
            voice.toggleSpokenReplies()
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(Self.voiceLabels[voice.phase] ?? "Talk hands-free")
        .accessibilityValue(voice.speakReplies ? "Replies read aloud" : "Replies not read aloud")
        .accessibilityAction(named: voice.speakReplies ? "Stop reading replies aloud" : "Read replies aloud") { voice.toggleSpokenReplies() }
        .task { await voice.loadSettings() }
    }

    private static let voiceLabels: [VoiceChat.Phase: String] = [
        .off: "Talk hands-free",
        .listening: "Listening. Tap to stop and keep the text",
        .transcribing: "Transcribing",
        .speaking: "Speaking. Tap to cut in",
    ]

    private func statusLabel<Icon: View>(_ text: String, @ViewBuilder icon: () -> Icon) -> some View {
        HStack(spacing: 8) {
            icon()
            Text(text).font(.caption.monospaced()).foregroundStyle(Theme.textSecondary)
        }
    }

    /// Provider mark, then "Opus · High", then a bolt when fast is on. As web chat's model button.
    private func agentMenu(_ label: String) -> some View {
        Button(action: onPickAgent) {
            HStack(spacing: 6) {
                if let provider = agentSelection?.provider {
                    ProviderMark(provider: provider)
                }
                Text(label).lineLimit(1)
                if agentSelection?.fast == true {
                    Image(systemName: "bolt").font(.caption2).foregroundStyle(Theme.textMuted)
                }
                Image(systemName: "chevron.down").font(.caption2).foregroundStyle(Theme.textMuted)
            }
            .font(.system(size: 13))
            .foregroundStyle(Theme.textSecondary)
            .padding(.horizontal, 6)
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose model, now \(label)\(agentSelection?.fast == true ? ", fast" : "")")
    }

    /// Stop while a turn runs; "Now" and send once there is something to send. As web chat.
    @ViewBuilder
    private var actionButtons: some View {
        if isBusy {
            Button(action: onStop) {
                Image(systemName: "stop.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.textPrimary)
                    .frame(width: 40, height: 40)
                    .overlay(Circle().stroke(Theme.textPrimary.opacity(0.14)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop")
            if canSend, onSendNow != nil {
                Button("Now") { send(now: true) }
                    .font(.footnote)
                    .foregroundStyle(Theme.textPrimary)
                    .frame(minWidth: 40, minHeight: 40)
                    .accessibilityLabel("Stop the running task and send this instead")
            }
        }
        if !isBusy || canSend {
            Button { send() } label: {
                Image(systemName: "arrow.up")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(canSend ? Theme.onAccent : Theme.textMuted)
                    .frame(width: 40, height: 40)
                    .background(canSend ? Theme.accent : Theme.raised, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel(isBusy ? "Add to the running task" : "Send")
        }
    }
}

/// Fills while you are quiet; full means it sends. Talking again empties it. Observes the pause
/// alone, so only this ring redraws as it moves.
private struct PauseRing: View {
    @ObservedObject var pause: VoicePause

    var body: some View {
        if pause.progress > 0 {
            Circle()
                .trim(from: 0, to: pause.progress)
                .stroke(Theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .frame(width: 46, height: 46)
                .allowsHitTesting(false)
        }
    }
}

/// Claude's spark in its own orange, or the OpenAI mark for Codex. The same marks as web chat.
struct ProviderMark: View {
    let provider: String
    var size: CGFloat = 14

    var body: some View {
        if provider == "codex" {
            Image("ProviderCodex").resizable().renderingMode(.template).scaledToFit().frame(width: size, height: size)
                .foregroundStyle(Theme.textMuted)
        } else {
            Image("ProviderClaude").resizable().scaledToFit().frame(width: size, height: size)
        }
    }
}
