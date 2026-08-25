import Foundation

/// List-price table, USD per million tokens.
///
/// Deliberately the same numbers as the broker's `src/pricing.ts`, so a swarm run
/// costed by agent-bus and the same run costed from Claude Code transcripts agree.
/// Overridable at `~/Library/Application Support/Doohickey/pricing.json` for when a
/// rate moves or a model lands that this table has never heard of.
enum Pricing {
    struct Rate: Codable, Sendable {
        var input: Double
        var output: Double
        var cacheRead: Double?
        var cacheWrite: Double?

        func cost(_ tokens: TokenCounts) -> Double {
            let read = cacheRead ?? input * 0.1
            let write = cacheWrite ?? input * 1.25
            let m = { (n: Int) in Double(max(0, n)) / 1_000_000 }
            return m(tokens.input) * input
                + m(tokens.output + tokens.reasoning) * output
                + m(tokens.cacheRead) * read
                + m(tokens.cacheWrite) * write
        }
    }

    /// Longest substring match wins, so `gpt-5-mini` never gets priced as `gpt-5`.
    private static let builtin: [(String, Rate)] = [
        ("claude-opus", Rate(input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75)),
        ("claude-sonnet", Rate(input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75)),
        ("claude-haiku", Rate(input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25)),
        ("claude-3-5-haiku", Rate(input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1)),
        ("gpt-5-codex", Rate(input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: nil)),
        ("gpt-5-mini", Rate(input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: nil)),
        ("gpt-5-nano", Rate(input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: nil)),
        ("gpt-5", Rate(input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: nil)),
        ("gpt-4.1-mini", Rate(input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: nil)),
        ("gpt-4.1", Rate(input: 2, output: 8, cacheRead: 0.5, cacheWrite: nil)),
        ("o3", Rate(input: 2, output: 8, cacheRead: 0.5, cacheWrite: nil)),
        ("gemini-2.5-pro", Rate(input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: nil)),
        ("gemini-2.5-flash", Rate(input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: nil)),
        ("gemini-3", Rate(input: 2, output: 12, cacheRead: 0.5, cacheWrite: nil)),
        ("deepseek", Rate(input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: nil)),
        ("qwen", Rate(input: 0.4, output: 1.2, cacheRead: nil, cacheWrite: nil)),
        ("kimi", Rate(input: 0.6, output: 2.5, cacheRead: nil, cacheWrite: nil)),
        ("glm", Rate(input: 0.6, output: 2.2, cacheRead: nil, cacheWrite: nil)),
        ("llama", Rate(input: 0.2, output: 0.6, cacheRead: nil, cacheWrite: nil)),
    ]

    private static let overrides: [String: Rate] = {
        let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Doohickey/pricing.json")
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([String: Rate].self, from: data)
        else { return [:] }
        return decoded
    }()

    private static var memo: [String: Rate?] = [:]
    private static let lock = NSLock()

    static func rate(for model: String) -> Rate? {
        let needle = model.lowercased()
        lock.lock()
        defer { lock.unlock() }
        if let cached = memo[needle] { return cached }

        var best: Rate?
        var bestLength = 0
        for (key, rate) in overrides where needle.contains(key.lowercased()) && key.count > bestLength {
            best = rate
            bestLength = key.count
        }
        if best == nil {
            for (key, rate) in builtin where needle.contains(key) && key.count > bestLength {
                best = rate
                bestLength = key.count
            }
        }
        memo[needle] = best
        return best
    }

    /// Zero for a model with no known rate — an invented price is worse than a gap,
    /// and the token count is still shown either way.
    static func cost(model: String, tokens: TokenCounts) -> Double {
        rate(for: model)?.cost(tokens) ?? 0
    }
}
