import SwiftUI

/// The accounts (balances) glass widget (04-UI-SPEC §4; FIN).
///
/// Read-only — NO action chips. Each account row shows a name + masked tail and a
/// right-aligned balance in tabular (monospacedDigit) numerals that counts up on
/// appear. NEVER renders a full account/card number (only the masked tail). Renders
/// ONLY typed structured fields from the `widget.data` payload (T-04-04).
struct AccountRow: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let tail: String        // masked tail only (e.g. "4321") — never the full number
    let balance: Double
}

/// The accounts payload, decoded defensively from a `JSONValue` (never trusts shape).
struct AccountsPayload: Equatable {
    let accounts: [AccountRow]
    let errored: Bool

    var total: Double { accounts.reduce(0) { $0 + $1.balance } }

    static func from(_ json: JSONValue?) -> AccountsPayload {
        guard let obj = json?.objectValue else { return AccountsPayload(accounts: [], errored: false) }
        if obj["error"]?.stringValue != nil || (obj["errored"]?.doubleValue ?? 0) == 1 {
            return AccountsPayload(accounts: [], errored: true)
        }
        let rows: [AccountRow] = (obj["accounts"]?.arrayValue ?? []).compactMap { entry in
            guard let a = entry.objectValue, let name = a["name"]?.stringValue else { return nil }
            return AccountRow(
                name: name,
                tail: a["tail"]?.stringValue ?? "",
                balance: a["balance"]?.doubleValue ?? 0)
        }
        return AccountsPayload(accounts: rows, errored: false)
    }
}

struct AccountsWidget: View {
    let payload: AccountsPayload
    let isPresented: Bool

    var body: some View {
        content
            .padding(Tokens.Space.lg)
            .frame(maxWidth: 360, alignment: .leading)
            .background(Tokens.widgetMaterial, in: RoundedRectangle(cornerRadius: Tokens.Radius.widget))
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.Radius.widget)
                    .stroke(Tokens.hairline, lineWidth: 1))
            .scaleEffect(isPresented ? Motion.bloomEndScale : Motion.bloomStartScale)
            .opacity(isPresented ? 1 : 0)
            .blur(radius: isPresented ? 0 : Motion.depthBlurRadius)
            .animation(isPresented ? Motion.bloom : Motion.dissolve, value: isPresented)
    }

    @ViewBuilder
    private var content: some View {
        if payload.errored {
            Text("Balances unavailable.")
                .font(Tokens.Typography.heading)
                .foregroundStyle(Tokens.textPrimary)
        } else if payload.accounts.isEmpty {
            Text("No accounts linked.")
                .font(Tokens.Typography.heading)
                .foregroundStyle(Tokens.textPrimary)
        } else {
            populated
        }
    }

    private var populated: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            ForEach(payload.accounts) { account in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: Tokens.Space.xs) {
                        Text(account.name)
                            .font(Tokens.Typography.body)
                            .foregroundStyle(Tokens.textPrimary)
                        if !account.tail.isEmpty {
                            Text("•••• \(account.tail)")   // masked tail only — never the full number
                                .font(Tokens.Typography.label)
                                .monospacedDigit()
                                .foregroundStyle(Tokens.textMuted)
                        }
                    }
                    Spacer()
                    Text(money(account.balance))
                        .font(Tokens.Typography.heading)
                        .monospacedDigit()                  // tabular numerals, right-aligned
                        .foregroundStyle(Tokens.textPrimary)
                }
            }
            Divider().overlay(Tokens.hairline)
            HStack(alignment: .firstTextBaseline) {
                Text("Total")
                    .font(Tokens.Typography.label)
                    .foregroundStyle(Tokens.textMuted)
                Spacer()
                Text(money(payload.total))
                    .font(Tokens.Typography.display)
                    .monospacedDigit()
                    .foregroundStyle(Tokens.textPrimary)
            }
        }
    }

    private func money(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: value)) ?? "$\(value)"
    }
}
