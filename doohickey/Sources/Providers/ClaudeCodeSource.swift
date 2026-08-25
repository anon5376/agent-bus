import Foundation

/// Reads Claude Code's own transcripts under `~/.claude/projects`.
///
/// Two things make this less trivial than summing a column:
///
/// 1. **The same message appears several times.** Claude Code appends a record per
///    streaming update, all sharing one `message.id`, with the usage block restated
///    in full each time. Summing naively inflates totals roughly threefold, so the
///    message id is the dedupe key.
/// 2. **Not all of it is Anthropic.** With a local router in front, a model id
///    containing a slash (`openrouter/…`, `stealth/ox-alpha`) was billed by
///    OpenRouter, not against the Claude subscription. Those are partitioned out
///    here and reported under OpenRouter instead, so neither side double-counts.
struct ClaudeCodeSource {
    static let root = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/projects")

    private let index = JSONLIndex(name: "claude-code")

    var isPresent: Bool { FileManager.default.fileExists(atPath: Self.root.path) }

    struct Result: Sendable {
        var anthropic: [HourBucket]
        var routed: [HourBucket]
        var lastActivity: Date?
    }

    func load(horizon: TimeInterval) async -> Result {
        let files = JSONLIndex.jsonlFiles(under: Self.root)
        let (buckets, lastActivity) = await index.scan(files: files, horizon: horizon, needles: ["\"usage\""]) { line in
            guard let record = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  record["type"] as? String == "assistant",
                  let message = record["message"] as? [String: Any],
                  let usage = message["usage"] as? [String: Any]
            else { return nil }

            let model = (message["model"] as? String) ?? "unknown"
            // Claude Code writes these for locally-synthesised replies that never hit
            // an API — interrupts, cache notices. They cost nothing.
            guard model != "<synthetic>", !model.isEmpty else { return nil }

            let int = { (key: String) in (usage[key] as? NSNumber)?.intValue ?? 0 }
            var tokens = TokenCounts(
                input: int("input_tokens"),
                output: int("output_tokens"),
                cacheRead: int("cache_read_input_tokens"),
                cacheWrite: int("cache_creation_input_tokens")
            )
            if let details = usage["output_tokens_details"] as? [String: Any] {
                // Thinking tokens are already inside output_tokens; tracked separately
                // for display only, so they must not be added to the total again.
                tokens.reasoning = (details["thinking_tokens"] as? NSNumber)?.intValue ?? 0
            }
            guard tokens.total > 0 else { return nil }

            guard let stamp = record["timestamp"] as? String,
                  let date = ISO8601.parse(stamp)
            else { return nil }

            var priced = tokens
            priced.reasoning = 0   // avoid double-billing thinking as extra output
            return JSONLIndex.ParsedLine(
                timestamp: date,
                model: model,
                tokens: tokens,
                costUSD: Pricing.cost(model: model, tokens: priced),
                dedupeKey: message["id"] as? String
            )
        }

        return Result(
            anthropic: buckets.filter { !$0.model.contains("/") },
            routed: buckets.filter { $0.model.contains("/") },
            lastActivity: lastActivity
        )
    }
}

enum ISO8601 {
    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ value: String) -> Date? {
        withFraction.date(from: value) ?? plain.date(from: value)
    }
}
