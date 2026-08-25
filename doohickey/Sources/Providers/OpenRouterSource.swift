import Foundation

/// OpenRouter is the only provider here that reports spend as authoritative dollars,
/// from `/api/v1/key`. It does not break that spend down by model, so the per-model
/// detail comes from the slash-namespaced entries in the Claude Code transcripts —
/// those are the calls the local router forwarded to OpenRouter.
///
/// The dollar figures shown are OpenRouter's own; the transcript-derived numbers only
/// fill in the breakdown beneath them.
struct OpenRouterSource {
    static let keyPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".openrouter-key")

    struct Account: Sendable {
        var usageTotal: Double
        var usageDaily: Double
        var usageWeekly: Double
        var usageMonthly: Double
        var limit: Double?
        var limitRemaining: Double?
        var isFreeTier: Bool
        var totalCredits: Double?
    }

    var isPresent: Bool { FileManager.default.fileExists(atPath: Self.keyPath.path) }

    private var key: String? {
        guard let raw = try? String(contentsOf: Self.keyPath, encoding: .utf8) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func load() async throws -> Account {
        guard let key else { throw Failure.noKey }

        async let keyInfo = get("https://openrouter.ai/api/v1/key", key: key)
        async let credits = try? get("https://openrouter.ai/api/v1/credits", key: key)

        let data = try await keyInfo["data"] as? [String: Any] ?? [:]
        let creditData = await (credits?["data"] as? [String: Any]) ?? [:]
        let double = { (source: [String: Any], name: String) in (source[name] as? NSNumber)?.doubleValue }

        return Account(
            usageTotal: double(data, "usage") ?? 0,
            usageDaily: double(data, "usage_daily") ?? 0,
            usageWeekly: double(data, "usage_weekly") ?? 0,
            usageMonthly: double(data, "usage_monthly") ?? 0,
            limit: double(data, "limit"),
            limitRemaining: double(data, "limit_remaining"),
            isFreeTier: (data["is_free_tier"] as? NSNumber)?.boolValue ?? false,
            totalCredits: double(creditData, "total_credits")
        )
    }

    private func get(_ url: String, key: String) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: url)!)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw Failure.http((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    enum Failure: LocalizedError {
        case noKey
        case http(Int)

        var errorDescription: String? {
            switch self {
            case .noKey: return "no key at ~/.openrouter-key"
            case .http(let code): return "OpenRouter returned \(code)"
            }
        }
    }
}
