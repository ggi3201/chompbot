import Foundation

/// A widget can only open its own app, so a card's link travels through the app.
enum PhoneCardLink {
    private static let scheme = "chomp"

    static func opening(_ link: URL) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "open"
        components.queryItems = [URLQueryItem(name: "url", value: link.absoluteString)]
        return components.url
    }

    /// The link inside a URL from `opening(_:)`, or nil for any other URL.
    static func target(of url: URL) -> URL? {
        guard url.scheme == scheme, url.host == "open" else { return nil }
        let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "url" }?.value
        return value.flatMap(URL.init(string:))
    }
}
