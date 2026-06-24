#if DEBUG
import SwiftUI

/// A DEBUG-only gallery of the redesigned bloom cards with representative sample data — a way to
/// review the warm "Personal Agent Runtime" card theme without driving the daemon's routine engine.
/// Gated behind the `KERNEL_GALLERY` env var (see RuntimeWindow), so it never affects normal runs
/// and is compiled out of release builds entirely.
struct CardGallery: View {
    var body: some View {
        ZStack {
            Tokens.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: Tokens.Space.lg) {
                    Text("CARD GALLERY · DEBUG")
                        .font(Tokens.Typography.monoCaption)
                        .tracking(3)
                        .foregroundStyle(Tokens.textDim)
                        .padding(.top, Tokens.Space.xxl)

                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 380, maximum: 460),
                                                 spacing: Tokens.Space.xl, alignment: .top)],
                              alignment: .leading, spacing: Tokens.Space.xl) {
                        EventsWidget(payload: Self.events, isPresented: true)
                        SpendingWidget(payload: Self.spending, isPresented: true)
                        MailWidget(payload: Self.mail, isPresented: true)
                        AccountsWidget(payload: Self.accounts, isPresented: true)
                        EmailPreviewWidget(payload: Self.draft, isPresented: true)
                        BreakerPreviewCard(preview: Self.breaker, isPresented: true, windowSeconds: 9)
                    }

                    if let widget = Self.widget {
                        Text("WIDGET DISPLAYER · command-driven")
                            .font(Tokens.Typography.monoCaption).tracking(2)
                            .foregroundStyle(Tokens.textDim)
                            .padding(.top, Tokens.Space.lg)
                        WidgetDisplayer(spec: widget, onOption: { _, _ in }, onDismiss: { _ in })
                            .frame(width: 360, height: 360)
                            .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.widget, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.widget, style: .continuous).stroke(Tokens.hairline, lineWidth: 1))
                    }
                }
                .padding(Tokens.Space.xxl)
            }
        }
    }

    // MARK: Sample payloads (decoded through each widget's real `from(JSONValue:)` path)

    static let events = EventsPayload.from(.object([
        "count": .number(3),
        "items": .array([
            .object(["time": .string("09:00"), "title": .string("Focus block")]),
            .object(["time": .string("13:00"), "title": .string("Lunch w/ Priya"), "location": .string("Café Mona")]),
            .object(["time": .string("14:00"), "title": .string("Board sync")]),
        ]),
    ]))

    static let spending = SpendingPayload.from(.object([
        "timeframe": .string("W"),
        "total": .number(1284),
        "series": .array([
            .object(["day": .string("Mon"), "spent": .number(140)]),
            .object(["day": .string("Tue"), "spent": .number(210)]),
            .object(["day": .string("Wed"), "spent": .number(160)]),
            .object(["day": .string("Thu"), "spent": .number(260)]),
            .object(["day": .string("Fri"), "spent": .number(180)]),
            .object(["day": .string("Sat"), "spent": .number(220)]),
            .object(["day": .string("Sun"), "spent": .number(190)]),
        ]),
    ]))

    static let mail = MailPayload.from(.object([
        "count": .number(3),
        "items": .array([
            .object([
                "sender": .string("Sarah Chen"),
                "subject": .string("Re: Acme renewal — need a decision today"),
                "snippet": .string("We can commit to the 3-year if you can hold pricing."),
                "source": .string("external"),
                "suggestion": .string("reply"),
            ]),
            .object([
                "sender": .string("Notion"),
                "subject": .string("Weekly digest"),
                "snippet": .string("3 pages updated in your workspace."),
                "source": .string("internal"),
                "suggestion": .string("archive"),
            ]),
        ]),
    ]))

    static let accounts = AccountsPayload.from(.object([
        "accounts": .array([
            .object(["name": .string("Checking"), "tail": .string("4321"), "balance": .number(4820)]),
            .object(["name": .string("Savings"), "tail": .string("8890"), "balance": .number(15200)]),
        ]),
    ]))

    static let draft = EmailPreviewPayload.from(.object([
        "to": .string("sarah@acme.com"),
        "subject": .string("Re: Acme renewal"),
        "body": .string("Hi Sarah — glad to move forward at the revised terms: $48k ARR, 3-year, Q3 onboarding. Legal will send paper today."),
        "signature": .string("— Pravin"),
        "toSource": .string("external"),
    ]))

    static let breaker = BreakerPreview(
        id: "demo",
        summary: "Send reply to Sarah Chen confirming the three-year renewal at locked pricing.",
        estimatedSpend: 0)

    static let widget = WidgetCommand.parse(
        id: "demo",
        "focus email to:john@acme.com from:Acme Corp subject:Renewal decision content:Glad to move forward at the revised terms — 3-year at locked pricing. options:abort,send(auto 15s)")
}
#endif
