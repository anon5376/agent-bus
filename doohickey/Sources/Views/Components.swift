import SwiftUI

/// Keyed on headroom left, so the scale runs the same direction as the bar: full and
/// green, draining to red. Amber at 30% left, red at 10% — a bar that goes red at 60%
/// used teaches you to ignore it.
func severityColor(remaining: Double, accent: Color) -> Color {
    switch remaining {
    case ..<0.10: return Color(red: 0.88, green: 0.36, blue: 0.36)
    case ..<0.30: return Color(red: 0.90, green: 0.64, blue: 0.24)
    default: return accent
    }
}

/// Thin capsule meter. No numbers inside it — they live beside it, where they can be
/// read without fighting the fill for contrast.
/// Draws headroom: a full bar means a full quota, and it empties as you spend.
struct Meter: View {
    var fraction: Double
    var accent: Color
    var height: CGFloat = 5
    /// Only a quota bar earns severity colour. A share-of-total bar that turns red at
    /// the top just means "this is the biggest one", which is not a warning.
    var severity: Bool = true

    private var fill: Color {
        severity ? severityColor(remaining: fraction, accent: accent) : accent
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.primary.opacity(0.08))
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [
                                fill.opacity(0.75),
                                fill,
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: max(fraction > 0 ? 3 : 0, geometry.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: height)
    }
}

/// Hourly bars, one per bucket in the selected range — the same reading as a usage
/// chart on a provider's own dashboard: when the work happened and how it clustered.
/// Normalised to its own peak, so it shows shape and never implies a shared scale with
/// the quota bar above it.
struct UsageBars: View {
    var values: [Double]
    var accent: Color

    var body: some View {
        GeometryReader { geometry in
            let peak = values.max() ?? 0
            let count = max(1, values.count)
            // Hairline gaps at this width; below ~2pt a gap costs more legibility than
            // the separation buys, so the bars simply butt together.
            let spacing: CGFloat = geometry.size.width / CGFloat(count) > 3 ? 1 : 0
            let barWidth = max(1, (geometry.size.width - spacing * CGFloat(count - 1)) / CGFloat(count))

            HStack(alignment: .bottom, spacing: spacing) {
                ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                    let height = peak > 0 ? max(value > 0 ? 1.5 : 0, geometry.size.height * value / peak) : 0
                    RoundedRectangle(cornerRadius: barWidth > 3 ? 1 : 0)
                        .fill(accent.opacity(value > 0 ? 0.85 : 0))
                        .frame(width: barWidth, height: height)
                }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
            .overlay(alignment: .bottom) {
                // A baseline keeps an all-empty range from looking like a render failure.
                Rectangle()
                    .fill(Color.primary.opacity(0.08))
                    .frame(height: 1)
            }
        }
    }
}

/// A label/value pair with the value in tabular figures, so columns of numbers line
/// up as the values change and the panel stops twitching on every refresh.
struct Stat: View {
    var label: String
    var value: String
    var tint: Color?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
                .tracking(0.4)
            Text(value)
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(tint ?? .primary)
        }
    }
}

struct Divider1px: View {
    var body: some View {
        Rectangle()
            .fill(Color.primary.opacity(0.07))
            .frame(height: 1)
    }
}
