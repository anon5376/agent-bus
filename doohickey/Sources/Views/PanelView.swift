import SwiftUI

struct PanelView: View {
    @EnvironmentObject private var tracker: Tracker
    @State private var expanded: Set<String> = []
    @State private var showRoster = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider1px()

            ScrollView {
                // Not lazy: a handful of providers, and a lazy container here buys
                // nothing while costing a viewport dependency.
                VStack(spacing: 0) {
                    ForEach(tracker.live) { snapshot in
                        ProviderRow(
                            snapshot: snapshot,
                            isExpanded: expanded.contains(snapshot.id),
                            toggle: { toggle(snapshot.id) }
                        )
                        Divider1px()
                    }
                    roster
                }
            }
            .frame(maxHeight: 480)

            Divider1px()
            footer
        }
        .frame(width: 380)
        .background(.regularMaterial)
    }

    private func toggle(_ id: String) {
        withAnimation(.snappy(duration: 0.18)) {
            if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Doohickey")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                Spacer()
                VStack(alignment: .trailing, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(Format.money(tracker.meteredCost))
                            .font(.system(size: 17, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                        Text(Format.tokens(tracker.totalTokens))
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    if tracker.absorbedCost > 0 {
                        Text("+\(Format.money(tracker.absorbedCost)) on plan")
                            .font(.system(size: 10))
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            Picker("", selection: Binding(get: { tracker.range }, set: { tracker.range = $0 })) {
                ForEach(Range.allCases) { range in Text(range.rawValue).tag(range) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 10)
    }

    /// Everything with nothing to report, and why. Collapsed by default — the point is
    /// that a missing provider is explained rather than silently absent.
    @ViewBuilder
    private var roster: some View {
        if !tracker.roster.isEmpty {
            Button {
                withAnimation(.snappy(duration: 0.18)) { showRoster.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .rotationEffect(.degrees(showRoster ? 90 : 0))
                    Text("\(tracker.roster.count) more providers")
                        .font(.system(size: 10, weight: .medium))
                    Spacer()
                }
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if showRoster {
                VStack(spacing: 0) {
                    ForEach(tracker.roster) { snapshot in
                        HStack(spacing: 8) {
                            Image(systemName: snapshot.symbol)
                                .font(.system(size: 9))
                                .foregroundStyle(snapshot.accent.opacity(0.55))
                                .frame(width: 14)
                            Text(snapshot.title)
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(snapshot.detail ?? snapshot.statusNote ?? "")
                                .font(.system(size: 9))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 4)
                    }
                }
                .padding(.bottom, 6)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if tracker.isRefreshing {
                ProgressView().controlSize(.mini).scaleEffect(0.7)
            }
            Text(tracker.isRefreshing ? "refreshing" : "updated \(Format.relative(tracker.lastRefresh))")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)

            Spacer()

            Button { Task { await tracker.refresh() } } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .help("Refresh now")

            Menu {
                Button("Retry keychain read") { Task { await tracker.retryKeychain() } }
                Button("Rebuild index from scratch") { Task { await tracker.resetCaches() } }
                Divider()
                Button("Quit Doohickey") { NSApp.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

struct ProviderRow: View {
    var snapshot: ProviderSnapshot
    var isExpanded: Bool
    var toggle: () -> Void

    private var canExpand: Bool { !snapshot.models.isEmpty || snapshot.limits.count > 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: snapshot.symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(snapshot.accent)
                    .frame(width: 16)

                Text(snapshot.title)
                    .font(.system(size: 12, weight: .semibold))

                if let note = snapshot.statusNote {
                    Text(note)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                } else if let plan = snapshot.plan {
                    Text(plan)
                        .font(.system(size: 9, weight: .medium))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(snapshot.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 3))
                        .foregroundStyle(snapshot.accent)
                }

                Spacer()

                // A credit balance is the headline where one exists; otherwise spend.
                if let balance = snapshot.balanceUSD {
                    Text("\(Format.money(balance)) left")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .monospacedDigit()
                } else {
                    Text(Format.money(snapshot.displayCost))
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(snapshot.billing == .metered ? .primary : .secondary)
                    if snapshot.billing == .subscription {
                        Text("on plan")
                            .font(.system(size: 8, weight: .semibold))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 3))
                            .foregroundStyle(.tertiary)
                    }
                }

                if canExpand {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
            }

            if let limit = snapshot.headlineLimit {
                VStack(spacing: 4) {
                    Meter(fraction: limit.remainingFraction, accent: snapshot.accent)
                    HStack(spacing: 4) {
                        Text("\(Int((limit.remainingFraction * 100).rounded()))% left")
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(severityColor(remaining: limit.remainingFraction, accent: snapshot.accent))
                        Text(limit.label.lowercased())
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                        if limit.isEstimate {
                            Text("est")
                                .font(.system(size: 8, weight: .bold))
                                .padding(.horizontal, 3)
                                .padding(.vertical, 1)
                                .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 3))
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        if let resets = limit.resetsInText {
                            Text(resets).font(.system(size: 10)).foregroundStyle(.tertiary)
                        }
                    }
                }
            }

            if snapshot.tokens.total > 0 {
                HStack(alignment: .bottom, spacing: 14) {
                    Stat(label: "tokens", value: Format.tokens(snapshot.tokens.total), tint: nil)
                    Stat(label: "out", value: Format.tokens(snapshot.tokens.output), tint: nil)
                    Stat(label: "cached", value: Format.tokens(snapshot.tokens.cacheRead), tint: nil)
                    Spacer()
                    UsageBars(values: snapshot.series, accent: snapshot.accent)
                        .frame(width: 104, height: 26)
                }
            }

            if let detail = snapshot.detail {
                Text(detail).font(.system(size: 10)).foregroundStyle(.tertiary)
            }

            if isExpanded { breakdown }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .onTapGesture { if canExpand { toggle() } }
    }

    private var breakdown: some View {
        VStack(alignment: .leading, spacing: 5) {
            Divider1px().padding(.vertical, 2)

            if !snapshot.models.isEmpty {
                let peak = snapshot.models.map(\.tokens.total).max() ?? 1
                ForEach(snapshot.models.prefix(8)) { entry in
                    HStack(spacing: 8) {
                        Text(shortName(entry.model))
                            .font(.system(size: 10, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(width: 130, alignment: .leading)
                            .foregroundStyle(.secondary)
                        Meter(
                            fraction: Double(entry.tokens.total) / Double(max(1, peak)),
                            accent: snapshot.accent, height: 3, severity: false
                        )
                        Text(Format.tokens(entry.tokens.total))
                            .font(.system(size: 10, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .frame(width: 44, alignment: .trailing)
                        Text(Format.money(entry.costUSD))
                            .font(.system(size: 10, design: .rounded))
                            .monospacedDigit()
                            .frame(width: 52, alignment: .trailing)
                    }
                }
                if snapshot.models.count > 8 {
                    Text("+\(snapshot.models.count - 8) more")
                        .font(.system(size: 9)).foregroundStyle(.tertiary)
                }
            }

            if snapshot.limits.count > 1 {
                if !snapshot.models.isEmpty { Divider1px().padding(.vertical, 2) }
                ForEach(snapshot.limits) { limit in
                    HStack(spacing: 8) {
                        Text(limit.label)
                            .font(.system(size: 10))
                            .frame(width: 130, alignment: .leading)
                            .foregroundStyle(.secondary)
                        Meter(fraction: limit.remainingFraction, accent: snapshot.accent, height: 3)
                        Text("\(Int((limit.remainingFraction * 100).rounded()))%")
                            .font(.system(size: 10, design: .rounded))
                            .monospacedDigit()
                            .frame(width: 34, alignment: .trailing)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if snapshot.messages > 0 {
                Text("\(snapshot.messages) calls · last activity \(Format.relative(snapshot.lastActivity))")
                    .font(.system(size: 9)).foregroundStyle(.tertiary).padding(.top, 1)
            }
        }
    }

    /// `anthropic/claude-opus-4-5-20260101` reads as `claude-opus-4-5` in a 130pt column.
    private func shortName(_ model: String) -> String {
        var name = model.split(separator: "/").last.map(String.init) ?? model
        if let match = name.range(of: #"-20\d{6}$"#, options: .regularExpression) {
            name.removeSubrange(match)
        }
        return name
    }
}
