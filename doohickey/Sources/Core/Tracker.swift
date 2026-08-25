import Foundation
import SwiftUI

/// Fans out to every source, folds the results into snapshots and publishes them.
@MainActor
final class Tracker: ObservableObject {
    @Published private(set) var snapshots: [ProviderSnapshot] = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var lastRefresh: Date?
    @Published var range: Range = .fiveHours { didSet { Task { await refresh() } } }

    /// History kept on disk, independent of the range on screen, so switching to 30d
    /// is instant instead of triggering a full re-read of every transcript.
    private let horizon: TimeInterval = 31 * 86_400

    private let claudeCode = ClaudeCodeSource()
    private let codex = CodexSource()
    private let openRouter = OpenRouterSource()
    private let agentBus = AgentBusSource()

    private var timer: Timer?

    /// The single number the menu bar shows: whichever quota has the least headroom
    /// left, across every provider. That is the one about to interrupt you.
    var headline: (kind: ProviderKind, limit: LimitWindow)? {
        snapshots
            .compactMap { snapshot in snapshot.headlineLimit.map { (snapshot.kind, $0) } }
            .min { $0.1.remainingFraction < $1.1.remainingFraction }
    }

    /// Money that will appear on a bill.
    var meteredCost: Double { snapshots.reduce(0) { $0 + $1.costUSD } }
    /// Money that would have appeared on a bill without the flat-rate plans.
    var absorbedCost: Double {
        snapshots.filter { $0.billing == .subscription }.reduce(0) { $0 + $1.notionalUSD }
    }
    var totalTokens: Int { snapshots.reduce(0) { $0 + $1.tokens.total } }

    func start(interval: TimeInterval = 60) {
        Task { await refresh() }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        let range = self.range
        let horizon = self.horizon

        // Every source is independent; run them together so a slow network call does
        // not hold up the local file scans.
        async let claudeResult = claudeCode.load(horizon: horizon)
        async let codexResult = codex.load(horizon: horizon)
        async let busResult = agentBus.load(range: range)
        async let accountResult: OpenRouterSource.Account? = try? await openRouter.load()

        let claude = await claudeResult
        let codexData = await codexResult
        let bus = await busResult
        let account = await accountResult

        var built: [ProviderSnapshot] = []

        if claudeCode.isPresent {
            var snapshot = Self.summarise(.claudeCode, buckets: claude.anthropic, range: range)
            snapshot.billing = Billing.detectClaudeCode()
            snapshot.lastActivity = claude.lastActivity
            snapshot.limits = Self.estimatedBlockLimit(buckets: claude.anthropic)
            snapshot.detail = "no quota API — window inferred from your own history"
            built.append(snapshot)
        }

        if codex.isPresent {
            var snapshot = Self.summarise(.codex, buckets: codexData.buckets, range: range)
            // Codex states its own plan; a plan_type means the tokens are prepaid.
            snapshot.billing = codexData.planType == nil ? .metered : .subscription
            snapshot.lastActivity = codexData.lastActivity
            snapshot.limits = codexData.limits
            snapshot.detail = codexData.planType.map { "plan: \($0)" }
            built.append(snapshot)
        }

        if openRouter.isPresent {
            var snapshot = Self.summarise(.openRouter, buckets: claude.routed, range: range)
            snapshot.lastActivity = claude.lastActivity
            if let account {
                // OpenRouter's own dollars are authoritative; the transcript-derived
                // estimate only supplies the model breakdown below.
                snapshot.costUSD = Self.spend(account, range: range)
                snapshot.notionalUSD = snapshot.costUSD
                if let limit = account.limit, limit > 0 {
                    snapshot.limits = [LimitWindow(
                        id: "openrouter-credit",
                        label: "Credit limit",
                        usedFraction: 1 - max(0, (account.limitRemaining ?? 0) / limit),
                        resetsAt: nil,
                        windowMinutes: nil
                    )]
                }
                snapshot.detail = account.isFreeTier
                    ? "free tier · $\(String(format: "%.2f", account.usageTotal)) lifetime"
                    : "$\(String(format: "%.2f", account.usageTotal)) lifetime"
            } else {
                snapshot.error = "key unreadable or offline"
            }
            built.append(snapshot)
        }

        if agentBus.isPresent {
            var snapshot = ProviderSnapshot(kind: .agentBus, isPresent: true)
            snapshot.tokens = bus.byModel.reduce(TokenCounts()) { $0 + $1.tokens }
            snapshot.costUSD = bus.costUSD
            snapshot.notionalUSD = bus.notionalUSD
            snapshot.messages = bus.events
            snapshot.models = bus.byAgent          // agents are the interesting axis here
            snapshot.series = bus.series
            if !bus.brokerUp {
                snapshot.error = "broker offline"
            } else if bus.events == 0 {
                snapshot.detail = "ledger empty — agents have not reported this window"
            } else if bus.notionalUSD > bus.costUSD {
                snapshot.detail = "+\(Format.money(bus.notionalUSD - bus.costUSD)) absorbed by subscription plans"
            }
            built.append(snapshot)
        }

        snapshots = built.map(Self.finalise)
        lastRefresh = Date()
    }

    func resetCaches() async {
        // Only reachable from the menu; forces a full re-read on the next tick.
        await JSONLIndex(name: "claude-code").reset()
        await JSONLIndex(name: "codex").reset()
        await refresh()
    }

    /// A subscription bills nothing per call, so its metered figure is zero and the
    /// list-price total moves to `notionalUSD`.
    private static func finalise(_ snapshot: ProviderSnapshot) -> ProviderSnapshot {
        var copy = snapshot
        if copy.billing == .subscription { copy.costUSD = 0 }
        return copy
    }

    // MARK: - Aggregation

    private static func summarise(_ kind: ProviderKind, buckets: [HourBucket], range: Range) -> ProviderSnapshot {
        let cutoffHour = Int((Date().timeIntervalSince1970 - range.seconds) / 3600)
        let inRange = buckets.filter { $0.hour >= cutoffHour }

        var snapshot = ProviderSnapshot(kind: kind, isPresent: true)
        var byModel: [String: ModelTotal] = [:]

        for bucket in inRange {
            snapshot.tokens += bucket.tokens
            snapshot.costUSD += bucket.costUSD
            snapshot.messages += bucket.messages
            var total = byModel[bucket.model] ?? ModelTotal(
                model: bucket.model, tokens: TokenCounts(), costUSD: 0, messages: 0
            )
            total.tokens += bucket.tokens
            total.costUSD += bucket.costUSD
            total.messages += bucket.messages
            byModel[bucket.model] = total
        }

        snapshot.models = byModel.values.sorted { $0.tokens.total > $1.tokens.total }
        snapshot.series = series(inRange, range: range)
        // `summarise` prices everything at list rate; the caller decides whether that
        // is a bill or a hypothetical by setting `billing`, which `finalise` applies.
        snapshot.notionalUSD = snapshot.costUSD
        return snapshot
    }

    private static func series(_ buckets: [HourBucket], range: Range) -> [Double] {
        let count = range.bucketCount
        let now = Date().timeIntervalSince1970
        let start = now - range.seconds
        let width = range.seconds / Double(count)
        var slots = [Double](repeating: 0, count: count)

        for bucket in buckets {
            // Hourly granularity into sub-hour slots: everything in an hour lands in the
            // slot that hour starts in. Fine for a sparkline, and honest about it.
            let stamp = Double(bucket.hour) * 3600
            guard stamp >= start else { continue }
            let slot = min(count - 1, max(0, Int((stamp - start) / width)))
            slots[slot] += Double(bucket.tokens.billableish)
        }
        return slots
    }

    /// Claude Code publishes no quota state at all, so the 5-hour block is reconstructed.
    ///
    /// The window is not a rolling five hours: a block is anchored to the first activity
    /// after an idle gap of five hours or more, and expires five hours after that anchor.
    /// Reporting it as rolling produces a reset time that is always about to happen,
    /// which is worse than no reset time.
    ///
    /// The percentage is against the busiest block in the retained history rather than a
    /// real cap, because the cap is not published anywhere. It is a relative gauge and is
    /// labelled `est` wherever it is shown.
    private static func estimatedBlockLimit(buckets: [HourBucket]) -> [LimitWindow] {
        guard !buckets.isEmpty else { return [] }

        var byHour: [Int: Int] = [:]
        for bucket in buckets {
            byHour[bucket.hour, default: 0] += bucket.tokens.billableish
        }
        let active = byHour.filter { $0.value > 0 }.keys.sorted()
        guard !active.isEmpty else { return [] }

        // Split activity into blocks, carrying the busiest total as the reference peak.
        var peak = 0
        var blockStart = active[0]
        var blockTotal = 0
        for hour in active {
            if hour - blockStart >= 5 {
                peak = max(peak, blockTotal)
                blockStart = hour
                blockTotal = 0
            }
            blockTotal += byHour[hour] ?? 0
        }
        peak = max(peak, blockTotal)
        guard peak > 0 else { return [] }

        let currentHour = Int(Date().timeIntervalSince1970 / 3600)
        // The last block has expired if five hours have passed since it was anchored;
        // there is then no live window to report.
        guard currentHour - blockStart < 5 else { return [] }

        return [LimitWindow(
            id: "claude-5h",
            label: "5h block",
            usedFraction: Double(blockTotal) / Double(peak),
            resetsAt: Date(timeIntervalSince1970: Double(blockStart + 5) * 3600),
            windowMinutes: 300,
            isEstimate: true
        )]
    }

    private static func spend(_ account: OpenRouterSource.Account, range: Range) -> Double {
        switch range {
        case .fiveHours, .day: return account.usageDaily
        case .week: return account.usageWeekly
        case .month: return account.usageMonthly
        }
    }
}
