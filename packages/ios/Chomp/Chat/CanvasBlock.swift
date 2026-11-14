import Foundation

/// A number or a string. Agents write metric values both ways.
struct FlexString: Decodable, Equatable {
    let value: String

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let string = try? c.decode(String.self) {
            value = string
        } else if let int = try? c.decode(Int.self) {
            value = String(int)
        } else {
            value = String(try c.decode(Double.self))
        }
    }
}

/// A `:::canvas` block. The blocks the app draws itself, of those in `CanvasRenderer.tsx`.
/// Anything else is `unsupported`, and the thread links to it on the web.
enum CanvasBlock: Equatable {
    struct Metric: Decodable, Equatable {
        let title: String
        let value: FlexString
        let subtitle: String?
        let change: String?
        let color: String?
    }

    struct Table: Decodable, Equatable {
        let title: String?
        let headers: [FlexString]
        let rows: [[FlexString]]
    }

    struct Progress: Decodable, Equatable {
        let label: String
        let value: Double
        let max: Double?
        let color: String?
    }

    struct LinkItem: Decodable, Equatable {
        let label: String
        let url: String
        let description: String?
    }

    struct Bar: Decodable, Equatable {
        let label: String
        let value: Double
        let color: String?
    }

    struct Series: Decodable, Equatable {
        let label: String
        let data: [Double]
        let color: String?
    }

    struct Tab: Decodable, Equatable {
        let label: String
        let content: String
    }

    struct Event: Decodable, Equatable {
        let time: String?
        let title: String
        let description: String?
    }

    struct Option: Decodable, Equatable {
        let label: String
        let value: String?
    }

    case infoCard(Metric)
    case metricGrid(items: [Metric], columns: Int?)
    case dataTable(Table)
    case progressBar(Progress)
    case linkList(title: String?, items: [LinkItem])
    case barChart(title: String?, bars: [Bar])
    case lineChart(title: String?, labels: [String]?, series: [Series])
    case sparkline(label: String?, values: [Double], color: String?)
    case donutChart(title: String?, segments: [Bar], centerLabel: String?, centerValue: String?)
    case tabs([Tab])
    case timeline(title: String?, events: [Event])
    case callout(variant: String?, title: String?, message: String)
    case page(url: String, title: String?, isArtifact: Bool)
    case button(label: String, prompt: String?)
    case choice(title: String?, options: [Option])
    case unsupported(type: String)
}

extension CanvasBlock: Decodable {
    private enum Keys: String, CodingKey {
        case type, items, columns, title, bars, labels, series, label, values, color, segments
        case centerLabel, centerValue, tabs, events, variant, message, id, url, prompt, options
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = try c.decode(String.self, forKey: .type)
        let title = try? c.decodeIfPresent(String.self, forKey: .title)
        switch type {
        case "info-card":
            self = .infoCard(try Metric(from: decoder))
        case "metric-grid":
            self = .metricGrid(items: try c.decode([Metric].self, forKey: .items), columns: try? c.decodeIfPresent(Int.self, forKey: .columns))
        case "data-table":
            self = .dataTable(try Table(from: decoder))
        case "progress-bar":
            self = .progressBar(try Progress(from: decoder))
        case "link-list":
            self = .linkList(title: title, items: try c.decode([LinkItem].self, forKey: .items))
        case "bar-chart":
            self = .barChart(title: title, bars: try c.decode([Bar].self, forKey: .bars))
        case "line-chart":
            self = .lineChart(
                title: title,
                labels: try? c.decodeIfPresent([String].self, forKey: .labels),
                series: try c.decode([Series].self, forKey: .series)
            )
        case "sparkline":
            self = .sparkline(
                label: try? c.decodeIfPresent(String.self, forKey: .label),
                values: try c.decode([Double].self, forKey: .values),
                color: try? c.decodeIfPresent(String.self, forKey: .color)
            )
        case "donut-chart":
            self = .donutChart(
                title: title,
                segments: try c.decode([Bar].self, forKey: .segments),
                centerLabel: try? c.decodeIfPresent(String.self, forKey: .centerLabel),
                centerValue: try? c.decodeIfPresent(String.self, forKey: .centerValue)
            )
        case "tabs":
            self = .tabs(try c.decode([Tab].self, forKey: .tabs))
        case "timeline":
            self = .timeline(title: title, events: try c.decode([Event].self, forKey: .events))
        case "callout":
            self = .callout(
                variant: try? c.decodeIfPresent(String.self, forKey: .variant),
                title: title,
                message: try c.decode(String.self, forKey: .message)
            )
        case "artifact":
            self = .page(url: "/api/artifacts/\(try c.decode(String.self, forKey: .id))", title: title, isArtifact: true)
        case "embed":
            self = .page(url: try c.decode(String.self, forKey: .url), title: title, isArtifact: false)
        case "button":
            self = .button(label: try c.decode(String.self, forKey: .label), prompt: try? c.decodeIfPresent(String.self, forKey: .prompt))
        case "choice":
            self = .choice(title: title, options: try c.decode([Option].self, forKey: .options))
        default:
            self = .unsupported(type: type)
        }
    }
}

/// A message split into markdown and canvas blocks. As `parseCanvasContent` in `canvas-parser.ts`.
enum MessageSegment: Equatable {
    case text(String)
    case canvas(CanvasBlock)

    private static let fence = try! NSRegularExpression(pattern: ":::canvas\\s*\\n([\\s\\S]*?)\\n:::")

    static func parse(_ content: String) -> [MessageSegment] {
        let source = content as NSString
        var segments: [MessageSegment] = []
        var cursor = 0

        func appendText(upTo end: Int) {
            let text = source.substring(with: NSRange(location: cursor, length: end - cursor))
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                segments.append(.text(text))
            }
        }

        for match in fence.matches(in: content, range: NSRange(location: 0, length: source.length)) {
            appendText(upTo: match.range.location)
            segments.append(block(json: source.substring(with: match.range(at: 1)), raw: source.substring(with: match.range)))
            cursor = match.range.location + match.range.length
        }
        appendText(upTo: source.length)
        return segments
    }

    /// Text that is not valid JSON shows as written. A block with the wrong fields is `unsupported`.
    private static func block(json: String, raw: String) -> MessageSegment {
        let data = Data(json.utf8)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else {
            return .text(raw)
        }
        return .canvas((try? JSONDecoder().decode(CanvasBlock.self, from: data)) ?? .unsupported(type: type))
    }
}
