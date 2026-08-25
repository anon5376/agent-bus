import Foundation
import SwiftUI

/// How a provider's usage is paid for. The distinction matters more than it looks:
/// on a flat-rate plan the dollar figure is not a bill, it is what the same tokens
/// would have cost metered. Presenting the two as one number is how a tracker ends up
/// telling someone they spent eleven thousand dollars last month.
enum Billing: String, Codable, Sendable {
    case metered
    case subscription

    var note: String {
        switch self {
        case .metered: return "billed"
        case .subscription: return "on plan"
        }
    }
}

/// A quota window that resets — the thing you actually care about on a plan.
struct LimitWindow: Identifiable, Codable, Sendable {
    var id: String
    var label: String
    /// 0…1. Values outside the range are clamped by `remainingFraction`.
    var usedFraction: Double
    var resetsAt: Date?
    var windowMinutes: Int?
    /// Set when the number is inferred locally rather than reported by the provider.
    var isEstimate: Bool = false

    /// What the panel shows. Quota reads as headroom left, not ground covered —
    /// "18% left" answers the question you open the app with, where "82% used" makes
    /// you do the subtraction yourself.
    var remainingFraction: Double { max(0, min(1, 1 - usedFraction)) }

    var resetsInText: String? {
        guard let resetsAt else { return nil }
        let remaining = resetsAt.timeIntervalSinceNow
        if remaining <= 0 { return "resetting" }
        return "resets in " + Format.duration(remaining)
    }
}

struct TokenCounts: Codable, Sendable, Equatable {
    var input: Int = 0
    var output: Int = 0
    var cacheRead: Int = 0
    var cacheWrite: Int = 0
    var reasoning: Int = 0

    var total: Int { input + output + cacheRead + cacheWrite }
    /// Tokens that were actually generated or freshly read — the honest "work" number,
    /// since cache reads inflate totals by an order of magnitude on long sessions.
    var billableish: Int { input + output + cacheWrite }

    static func + (lhs: TokenCounts, rhs: TokenCounts) -> TokenCounts {
        TokenCounts(
            input: lhs.input + rhs.input,
            output: lhs.output + rhs.output,
            cacheRead: lhs.cacheRead + rhs.cacheRead,
            cacheWrite: lhs.cacheWrite + rhs.cacheWrite,
            reasoning: lhs.reasoning + rhs.reasoning
        )
    }

    static func += (lhs: inout TokenCounts, rhs: TokenCounts) { lhs = lhs + rhs }
}

/// One hour of activity for one model. The unit everything is aggregated into,
/// small enough to keep months of history in a few hundred kilobytes.
struct HourBucket: Codable, Sendable {
    var hour: Int          // hours since epoch
    var model: String
    var tokens: TokenCounts
    var costUSD: Double
    var messages: Int
}

struct ModelTotal: Identifiable, Sendable {
    var id: String { model }
    var model: String
    var tokens: TokenCounts
    var costUSD: Double
    var messages: Int
}

/// Everything the panel knows about one provider after a refresh.
struct ProviderSnapshot: Identifiable, Sendable {
    var id: String
    var title: String
    var symbol: String
    var accent: Color
    var state: ProviderState
    var billing: Billing = .metered

    /// Quota windows, expressed as headroom by `remainingFraction`.
    var limits: [LimitWindow] = []
    /// Credit left, for providers that meter against a balance rather than a window.
    var balanceUSD: Double?
    var limitUSD: Double?

    var tokens: TokenCounts = TokenCounts()
    var costUSD: Double = 0
    var notionalUSD: Double = 0
    var messages: Int = 0
    var models: [ModelTotal] = []
    /// Evenly spaced, oldest first, covering the selected range.
    var series: [Double] = []
    var plan: String?
    var detail: String?
    var lastActivity: Date?

    /// The window to headline: whichever has the least room left.
    var headlineLimit: LimitWindow? {
        limits.min { $0.remainingFraction < $1.remainingFraction }
    }

    var displayCost: Double { billing == .metered ? costUSD : notionalUSD }

    /// Whether there is a number worth showing. Drives whether the row lands in the
    /// main list or the collapsed roster underneath it.
    var isLive: Bool {
        switch state {
        case .ok, .offline, .failed: return true
        case .notConfigured, .noUsageAPI: return false
        }
    }

    var statusNote: String? {
        switch state {
        case .ok: return nil
        case .notConfigured: return "not set up"
        case .noUsageAPI: return "no usage API"
        case .offline(let why), .failed(let why): return why
        }
    }

    /// Whether the row earns a place in the main list. A usage-based plan with no
    /// ceiling (Cursor) reports a plan and a running count but no window to draw — that
    /// is still a working, configured provider and belongs above the fold, not filed
    /// under "not set up".
    var hasNumbers: Bool {
        !limits.isEmpty || balanceUSD != nil || tokens.total > 0 || plan != nil
    }
}

enum Range: String, CaseIterable, Identifiable, Sendable {
    case fiveHours = "5h"
    case day = "24h"
    case week = "7d"
    case month = "30d"

    var id: String { rawValue }

    var seconds: TimeInterval {
        switch self {
        case .fiveHours: return 5 * 3600
        case .day: return 24 * 3600
        case .week: return 7 * 86_400
        case .month: return 30 * 86_400
        }
    }

    var bucketCount: Int {
        switch self {
        case .fiveHours: return 30
        case .day: return 24
        case .week: return 28
        case .month: return 30
        }
    }
}

enum Format {
    static func tokens(_ value: Int) -> String {
        let n = Double(value)
        switch abs(n) {
        case 1_000_000_000...: return String(format: "%.2fB", n / 1_000_000_000)
        case 1_000_000...: return String(format: "%.1fM", n / 1_000_000)
        case 10_000...: return String(format: "%.0fK", n / 1_000)
        case 1_000...: return String(format: "%.1fK", n / 1_000)
        default: return String(Int(n))
        }
    }

    static func money(_ value: Double) -> String {
        if value == 0 { return "$0" }
        if value < 0.01 { return String(format: "$%.4f", value) }
        if value < 100 { return String(format: "$%.2f", value) }
        return String(format: "$%.0f", value)
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let total = Int(max(0, seconds))
        let days = total / 86_400
        let hours = (total % 86_400) / 3600
        let minutes = (total % 3600) / 60
        if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
        if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        return "\(max(1, minutes))m"
    }

    static func relative(_ date: Date?) -> String {
        guard let date else { return "never" }
        let elapsed = -date.timeIntervalSinceNow
        if elapsed < 60 { return "just now" }
        return duration(elapsed) + " ago"
    }

    static func bytes(_ value: Double) -> String {
        switch abs(value) {
        case 1_000_000_000...: return String(format: "%.1fGB", value / 1_000_000_000)
        case 1_000_000...: return String(format: "%.0fMB", value / 1_000_000)
        default: return String(format: "%.0fKB", value / 1_000)
        }
    }
}

extension Billing {
    /// Claude Code signs in with OAuth against a Pro/Max plan by default; an API key in
    /// the environment is the exception and means metered billing. Deliberately not read
    /// from the Keychain — an unsigned menu bar app prompting for Keychain access on
    /// first launch is worse than the heuristic being occasionally wrong.
    ///
    /// Override with `{"claudeCode":"metered"}` in
    /// `~/Library/Application Support/Doohickey/billing.json`.
    static func detectClaudeCode() -> Billing {
        if let override = overrides["claudeCode"] { return override }
        let environment = ProcessInfo.processInfo.environment
        if let key = environment["ANTHROPIC_API_KEY"], !key.isEmpty { return .metered }
        if let key = environment["ANTHROPIC_AUTH_TOKEN"], !key.isEmpty { return .metered }
        return .subscription
    }

    private static let overrides: [String: Billing] = {
        let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Doohickey/billing.json")
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([String: Billing].self, from: data)
        else { return [:] }
        return decoded
    }()
}
