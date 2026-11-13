import AppIntents
import SwiftUI
import WidgetKit

// The leave-times widget (IOS.md Phase 3b): the shown trip's next leave-bys on the Home Screen, or
// the ride the app follows (2026-10-31; the Lock Screen sizes are gone). Each reload posts the app's request (the shared keychain) to /api/widget, which times
// the trip (core.js); the answer's entries carry their own countdowns, a minute apart. Reloads:
// at the answer's `refresh` (10 min, or the next leave-by), and when the app changes the request.
// Without an answer the last one is kept (and retried in 10 min); past its times, "Open T-Minus".
// The large size (2026-11-13) asks for `size=large` (the trip's timeline) and has one option,
// "Show" (Edit Widget): "More rides" or "Trip timeline" for its leave times; the other sizes ignore it.
struct LeaveEntry: TimelineEntry {
    let date: Date
    let content: LeaveContent
}

enum LeaveShowOption: String, AppEnum {
    case rides, timeline
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Show"
    static var caseDisplayRepresentations: [LeaveShowOption: DisplayRepresentation] = [.rides: "More rides", .timeline: "Trip timeline"]
}

struct LeaveConfiguration: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Leave times"
    static var description = IntentDescription("When to leave for the trip T-Minus shows.")
    @Parameter(title: "Show", default: .rides) var show: LeaveShowOption
}

struct LeaveProvider: AppIntentTimelineProvider {
    static let url = URL(string: "https://t-minus.lucasp.net/api/widget")!
    static let sample = LeaveEntry(date: Date(), content: LeaveContent(
        name: "Home → Work",
        entry: WidgetView.Entry(at: 0, row: 0, title: "Leave 7:42am", count: "in 9 min", warn: false, next: "Arrive 8:25am", head: "Leave in 9 min", headTime: "7:42am"),
        rows: [WidgetView.Row(time: "7:42am", vehicle: "Bus 132", color: "FFC72C", label: "132", line: "Bus 132 → Malden", arrive: "arrive 8:25am", arriveTitle: "Arrive 8:25am", long: "Bus 132", headsign: "Malden")]))

    func placeholder(in context: Context) -> LeaveEntry { Self.sample }

    func snapshot(for configuration: LeaveConfiguration, in context: Context) async -> LeaveEntry {
        if context.isPreview { return Self.sample }
        let (view, _) = await Self.load(large: context.family == .systemLarge ? configuration.show : nil)
        let now = Date()
        return LeaveContent.timeline(view, now: now).last { $0.0 <= now }.map { LeaveEntry(date: now, content: $0.1) } ?? Self.sample
    }

    func timeline(for configuration: LeaveConfiguration, in context: Context) async -> Timeline<LeaveEntry> {
        let (view, fresh) = await Self.load(large: context.family == .systemLarge ? configuration.show : nil)
        let now = Date()
        let entries = LeaveContent.timeline(view, now: now).map { LeaveEntry(date: $0.0, content: $0.1) }
        let retry = now.addingTimeInterval(600)
        let next = fresh && view != nil ? max(Date(timeIntervalSince1970: view!.refresh), now.addingTimeInterval(60)) : retry
        return Timeline(entries: entries, policy: .after(next))
    }

    // The server's answer (saved for later), else the last one saved: (answer, fresh). The large
    // size (`large`: its "Show") asks for its timeline and keeps its own copy per option.
    static func load(large show: LeaveShowOption? = nil) async -> (WidgetView?, Bool) {
        let defaults = UserDefaults.standard
        let key = show.map { "\(WidgetStore.last).large.\($0.rawValue)" } ?? WidgetStore.last
        let saved = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(WidgetView.self, from: $0) }
        guard let body = WidgetStore.loadRequest() else { return (saved, false) }
        let target = show.map { URL(string: "\(url.absoluteString)?size=large&show=\($0.rawValue)")! } ?? url
        var req = URLRequest(url: target, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = Data(body.utf8)
        do {
            let (data, res) = try await URLSession.shared.data(for: req)
            guard (res as? HTTPURLResponse)?.statusCode == 200 else { return (saved, false) }
            let view = try JSONDecoder().decode(WidgetView.self, from: data)
            defaults.set(data, forKey: key)
            return (view, true)
        } catch {
            return (saved, false)
        }
    }
}

struct LeaveWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: WidgetStore.kind, intent: LeaveConfiguration.self, provider: LeaveProvider()) { entry in
            LeaveWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Leave times")
        .description("When to leave for the trip T-Minus shows.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct LeaveWidgetEntryView: View {
    let entry: LeaveEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        switch family {
        case .systemMedium:
            LeaveWidgetView(content: entry.content, size: .medium).containerBackground(Theme.of(scheme).card, for: .widget)
        case .systemLarge:
            LeaveWidgetView(content: entry.content, size: .large).containerBackground(Theme.of(scheme).card, for: .widget)
        default:
            LeaveWidgetView(content: entry.content, size: .small).containerBackground(Theme.of(scheme).card, for: .widget)
        }
    }
}
