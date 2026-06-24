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
            .kernelCard(isPresented: isPresented, maxWidth: 420)
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
            // "Daily spend" header — green marker + the W/M/Y toggle on the trailing edge.
            CardHeader(dot: Tokens.statusGreen, title: "Daily spend") {
                segmentedControl
            }
            // Total + trend delta, with the per-day average on the trailing edge.
            HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.sm) {
                Text(money(payload.total))
                    .font(Tokens.Typography.display)
                    .monospacedDigit()
                    .foregroundStyle(Tokens.textPrimary)
                if let delta = trendDelta { deltaBadge(delta) }
                Spacer(minLength: Tokens.Space.sm)
                if let avg = averagePerDay {
                    Text("avg \(money(avg))/day")
                        .font(Tokens.Typography.monoLabel)
                        .foregroundStyle(Tokens.textMuted)
                }
            }
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
                        .font(Tokens.Typography.monoCaption)
                        .foregroundStyle(isActive ? Tokens.canvas : Tokens.textMuted)
                        .padding(.horizontal, Tokens.Space.sm)
                        .frame(minHeight: 22)
                        .background(
                            Capsule().fill(isActive ? Tokens.accentTerracotta : Color.clear)) // accent only when active
                        .overlay(Capsule().stroke(isActive ? Color.clear : Tokens.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// A ▲/▼ delta pill (the design's green "▲ 12%"). Derived from the series trend; omitted when
    /// the series is too short to compute one.
    private func deltaBadge(_ pct: Double) -> some View {
        let up = pct >= 0
        return HStack(spacing: 2) {
            Image(systemName: up ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
                .font(.system(size: 8))
            Text("\(abs(Int(pct.rounded())))%")
                .font(Tokens.Typography.monoCaption)
                .monospacedDigit()
        }
        .foregroundStyle(Tokens.statusGreen)
        .padding(.horizontal, Tokens.Space.sm)
        .frame(minHeight: 20)
        .background(Capsule().fill(Tokens.statusGreen.opacity(0.14)))
    }

    /// A terracotta area+line chart over the series (SwiftUI Canvas — no remote-resource load).
    private var chart: some View {
        Canvas { ctx, size in
            let series = payload.series
            guard series.count > 1 else { return }
            let maxV = max(series.map { abs($0.amount) }.max() ?? 1, 1)
            let stepX = size.width / CGFloat(series.count - 1)
            func point(_ i: Int) -> CGPoint {
                let v = abs(series[i].amount) / maxV
                return CGPoint(x: CGFloat(i) * stepX, y: size.height * (1 - 0.9 * v) - 4)
            }
            var line = Path()
            line.move(to: point(0))
            for i in 1..<series.count { line.addLine(to: point(i)) }

            var area = line
            area.addLine(to: CGPoint(x: size.width, y: size.height))
            area.addLine(to: CGPoint(x: 0, y: size.height))
            area.closeSubpath()
            ctx.fill(area, with: .linearGradient(
                Gradient(colors: [Tokens.accentTerracotta.opacity(0.35), Tokens.accentTerracotta.opacity(0)]),
                startPoint: CGPoint(x: 0, y: 0),
                endPoint: CGPoint(x: 0, y: size.height)))
            ctx.stroke(line, with: .color(Tokens.accentTerracotta), lineWidth: 2)
            for i in 0..<series.count {
                let p = point(i)
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - 2.5, y: p.y - 2.5, width: 5, height: 5)),
                         with: .color(Tokens.accentBright))
            }
        }
        .frame(height: 84)
        .animation(Motion.cloudState, value: selected)      // series eases between timeframes
    }

    /// Per-day average across the series buckets (nil when there are no buckets).
    private var averagePerDay: Double? {
        guard !payload.series.isEmpty else { return nil }
        return payload.total / Double(payload.series.count)
    }

    /// Trend delta (%) from the first to the last bucket; nil when the series is too short.
    private var trendDelta: Double? {
        let s = payload.series
        guard s.count >= 2 else { return nil }
        let first = abs(s.first!.amount), last = abs(s.last!.amount)
        guard first > 0 else { return nil }
        return (last - first) / first * 100
    }

    private func money(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: abs(value))) ?? "$\(value)"
    }
}
