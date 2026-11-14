import Charts
import SwiftUI
import WebKit

extension EnvironmentValues {
    /// Canvas buttons above the latest user message are already answered.
    @Entry var canvasLocked = false
}

/// A message's text and canvas blocks. A half-streamed fence is not valid JSON yet, so it renders as text until final.
struct MessageContent: View {
    let text: String
    var isStreaming = false

    var body: some View {
        if isStreaming {
            // The block cursor is the web chat's typing cursor, and sits right after the last word.
            ChatMarkdown(text: text + "▍")
        } else {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(MessageSegment.parse(text).enumerated()), id: \.offset) { _, segment in
                    switch segment {
                    case .text(let text): ChatMarkdown(text: text)
                    case .canvas(let block): CanvasBlockView(block: block)
                    }
                }
            }
        }
    }
}

struct CanvasBlockView: View {
    let block: CanvasBlock

    var body: some View {
        switch block {
        case .infoCard(let metric):
            ThemedCard { MetricView(metric: metric) }
        case .metricGrid(let items, let columns):
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8, alignment: .top), count: min(columns ?? 2, 2)), spacing: 8) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, metric in
                    ThemedCard { MetricView(metric: metric) }
                }
            }
        case .dataTable(let table):
            DataTableView(table: table)
        case .progressBar(let progress):
            ProgressBlock(progress: progress)
        case .linkList(let title, let items):
            ThemedCard {
                VStack(alignment: .leading, spacing: 8) {
                    BlockTitle(title)
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        if let url = URL(string: item.url) {
                            Link(destination: url) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.label).font(.subheadline).foregroundStyle(Theme.accentInk)
                                    if let description = item.description {
                                        Text(description).font(.caption).foregroundStyle(Theme.textSecondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        case .barChart(let title, let bars):
            BarsBlock(title: title, bars: bars)
        case .lineChart(let title, let labels, let series):
            LineBlock(title: title, labels: labels, series: series)
        case .sparkline(let label, let values, let color):
            SparklineBlock(label: label, values: values, color: color)
        case .donutChart(let title, let segments, let centerLabel, let centerValue):
            DonutBlock(title: title, segments: segments, centerLabel: centerLabel, centerValue: centerValue)
        case .tabs(let tabs):
            TabsBlock(tabs: tabs)
        case .timeline(let title, let events):
            TimelineBlock(title: title, events: events)
        case .callout(let variant, let title, let message):
            CalloutBlock(variant: variant, title: title, message: message)
        case .page(let url, let title, let isArtifact):
            PageBlock(path: url, title: title, isArtifact: isArtifact)
        case .button(let label, let prompt):
            CanvasActionButton(label: label, prompt: prompt ?? label)
        case .choice(let title, let options):
            VStack(alignment: .leading, spacing: 8) {
                BlockTitle(title)
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    CanvasActionButton(label: option.label, prompt: option.value ?? option.label)
                }
            }
        case .unsupported(let type):
            UnsupportedBlock(type: type)
        }
    }
}

private struct BlockTitle: View {
    let title: String?

    init(_ title: String?) {
        self.title = title
    }

    var body: some View {
        if let title, !title.isEmpty {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
        }
    }
}

private struct MetricView: View {
    let metric: CanvasBlock.Metric

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(metric.title).font(.footnote).foregroundStyle(Theme.textSecondary)
            Text(metric.value.value)
                .font(.title2.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(Theme.textPrimary)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            if let change = metric.change {
                Text(change).font(.caption).foregroundStyle(Theme.hue(metric.color, fallback: Theme.textSecondary))
            }
            if let subtitle = metric.subtitle {
                Text(subtitle).font(.caption).foregroundStyle(Theme.textMuted)
            }
        }
    }
}

private struct DataTableView: View {
    let table: CanvasBlock.Table

    var body: some View {
        ThemedCard {
            VStack(alignment: .leading, spacing: 8) {
                BlockTitle(table.title)
                ScrollView(.horizontal) {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                        GridRow {
                            ForEach(Array(table.headers.enumerated()), id: \.offset) { _, header in
                                Text(header.value).font(.caption.weight(.medium)).foregroundStyle(Theme.textSecondary)
                            }
                        }
                        Divider().overlay(Theme.hairline)
                        ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                            GridRow {
                                ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                    Text(cell.value).font(.footnote).monospacedDigit().foregroundStyle(Theme.textPrimary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct ProgressBlock: View {
    let progress: CanvasBlock.Progress

    private var fraction: Double {
        let max = progress.max ?? 100
        return max > 0 ? min(1, Swift.max(0, progress.value / max)) : 0
    }

    var body: some View {
        ThemedCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(progress.label).font(.footnote).foregroundStyle(Theme.textSecondary)
                    Spacer()
                    Text(fraction, format: .percent.precision(.fractionLength(0)))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Theme.textMuted)
                }
                BarTrack(fraction: fraction, color: Theme.hue(progress.color))
            }
        }
    }
}

private struct BarTrack: View {
    let fraction: Double
    let color: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.raised)
                Capsule().fill(color).frame(width: geometry.size.width * fraction)
            }
        }
        .frame(height: 6)
    }
}

private struct BarsBlock: View {
    let title: String?
    let bars: [CanvasBlock.Bar]

    var body: some View {
        let largest = bars.map(\.value).max() ?? 0
        ThemedCard {
            VStack(alignment: .leading, spacing: 12) {
                BlockTitle(title)
                ForEach(Array(bars.enumerated()), id: \.offset) { _, bar in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(bar.label).font(.footnote).foregroundStyle(Theme.textSecondary)
                            Spacer()
                            Text(bar.value, format: .number).font(.caption.monospacedDigit()).foregroundStyle(Theme.textMuted)
                        }
                        BarTrack(fraction: largest > 0 ? bar.value / largest : 0, color: Theme.hue(bar.color))
                    }
                }
            }
        }
    }
}

private struct LineBlock: View {
    let title: String?
    let labels: [String]?
    let series: [CanvasBlock.Series]

    private func color(_ index: Int) -> Color {
        Theme.hue(series[index].color, fallback: Theme.seriesColor(index))
    }

    var body: some View {
        ThemedCard {
            VStack(alignment: .leading, spacing: 8) {
                BlockTitle(title)
                Chart {
                    ForEach(Array(series.enumerated()), id: \.offset) { index, line in
                        ForEach(Array(line.data.enumerated()), id: \.offset) { position, value in
                            LineMark(
                                x: .value("Point", labels.flatMap { position < $0.count ? $0[position] : nil } ?? String(position + 1)),
                                y: .value("Value", value),
                                series: .value("Series", line.label)
                            )
                            .foregroundStyle(color(index))
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks { _ in AxisValueLabel().foregroundStyle(Theme.textMuted) }
                }
                .chartYAxis {
                    AxisMarks { _ in
                        AxisGridLine().foregroundStyle(Theme.hairline)
                        AxisValueLabel().foregroundStyle(Theme.textMuted)
                    }
                }
                .frame(height: 180)
                if series.count > 1 {
                    HStack(spacing: 12) {
                        ForEach(Array(series.enumerated()), id: \.offset) { index, line in
                            HStack(spacing: 4) {
                                Circle().fill(color(index)).frame(width: 6, height: 6)
                                Text(line.label).font(.caption).foregroundStyle(Theme.textSecondary)
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct SparklineBlock: View {
    let label: String?
    let values: [Double]
    let color: String?

    var body: some View {
        ThemedCard {
            VStack(alignment: .leading, spacing: 8) {
                if let label {
                    Text(label).font(.footnote).foregroundStyle(Theme.textSecondary)
                }
                Chart {
                    ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                        LineMark(x: .value("Point", index), y: .value("Value", value))
                            .foregroundStyle(Theme.hue(color))
                    }
                }
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .frame(height: 48)
            }
        }
    }
}

private struct DonutBlock: View {
    let title: String?
    let segments: [CanvasBlock.Bar]
    let centerLabel: String?
    let centerValue: String?

    private func color(_ index: Int) -> Color {
        Theme.hue(segments[index].color, fallback: Theme.seriesColor(index))
    }

    var body: some View {
        ThemedCard {
            VStack(alignment: .leading, spacing: 12) {
                BlockTitle(title)
                HStack(spacing: 16) {
                    Chart {
                        ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                            SectorMark(angle: .value("Value", segment.value), innerRadius: .ratio(0.68), angularInset: 1)
                                .foregroundStyle(color(index))
                        }
                    }
                    .frame(width: 112, height: 112)
                    .overlay {
                        VStack(spacing: 0) {
                            if let centerValue {
                                Text(centerValue).font(.subheadline.weight(.medium)).foregroundStyle(Theme.textPrimary)
                            }
                            if let centerLabel {
                                Text(centerLabel).font(.caption2).foregroundStyle(Theme.textMuted)
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                            HStack(spacing: 6) {
                                Circle().fill(color(index)).frame(width: 6, height: 6)
                                Text(segment.label).font(.caption).foregroundStyle(Theme.textSecondary)
                                Text(segment.value, format: .number).font(.caption.monospacedDigit()).foregroundStyle(Theme.textMuted)
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct TabsBlock: View {
    let tabs: [CanvasBlock.Tab]
    @State private var selected = 0

    var body: some View {
        ThemedCard {
            VStack(alignment: .leading, spacing: 12) {
                Picker("Tab", selection: $selected) {
                    ForEach(Array(tabs.enumerated()), id: \.offset) { index, tab in
                        Text(tab.label).tag(index)
                    }
                }
                .pickerStyle(.segmented)
                if tabs.indices.contains(selected) {
                    ChatMarkdown(text: tabs[selected].content)
                }
            }
        }
    }
}

private struct TimelineBlock: View {
    let title: String?
    let events: [CanvasBlock.Event]

    var body: some View {
        ThemedCard {
            VStack(alignment: .leading, spacing: 12) {
                BlockTitle(title)
                ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                    VStack(alignment: .leading, spacing: 2) {
                        if let time = event.time {
                            Text(time).font(.caption.monospaced()).foregroundStyle(Theme.textMuted)
                        }
                        Text(event.title).font(.subheadline).foregroundStyle(Theme.textPrimary)
                        if let description = event.description {
                            Text(description).font(.footnote).foregroundStyle(Theme.textSecondary)
                        }
                    }
                }
            }
        }
    }
}

private struct CalloutBlock: View {
    let variant: String?
    let title: String?
    let message: String

    private var mark: (icon: String, color: Color) {
        switch variant {
        case "warning": return ("exclamationmark.triangle", Theme.accentInk)
        case "success": return ("checkmark.circle", Theme.success)
        case "error": return ("xmark.circle", Theme.error)
        case "tip": return ("lightbulb", Theme.textSecondary)
        default: return ("info.circle", Theme.textSecondary)
        }
    }

    var body: some View {
        ThemedCard {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: mark.icon).font(.footnote).foregroundStyle(mark.color)
                VStack(alignment: .leading, spacing: 2) {
                    BlockTitle(title)
                    Text(message).font(.footnote).foregroundStyle(Theme.textSecondary)
                }
            }
        }
    }
}

/// An agent-written page or an embed. Nothing it stores outlives the view, and it never sees Chomp's token.
private struct PageBlock: View {
    let path: String
    let title: String?
    let isArtifact: Bool
    @State private var isExpanded = false

    private var url: URL? {
        URL(string: path, relativeTo: AppConfig.shared.serverURL)?.absoluteURL
    }

    var body: some View {
        if let url {
            VStack(spacing: 0) {
                HStack {
                    Text(title ?? (isArtifact ? "Artifact" : "Page"))
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                    Spacer()
                    Button {
                        isExpanded = true
                    } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.footnote)
                            .foregroundStyle(Theme.textMuted)
                    }
                    .accessibilityLabel("Open full screen")
                }
                .padding(12)
                PageWebView(url: url).frame(height: 420)
            }
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.hairline)
            }
            .fullScreenCover(isPresented: $isExpanded) {
                NavigationStack {
                    PageWebView(url: url)
                        .ignoresSafeArea(edges: .bottom)
                        .navigationTitle(title ?? "")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Done") { isExpanded = false }
                            }
                        }
                }
            }
        }
    }
}

private struct PageWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// Sends the choice back as the user's next message.
private struct CanvasActionButton: View {
    @EnvironmentObject private var store: ChatStore
    @Environment(\.canvasLocked) private var locked
    let label: String
    let prompt: String

    var body: some View {
        Button {
            store.send(prompt)
        } label: {
            Text(label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Theme.raised)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Theme.hairline)
                }
        }
        .buttonStyle(.plain)
        .disabled(locked)
        .opacity(locked ? 0.5 : 1)
    }
}

/// Blocks the app does not draw yet, like forms and sketches. Says so, and opens the chat on the web.
private struct UnsupportedBlock: View {
    @EnvironmentObject private var store: ChatStore
    let type: String

    private var webURL: URL? {
        guard let id = store.activeConversationId else { return AppConfig.shared.serverURL }
        return URL(string: "/chat/\(id)", relativeTo: AppConfig.shared.serverURL)?.absoluteURL
    }

    var body: some View {
        ThemedCard {
            HStack {
                Text("This \(type.replacingOccurrences(of: "-", with: " ")) shows on the web")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                Spacer()
                if let webURL {
                    Link("Open", destination: webURL)
                        .font(.footnote)
                        .foregroundStyle(Theme.accentInk)
                }
            }
        }
    }
}
