import SwiftUI

@main
struct DoohickeyApp: App {
    @StateObject private var tracker = Tracker()

    var body: some Scene {
        MenuBarExtra {
            PanelView()
                .environmentObject(tracker)
        } label: {
            MenuBarLabel(tracker: tracker)
        }
        .menuBarExtraStyle(.window)
    }
}

/// The menu bar shows exactly one thing: how much is left on the quota closest to
/// running out, whichever provider it belongs to. Everything else is one click away.
/// A bar that tries to show four numbers at once is a bar nobody reads.
struct MenuBarLabel: View {
    @ObservedObject var tracker: Tracker

    var body: some View {
        HStack(spacing: 3) {
            if let headline = tracker.headline {
                Image(systemName: headline.kind.symbol)
                    .font(.system(size: 10, weight: .semibold))
                Text("\(Int((headline.limit.remainingFraction * 100).rounded()))%")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .monospacedDigit()
            } else {
                Image(systemName: "gauge.with.dots.needle.33percent")
                    .font(.system(size: 11, weight: .medium))
            }
        }
        .onAppear { tracker.start() }
    }
}
