import Foundation
import SwiftUI

/// Fans out to every provider in the catalogue, folds the results into snapshots and
/// publishes them. Local transcript scans and network calls run together, so one slow
/// provider cannot hold up the rest.
@MainActor
final class Tracker: ObservableObject {
    /// Providers with something to show, busiest quota first.
    @Published private(set) var live: [ProviderSnapshot] = []
    /// Everything else, with the reason: not set up, or nothing to publish.
    @Published private(set) var roster: [ProviderSnapshot] = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var lastRefresh: Date?
    @Published var range: Range = .fiveHours { didSet { Task { await refresh() } } }

    /// History kept on disk, independent of the range on screen, so switching to 30d is
    /// instant instead of triggering a full re-read of every transcript.
    private let horizon: TimeInterval = 31 * 86_400

    private let claudeCode = ClaudeCodeSource()
    private let codex = CodexSource()
    private let cursor = CursorSource()
    private let anthropic = AnthropicSource()
    private let chatGPT = ChatGPTSource()
    private let ollama = OllamaSource()
    private let agentBus = AgentBusSource()

    private var timer: Timer?

    /// The single number the menu bar shows: the least headroom left anywhere.
    var headline: (snapshot: ProviderSnapshot, limit: LimitWindow)? {
        live
            .compactMap { snapshot in snapshot.headlineLimit.map { (snapshot, $0) } }
            .min { $0.1.remainingFraction < $1.1.remainingFraction }
    }

    var meteredCost: Double { live.reduce(0) { $0 + $1.costUSD } }
    var absorbedCost: Double {
        live.filter { $0.billing == .subscription }.reduce(0) { $0 + $1.notionalUSD }
    }
    var totalTokens: Int { live.reduce(0) { $0 + $1.tokens.total } }

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

        async let claudeTask = claudeCode.load(horizon: horizon)
        async let codexTask = codex.load(horizon: horizon)
        async let cursorTask = cursor.load()
        async let anthropicTask = anthropic.load()
        async let chatGPTTask = chatGPT.load()
        async let ollamaTask = ollama.load()
        async let busTask = agentBus.load(range: range)
        async let apiTask = Self.fetchAll(Catalogue.apiBacked)

        let claude = await claudeTask
        let codexData = await codexTask
        let cursorData = await cursorTask
        let anthropicQuota = await anthropicTask
        let chatGPTQuota = await chatGPTTask
        let ollamaData = await ollamaTask
        let bus = await busTask
        let apis = await apiTask

        var built: [ProviderSnapshot] = []

        // MARK: transcript-backed
        if claudeCode.isPresent {
            var snapshot = Self.summarise(
                id: "claude-code", title: "Claude Code", symbol: "asterisk",
                accent: Catalogue.hue.anthropic, buckets: claude.anthropic, range: range
            )
            snapshot.billing = Billing.detectClaudeCode()
            snapshot.lastActivity = claude.lastActivity
            // Real quota when the account will tell us; the reconstruction is only a
            // fallback for when the token is missing or expired.
            if case .ok = anthropicQuota.state, !anthropicQuota.reading.windows.isEmpty {
                snapshot.limits = anthropicQuota.reading.windows
                snapshot.plan = anthropicQuota.reading.plan
                snapshot.detail = anthropicQuota.reading.detail
            } else {
                snapshot.limits = Self.estimatedBlockLimit(buckets: claude.anthropic)
                snapshot.detail = anthropicQuota.statusHint
                    ?? "no quota reading — window inferred from your own history"
            }
            built.append(snapshot)
        }

        if codex.isPresent {
            var snapshot = Self.summarise(
                id: "codex", title: "Codex", symbol: "chevron.left.forwardslash.chevron.right",
                accent: Catalogue.hue.openai, buckets: codexData.buckets, range: range
            )
            snapshot.lastActivity = codexData.lastActivity
            // The rollout's rate_limits block is only as fresh as the last turn; the
            // backend knows the window that is live right now.
            if case .ok = chatGPTQuota.state, !chatGPTQuota.reading.windows.isEmpty {
                snapshot.limits = chatGPTQuota.reading.windows
                snapshot.plan = chatGPTQuota.reading.plan ?? codexData.planType
                snapshot.detail = chatGPTQuota.reading.detail
            } else {
                snapshot.limits = codexData.limits
                snapshot.plan = codexData.planType
                snapshot.detail = chatGPTQuota.statusHint
            }
            snapshot.billing = snapshot.plan == nil ? .metered : .subscription
            built.append(snapshot)
        }

        // MARK: session-backed subscription products
        var cursorSnapshot = ProviderSnapshot(
            id: Catalogue.cursor.id, title: Catalogue.cursor.title,
            symbol: Catalogue.cursor.symbol, accent: Catalogue.cursor.accent,
            state: cursorData.state, billing: .subscription
        )
        Self.apply(cursorData.reading, to: &cursorSnapshot)
        built.append(cursorSnapshot)

        // MARK: API-backed quota and balance
        for (spec, result) in apis {
            var snapshot = ProviderSnapshot(
                id: spec.id, title: spec.title, symbol: spec.symbol,
                accent: spec.accent, state: result.state, billing: spec.billing
            )
            if let reading = result.reading { Self.apply(reading, to: &snapshot) }
            // Traffic the local router forwarded to OpenRouter shows up in the Claude
            // Code transcripts under a namespaced model id; it belongs here.
            if spec.id == "openrouter" {
                let routed = Self.summarise(
                    id: spec.id, title: spec.title, symbol: spec.symbol,
                    accent: spec.accent, buckets: claude.routed, range: range
                )
                snapshot.tokens = routed.tokens
                snapshot.models = routed.models
                snapshot.series = routed.series
                snapshot.messages = routed.messages
                snapshot.lastActivity = claude.lastActivity
            }
            built.append(snapshot)
        }

        // MARK: local runtimes
        if let reading = ollamaData {
            var snapshot = ProviderSnapshot(
                id: Catalogue.ollama.id, title: Catalogue.ollama.title,
                symbol: Catalogue.ollama.symbol, accent: Catalogue.ollama.accent, state: .ok
            )
            Self.apply(reading, to: &snapshot)
            built.append(snapshot)
        }

        // MARK: the broker's own ledger
        if agentBus.isPresent {
            var snapshot = ProviderSnapshot(
                id: "agent-bus", title: "Agent Bus", symbol: "bus",
                accent: Catalogue.hue.bus, state: bus.brokerUp ? .ok : .offline("broker offline")
            )
            snapshot.tokens = bus.byModel.reduce(TokenCounts()) { $0 + $1.tokens }
            snapshot.costUSD = bus.costUSD
            snapshot.notionalUSD = bus.notionalUSD
            snapshot.messages = bus.events
            snapshot.models = bus.byAgent          // agents are the interesting axis here
            snapshot.series = bus.series
            if bus.brokerUp && bus.events == 0 {
                snapshot.detail = "ledger empty — agents have not reported this window"
            } else if bus.notionalUSD > bus.costUSD {
                snapshot.detail = "+\(Format.money(bus.notionalUSD - bus.costUSD)) absorbed by subscription plans"
            }
            built.append(snapshot)
        }

        // MARK: known-but-silent providers
        for spec in Catalogue.unsupported {
            let configured = spec.credentials.isEmpty ? false : spec.credential() != nil
            built.append(ProviderSnapshot(
                id: spec.id, title: spec.title, symbol: spec.symbol, accent: spec.accent,
                state: configured ? .noUsageAPI : .notConfigured,
                detail: spec.note
            ))
        }

        let finalised = built.map(Self.finalise)
        // Least headroom first — the quota about to interrupt you belongs at the top.
        live = finalised.filter { $0.isLive && $0.hasNumbers }.sorted { a, b in
            let left = a.headlineLimit?.remainingFraction ?? 2
            let right = b.headlineLimit?.remainingFraction ?? 2
            if left != right { return left < right }
            return a.tokens.total > b.tokens.total
        }
        roster = finalised.filter { !($0.isLive && $0.hasNumbers) }
            .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        lastRefresh = Date()
        Self.writeStatusDump(live: live, roster: roster)
    }

    /// A plain-text dump of the last refresh, written next to the index caches.
    ///
    /// A menu bar app has nowhere to print, and "the keychain read failed" looks exactly
    /// like "you have plenty of quota left" if the fallback silently produces an estimate.
    /// This makes the difference inspectable without attaching a debugger.
    private static func writeStatusDump(live: [ProviderSnapshot], roster: [ProviderSnapshot]) {
        var lines = ["Doohickey status — \(Date())", ""]
        for snapshot in live {
            let quota = snapshot.limits.map {
                "\($0.label)=\(Int(($0.remainingFraction * 100).rounded()))% left\($0.isEstimate ? " (est)" : "")"
            }.joined(separator: ", ")
            lines.append("\(snapshot.title): state=\(snapshot.state) plan=\(snapshot.plan ?? "-")")
            lines.append("   quota: \(quota.isEmpty ? "none" : quota)")
            lines.append("   tokens=\(Format.tokens(snapshot.tokens.total)) cost=\(Format.money(snapshot.displayCost)) \(snapshot.billing.rawValue)")
            if let detail = snapshot.detail { lines.append("   note: \(detail)") }
        }
        lines.append("")
        for snapshot in roster {
            lines.append("\(snapshot.title): \(snapshot.statusNote ?? "-") — \(snapshot.detail ?? "")")
        }
        let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Doohickey/status.txt")
        try? lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    func resetCaches() async {
        await JSONLIndex(name: "claude-code").reset()
        await JSONLIndex(name: "codex").reset()
        await refresh()
    }

    // MARK: - Assembly

    private static func fetchAll(_ specs: [ProviderSpec]) async -> [(ProviderSpec, (state: ProviderState, reading: Reading?))] {
        await withTaskGroup(of: (ProviderSpec, (state: ProviderState, reading: Reading?)).self) { group in
            for spec in specs {
                group.addTask { (spec, await ProviderFetcher.fetch(spec)) }
            }
            var results: [(ProviderSpec, (state: ProviderState, reading: Reading?))] = []
            for await result in group { results.append(result) }
            // Task groups complete out of order; keep the catalogue's order for stability.
            return results.sorted { first, second in
                (specs.firstIndex { $0.id == first.0.id } ?? 0) < (specs.firstIndex { $0.id == second.0.id } ?? 0)
            }
        }
    }

    private static func apply(_ reading: Reading, to snapshot: inout ProviderSnapshot) {
        snapshot.limits = reading.windows
        snapshot.balanceUSD = reading.balanceUSD
        snapshot.limitUSD = reading.limitUSD
        snapshot.plan = reading.plan
        if let detail = reading.detail { snapshot.detail = detail }
        if let used = reading.usedUSD, snapshot.billing == .metered {
            snapshot.costUSD = used
            snapshot.notionalUSD = used
        }
    }

    /// A subscription bills nothing per call, so its metered figure is zero and the
    /// list-price total moves to `notionalUSD`.
    private static func finalise(_ snapshot: ProviderSnapshot) -> ProviderSnapshot {
        var copy = snapshot
        if copy.billing == .subscription { copy.costUSD = 0 }
        return copy
    }

    private static func summarise(
        id: String, title: String, symbol: String, accent: Color,
        buckets: [HourBucket], range: Range
    ) -> ProviderSnapshot {
        let cutoffHour = Int((Date().timeIntervalSince1970 - range.seconds) / 3600)
        let inRange = buckets.filter { $0.hour >= cutoffHour }

        var snapshot = ProviderSnapshot(id: id, title: title, symbol: symbol, accent: accent, state: .ok)
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
        // Priced at list rate here; the caller decides whether that is a bill or a
        // hypothetical by setting `billing`, which `finalise` then applies.
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
            // slot that hour starts in. Fine for a bar chart, and honest about it.
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
    /// Reporting it as rolling produces a reset time that is always about to happen.
    ///
    /// The percentage is against the busiest block in retained history rather than a real
    /// cap, because the cap is not published anywhere. It is labelled `est` on screen.
    private static func estimatedBlockLimit(buckets: [HourBucket]) -> [LimitWindow] {
        guard !buckets.isEmpty else { return [] }

        var byHour: [Int: Int] = [:]
        for bucket in buckets {
            byHour[bucket.hour, default: 0] += bucket.tokens.billableish
        }
        let active = byHour.filter { $0.value > 0 }.keys.sorted()
        guard !active.isEmpty else { return [] }

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
}
