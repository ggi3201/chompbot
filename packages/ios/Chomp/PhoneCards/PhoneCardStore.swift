import Foundation

/// Fetches the cards and saves them where both the app and the widget can read them.
enum PhoneCardStore {
    private struct Response: Decodable {
        let cards: [PhoneCard]
    }

    private static let dateStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            try dateStyle.parse(decoder.singleValueContainer().decode(String.self))
        }
        return decoder
    }()

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(date.formatted(dateStyle))
        }
        return encoder
    }()

    private static var fileURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: AppConfig.appGroup)?
            .appendingPathComponent("phone-cards.json")
    }

    static func saved() -> [PhoneCard] {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return [] }
        return (try? decoder.decode([PhoneCard].self, from: data)) ?? []
    }

    /// The server's cards, or the saved ones when it is out of reach, for example with Tailscale off.
    static func refresh() async -> [PhoneCard] {
        do {
            let cards = try await fetch()
            if let url = fileURL {
                try encoder.encode(cards).write(to: url, options: .atomic)
            }
            await PhoneCardAlerts.schedule(cards)
            return cards
        } catch {
            print("[phone-cards] refresh failed: \(error.localizedDescription)")
            return saved()
        }
    }

    private static func fetch() async throws -> [PhoneCard] {
        let config = AppConfig.shared
        let scheme = config.useTLS ? "https" : "http"
        guard !config.jwt.isEmpty, let url = URL(string: "\(scheme)://\(config.serverHost)/api/phone-cards") else {
            throw URLError(.userAuthenticationRequired)
        }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.setValue("Bearer \(config.jwt)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try decoder.decode(Response.self, from: data).cards
    }
}
