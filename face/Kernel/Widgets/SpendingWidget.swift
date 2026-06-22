import SwiftUI

/// The spending glass widget with a W/M/Y toggle (04-UI-SPEC §5; FIN-05).
///
/// A segmented W / M / Y control (accent ONLY on the active segment); switching
/// animates the series with a spring (nothing snaps). Totals in tabular numerals.
/// Data is computed locally from the encrypted store and arrives as `widget.data` —
/// the widget never touches Plaid. Renders ONLY typed structured fields (T-04-04).
enum SpendTimeframe: String, CaseIterable, Identifiable {
    case W, M, Y
    var id: String { rawValue }
    var label: String { rawValue }
}

/// One series point (day/bucket → spent). Structured-only.
struct SpendPoint: Identifiable, Equatable {
    let id = UUID()
    let bucket: String
    let amount: Double
}

/// The spending payload, decoded defensively from a `JSONValue` (never trusts shape).
struct SpendingPayload: Equatable {
    let timeframe: SpendTimeframe
    let total: Double
    let series: [SpendPoint]
    let errored: Bool

    static func from(_ json: JSONValue?) -> SpendingPayload {
        guard let obj = json?.objectValue else {
            return SpendingPayload(timeframe: .W, total: 0, series: [], errored: false)
        }
        if obj["error"]?.stringValue != nil || (obj["errored"]?.doubleValue ?? 0) == 1 {
            return SpendingPayload(timeframe: .W, total: 0, series: [], errored: true)
        }
        let tf = obj["timeframe"]?.stringValue.flatMap(SpendTimeframe.init(rawValue:)) ?? .W
        let series: [SpendPoint] = (obj["series"]?.arrayValue ?? []).compactMap { entry in
            guard let p = entry.objectValue else { return nil }
            let bucket = p["day"]?.stringValue ?? p["bucket"]?.stringValue ?? ""
            return SpendPoint(bucket: bucket, amount: p["spent"]?.doubleValue ?? p["amount"]?.doubleValue ?? 0)
        }
        return SpendingPayload(timeframe: tf, total: obj["total"]?.doubleValue ?? 0, series: series, errored: false)
    }
}

struct SpendingWidget: View {
    let payload: SpendingPayload
    let isPresented: Bool

    @State private var selected: SpendTimeframe = .W

    var body: some View {
        content
            .padding(Tokens.Space.lg)
            .frame(maxWidth: 360, alignment: .leading)
            .background(Tokens.denseMaterial, in: RoundedRectangle(cornerRadius: Tokens.Radius.widget))
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.Radius.widget)
                    .stroke(Tokens.hairline, lineWidth: 1))
            .scaleEffect(isPresented ? Motion.bloomEndScale : Motion.bloomStartScale)
            .opacity(isPresented ? 1 : 0)
            .blur(radius: isPresented ? 0 : Motion.depthBlurRadius)
            .animation(isPresented ? Motion.bloom : Motion.dissolve, value: isPresented)
            .onAppear { selected = payload.timeframe }
    }

    @ViewBuilder
    private var content: some View {
        if payload.errored {
            Text("Spending unavailable.")
                .font(Tokens.Typography.heading)
                .foregroundStyle(Tokens.textPrimary)
        } else if payload.series.isEmpty && payload.total == 0 {
            VStack(alignment: .leading, spacing: Tokens.Space.md) {
                segmentedControl
                Text("No transactions yet.")
                    .font(Tokens.Typography.body)
                    .foregroundStyle(Tokens.textMuted)
            }
        } else {
            populated
        }
    }

    private var populated: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            segmentedControl
            Text(money(payload.total))
                .font(Tokens.Typography.display)
                .monospacedDigit()                          // tabular total
                .foregroundStyle(Tokens.textPrimary)
            chart
        }
    }

    /// W / M / Y segmented control. Accent ONLY on the active segment; switching springs.
    private var segmentedControl: some View {
        HStack(spacing: Tokens.Space.xs) {
            ForEach(SpendTimeframe.allCases) { tf in
                let isActive = selected == tf
                Button {
                    withAnimation(Motion.cloudState) { selected = tf } // spring; nothing snaps
                } label: {
                    Text(tf.label)
                        .font(Tokens.Typography.label)
                        .foregroundStyle(isActive ? Tokens.canvas : Tokens.textMuted)
                        .padding(.horizontal, Tokens.Space.md)
                        .frame(minHeight: 28)
                        .background(
                            Capsule().fill(isActive ? Tokens.accentCyan : Color.clear)) // accent only when active
                        .overlay(Capsule().stroke(isActive ? Color.clear : Tokens.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44)
            }
        }
    }

    /// A simple structured bar chart over the series (no remote-resource load; SwiftUI shapes).
    private var chart: some View {
        let maxAmount = max(payload.series.map { abs($0.amount) }.max() ?? 1, 1)
        return HStack(alignment: .bottom, spacing: Tokens.Space.xs) {
            ForEach(payload.series) { point in
                Capsule()
                    .fill(Tokens.accentIndigo.opacity(0.7))
                    .frame(width: 8, height: max(4, CGFloat(abs(point.amount) / maxAmount) * 80))
            }
        }
        .frame(height: 80, alignment: .bottom)
        .animation(Motion.cloudState, value: selected)      // series eases between timeframes
    }

    private func money(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: abs(value))) ?? "$\(value)"
    }
}
