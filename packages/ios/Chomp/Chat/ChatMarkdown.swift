import MarkdownUI
import SwiftUI

/// A message's text: markdown with the app's colors and images that load from the server.
struct ChatMarkdown: View {
    let text: String

    var body: some View {
        Markdown(text, baseURL: AppConfig.shared.serverURL, imageBaseURL: AppConfig.shared.serverURL)
            .markdownTextStyle {
                ForegroundColor(Theme.textPrimary)
            }
            .markdownTextStyle(\.code) {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.9))
                BackgroundColor(Theme.raised)
            }
            .markdownTextStyle(\.link) {
                ForegroundColor(Theme.accentInk)
            }
            .markdownBlockStyle(\.codeBlock) { configuration in
                ScrollView(.horizontal) {
                    configuration.label
                        .font(.system(.footnote, design: .monospaced))
                        .padding(12)
                }
                .background(Theme.deep)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay {
                    RoundedRectangle(cornerRadius: 8).stroke(Theme.hairline)
                }
            }
            .markdownImageProvider(ChatImageProvider())
            .textSelection(.enabled)
    }
}

private struct ChatImageProvider: ImageProvider {
    func makeImage(url: URL?) -> some View {
        ChatImage(url: url)
    }
}

/// An image in a message. A tap opens it full screen.
struct ChatImage: View {
    let url: URL?
    @State private var isExpanded = false

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.hairline)
                    }
                    .onTapGesture { isExpanded = true }
            case .failure:
                Label("Image did not load", systemImage: "photo")
                    .font(.footnote)
                    .foregroundStyle(Theme.textMuted)
            default:
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Theme.card)
                    .frame(height: 180)
                    .overlay { ProgressView() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fullScreenCover(isPresented: $isExpanded) {
            FullScreenImage(url: url)
        }
    }
}

private struct FullScreenImage: View {
    let url: URL?
    @Environment(\.dismiss) private var dismiss
    @State private var zoom: CGFloat = 1

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Theme.deep.ignoresSafeArea()
            AsyncImage(url: url) { image in
                image
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(zoom)
                    .gesture(MagnifyGesture().onChanged { zoom = max(1, $0.magnification) })
            } placeholder: {
                ProgressView()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .foregroundStyle(Theme.textPrimary)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Close")
        }
    }
}
