import Foundation

/// Talks to /api/auth/login on the Chomp server. Same flow the PWA uses:
/// POST { password, longLived } → { token }.
struct AuthClient {
    enum AuthError: LocalizedError {
        case notConfigured
        case invalidPassword
        case server(String)
        case transport(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Set a server host in Settings first."
            case .invalidPassword: return "Wrong password."
            case .server(let s): return s
            case .transport(let s): return s
            }
        }
    }

    let host: String
    let useTLS: Bool

    func login(password: String, longLived: Bool) async throws -> String {
        guard !host.isEmpty else { throw AuthError.notConfigured }
        var components = URLComponents()
        components.scheme = useTLS ? "https" : "http"
        components.host = host
        components.path = "/api/auth/login"
        guard let url = components.url else { throw AuthError.notConfigured }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["password": password, "longLived": longLived]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw AuthError.transport(error.localizedDescription)
        }
        guard let http = resp as? HTTPURLResponse else {
            throw AuthError.transport("Bad response")
        }
        if http.statusCode == 401 {
            throw AuthError.invalidPassword
        }
        if http.statusCode >= 400 {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw AuthError.server(msg ?? "HTTP \(http.statusCode)")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String, !token.isEmpty else {
            throw AuthError.server("Missing token in response")
        }
        return token
    }
}
