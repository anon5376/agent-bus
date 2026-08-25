import Foundation

/// Reads Codex rollouts under `~/.codex/sessions` (and `archived_sessions`).
///
/// Codex is the one provider that states its own quota: every `token_count` event
/// carries a `rate_limits` block with `used_percent`, the window length and the reset
/// timestamp. That is authoritative, so limits are taken from the most recent event
/// rather than estimated — unlike Claude Code, which reports nothing.
///
/// Token accounting uses `last_token_usage` (this turn) rather than
/// `total_token_usage` (cumulative for the session), because the cumulative figure is
/// restated on every event and summing it would count the whole session once per turn.
struct CodexSource {
    static let home = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".codex")

    private let index = JSONLIndex(name: "codex")

    var isPresent: Bool { FileManager.default.fileExists(atPath: Self.home.path) }

    struct Result: Sendable {
        var buckets: [HourBucket]
        var limits: [LimitWindow]
        var planType: String?
        var lastActivity: Date?
    }

    /// `token_count` events carry no model name, so the parser remembers the model
    /// from the `turn_context` line that precedes them in the same rollout.
    private final class ModelMemo: @unchecked Sendable {
        private let lock = NSLock()
        private var value = "gpt-5-codex"
        func set(_ model: String) { lock.lock(); value = model; lock.unlock() }
        func get() -> String { lock.lock(); defer { lock.unlock() }; return value }
    }

    func load(horizon: TimeInterval) async -> Result {
        var files = JSONLIndex.jsonlFiles(under: Self.home.appendingPathComponent("sessions"))
        files += JSONLIndex.jsonlFiles(under: Self.home.appendingPathComponent("archived_sessions"))

        let memo = ModelMemo()
        // `turn_context` is needed too: it carries the model name that token_count omits.
        let needles = ["\"token_count\"", "\"turn_context\""]
        let (buckets, lastActivity) = await index.scan(files: files, horizon: horizon, needles: needles) { line in
            guard let record = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let payload = record["payload"] as? [String: Any]
            else { return nil }

            if let model = payload["model"] as? String, !model.isEmpty {
                memo.set(model)
            }

            guard record["type"] as? String == "event_msg",
                  payload["type"] as? String == "token_count",
                  let info = payload["info"] as? [String: Any],
                  let last = info["last_token_usage"] as? [String: Any]
            else { return nil }

            let int = { (key: String) in (last[key] as? NSNumber)?.intValue ?? 0 }
            // Codex reports cached input inside `input_tokens`, so the uncached part is
            // the difference. Getting this wrong prices cache reads at full rate.
            let cached = int("cached_input_tokens")
            let tokens = TokenCounts(
                input: max(0, int("input_tokens") - cached),
                output: int("output_tokens"),
                cacheRead: cached,
                cacheWrite: int("cache_write_input_tokens"),
                reasoning: int("reasoning_output_tokens")
            )
            guard tokens.total > 0 else { return nil }

            guard let stamp = record["timestamp"] as? String, let date = ISO8601.parse(stamp) else { return nil }

            var priced = tokens
            priced.reasoning = 0   // reasoning is already inside output_tokens
            let model = memo.get()
            return JSONLIndex.ParsedLine(
                timestamp: date,
                model: model,
                tokens: tokens,
                costUSD: Pricing.cost(model: model, tokens: priced),
                dedupeKey: nil
            )
        }

        let quota = Self.latestRateLimits(files: files)
        return Result(buckets: buckets, limits: quota.windows, planType: quota.plan, lastActivity: lastActivity)
    }

    /// Scan the tail of the newest rollout for the last `rate_limits` block.
    ///
    /// Only the final few kilobytes are read: quota state is restated on every turn,
    /// so the freshest copy is always near the end of the newest file.
    private static func latestRateLimits(files: [URL]) -> (windows: [LimitWindow], plan: String?) {
        let newest = files
            .compactMap { url -> (URL, Date)? in
                guard let modified = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
                else { return nil }
                return (url, modified)
            }
            .sorted { $0.1 > $1.1 }
            .prefix(6)

        for (url, _) in newest {
            guard let handle = try? FileHandle(forReadingFrom: url) else { continue }
            defer { try? handle.close() }
            let size = (try? handle.seekToEnd()) ?? 0
            let tail: UInt64 = 256 * 1024
            try? handle.seek(toOffset: size > tail ? size - tail : 0)
            guard let data = try? handle.readToEnd() else { continue }

            for line in data.split(separator: UInt8(ascii: "\n")).reversed() {
                guard let record = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                      let payload = record["payload"] as? [String: Any],
                      let limits = payload["rate_limits"] as? [String: Any]
                else { continue }

                var windows: [LimitWindow] = []
                for (key, label) in [("primary", "Primary"), ("secondary", "Weekly")] {
                    guard let window = limits[key] as? [String: Any],
                          let percent = (window["used_percent"] as? NSNumber)?.doubleValue
                    else { continue }
                    let minutes = (window["window_minutes"] as? NSNumber)?.intValue
                    windows.append(LimitWindow(
                        id: "codex-\(key)",
                        label: minutes.map(Self.windowLabel) ?? label,
                        usedFraction: percent / 100,
                        resetsAt: (window["resets_at"] as? NSNumber)
                            .map { Date(timeIntervalSince1970: $0.doubleValue) },
                        windowMinutes: minutes
                    ))
                }
                if windows.isEmpty { continue }
                return (windows, limits["plan_type"] as? String)
            }
        }
        return ([], nil)
    }

    static func windowLabel(_ minutes: Int) -> String {
        switch minutes {
        case ..<60: return "\(minutes)m"
        case ..<1440: return "\(minutes / 60)h window"
        case 10080: return "Weekly"
        default: return "\(minutes / 1440)d window"
        }
    }
}
