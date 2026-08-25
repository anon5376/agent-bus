import Foundation

/// Talks to the local agent-bus broker's usage ledger.
///
/// The broker is the only source that knows *which agent* spent what, which is the
/// gap this app exists to close: a swarm run shows up in the Claude Code and Codex
/// transcripts as one undifferentiated pile of tokens, with no way to see that one
/// misconfigured reviewer burned most of it.
///
/// When the broker is not running the ledger is still on disk, so a direct SQLite
/// read would be possible — but the broker owns that file and may be mid-write, so a
/// stopped broker is reported as "offline" rather than read behind its back.
struct AgentBusSource {
    static let home = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".agent-bus")

    var isPresent: Bool { FileManager.default.fileExists(atPath: Self.home.path) }

    struct Summary: Sendable {
        var totalTokens: Int
        var costUSD: Double
        var notionalUSD: Double
        var events: Int
        var byAgent: [ModelTotal]
        var byModel: [ModelTotal]
        var series: [Double]
        var brokerUp: Bool
    }

    private var operatorToken: String? {
        let url = Self.home.appendingPathComponent("operator.token")
        guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var busURL: URL {
        let port = ProcessInfo.processInfo.environment["AGENT_BUS_PORT"] ?? "7717"
        return URL(string: "http://127.0.0.1:\(port)")!
    }

    func load(range: Range) async -> Summary {
        let empty = Summary(
            totalTokens: 0, costUSD: 0, notionalUSD: 0, events: 0,
            byAgent: [], byModel: [], series: [], brokerUp: false
        )
        guard let token = operatorToken else { return empty }

        var request = URLRequest(url: busURL.appendingPathComponent("usage/summary"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 3
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "token": token,
            "windowMs": Int(range.seconds * 1000),
            "buckets": range.bucketCount,
        ])

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let summary = root["summary"] as? [String: Any],
              let totals = summary["totals"] as? [String: Any]
        else { return empty }

        let bucket = { (raw: [String: Any]) -> ModelTotal in
            ModelTotal(
                model: (raw["label"] as? String) ?? (raw["key"] as? String) ?? "unknown",
                tokens: TokenCounts(
                    input: (raw["inputTokens"] as? NSNumber)?.intValue ?? 0,
                    output: (raw["outputTokens"] as? NSNumber)?.intValue ?? 0,
                    cacheRead: (raw["cacheReadTokens"] as? NSNumber)?.intValue ?? 0,
                    cacheWrite: (raw["cacheWriteTokens"] as? NSNumber)?.intValue ?? 0,
                    reasoning: (raw["reasoningTokens"] as? NSNumber)?.intValue ?? 0
                ),
                costUSD: (raw["costUSD"] as? NSNumber)?.doubleValue ?? 0,
                messages: (raw["events"] as? NSNumber)?.intValue ?? 0
            )
        }

        let series = (summary["series"] as? [[String: Any]] ?? [])
            .map { Double(($0["totalTokens"] as? NSNumber)?.intValue ?? 0) }

        return Summary(
            totalTokens: (totals["totalTokens"] as? NSNumber)?.intValue ?? 0,
            costUSD: (totals["costUSD"] as? NSNumber)?.doubleValue ?? 0,
            notionalUSD: (totals["notionalUSD"] as? NSNumber)?.doubleValue ?? 0,
            events: (totals["events"] as? NSNumber)?.intValue ?? 0,
            byAgent: (summary["byAgent"] as? [[String: Any]] ?? []).map(bucket),
            byModel: (summary["byModel"] as? [[String: Any]] ?? []).map(bucket),
            series: series,
            brokerUp: true
        )
    }
}
