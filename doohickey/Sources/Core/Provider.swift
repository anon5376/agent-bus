import Foundation
import SwiftUI

/// Where a provider's credential lives. Declarative so adding a provider is a data
/// change, not a new code path.
enum CredentialSource: Sendable {
    case env(String)
    /// Whole file contents, trimmed. `~/.openrouter-key` and friends.
    case keyFile(String)
    /// A value at a key path inside a JSON file.
    case jsonField(path: String, keyPath: [String])
    /// A named cookie inside a JSON cookie jar (Cursor's session token).
    case cookie(path: String, name: String)

    func resolve() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        func expand(_ p: String) -> String {
            p.hasPrefix("~") ? home + String(p.dropFirst()) : p
        }
        switch self {
        case .env(let name):
            let value = ProcessInfo.processInfo.environment[name]
            return (value?.isEmpty ?? true) ? nil : value
        case .keyFile(let path):
            guard let raw = try? String(contentsOfFile: expand(path), encoding: .utf8) else { return nil }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case .jsonField(let path, let keyPath):
            guard let data = FileManager.default.contents(atPath: expand(path)),
                  var node = try? JSONSerialization.jsonObject(with: data) else { return nil }
            for key in keyPath {
                guard let dict = node as? [String: Any], let next = dict[key] else { return nil }
                node = next
            }
            guard let value = node as? String, !value.isEmpty else { return nil }
            return value
        case .cookie(let path, let name):
            guard let data = FileManager.default.contents(atPath: expand(path)),
                  let jar = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
            for entry in jar where (entry["Name"] as? String) == name {
                if let value = entry["Value"] as? String, !value.isEmpty { return value }
            }
            return nil
        }
    }
}

enum AuthStyle: Sendable {
    case bearer
    case xApiKey
    case cookie(String)
    case none
}

/// What a provider actually told us. Every field optional because providers expose
/// wildly different things: some a credit balance, some a percentage window, some
/// only a request count against an allowance.
struct Reading: Sendable {
    var windows: [LimitWindow] = []
    /// Credit left on the account, in dollars.
    var balanceUSD: Double?
    var usedUSD: Double?
    var limitUSD: Double?
    var plan: String?
    var detail: String?
}

/// How a provider is reached and how its response maps onto a `Reading`.
struct QuotaEndpoint: Sendable {
    var url: String
    var method: String = "GET"
    var auth: AuthStyle = .bearer
    var headers: [String: String] = [:]
    var body: String?
    /// Runs on the decoded JSON. Returning nil means "responded, but had nothing to say".
    var map: @Sendable ([String: Any]) -> Reading?
}

/// Why a provider has nothing to show. Distinguishing these is the difference between
/// "you have not set this up" and "this cannot be shown by anyone".
enum ProviderState: Sendable, Equatable {
    case ok
    /// No credential found on this machine.
    case notConfigured
    /// Credential found, provider reachable, but it publishes no usage figures.
    case noUsageAPI
    case offline(String)
    case failed(String)
}

struct ProviderSpec: Identifiable, Sendable {
    var id: String
    var title: String
    var symbol: String
    var accent: Color
    /// Tried in order; the first that resolves wins.
    var credentials: [CredentialSource] = []
    var endpoint: QuotaEndpoint?
    var billing: Billing = .metered
    /// Set when the provider is known to publish nothing, so the UI can say so rather
    /// than implying the user forgot to configure something.
    var publishesUsage: Bool = true
    /// Shown in the "not set up" list even with no credential, so the roster is honest
    /// about what is supported.
    var note: String?

    func credential() -> String? {
        for source in credentials {
            if let value = source.resolve() { return value }
        }
        return nil
    }
}

/// Generic fetcher. Every API-backed provider goes through this; only the spec differs.
enum ProviderFetcher {
    static func fetch(_ spec: ProviderSpec) async -> (state: ProviderState, reading: Reading?) {
        guard let endpoint = spec.endpoint else {
            return (spec.publishesUsage ? .notConfigured : .noUsageAPI, nil)
        }
        guard let secret = spec.credentials.isEmpty ? "" : spec.credential() else {
            return (.notConfigured, nil)
        }
        guard let url = URL(string: endpoint.url) else { return (.failed("bad url"), nil) }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method
        request.timeoutInterval = 12
        request.setValue("Doohickey/1.0", forHTTPHeaderField: "User-Agent")
        for (key, value) in endpoint.headers { request.setValue(value, forHTTPHeaderField: key) }
        if let body = endpoint.body {
            request.httpBody = Data(body.utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        switch endpoint.auth {
        case .bearer: request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        case .xApiKey: request.setValue(secret, forHTTPHeaderField: "x-api-key")
        case .cookie(let name): request.setValue("\(name)=\(secret)", forHTTPHeaderField: "Cookie")
        case .none: break
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                // 401/403 almost always means a stale cookie or rotated key, which the
                // user can act on — worth saying rather than a generic failure.
                return (.failed(status == 401 || status == 403 ? "credential rejected" : "HTTP \(status)"), nil)
            }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return (.failed("unexpected response"), nil)
            }
            guard let reading = endpoint.map(json) else { return (.noUsageAPI, nil) }
            return (.ok, reading)
        } catch {
            return (.offline("unreachable"), nil)
        }
    }
}

// Small helpers for the mapping closures, which all pick numbers out of loose JSON.
func num(_ container: [String: Any]?, _ key: String) -> Double? {
    (container?[key] as? NSNumber)?.doubleValue
}

func dict(_ container: [String: Any]?, _ key: String) -> [String: Any]? {
    container?[key] as? [String: Any]
}

func str(_ container: [String: Any]?, _ key: String) -> String? {
    container?[key] as? String
}
