import SwiftUI
import WidgetKit

// The leave-times widget (IOS.md Phase 3b): the shown trip's next leave-bys on the Home Screen, or
// the ride the app follows (2026-10-31; the Lock Screen sizes are gone). Each reload posts the app's request (the shared keychain) to /api/widget, which times
// the trip (core.js); the answer's entries carry their own countdowns, a minute apart. Reloads:
// at the answer's `refresh` (10 min, or the next leave-by), and when the app changes the request.
// Without an answer the last one is kept (and retried in 10 min); past its times, "Open T-Minus".
struct LeaveEntry: TimelineEntry {
    let date: Date
    let content: LeaveContent
}

struct LeaveProvider: TimelineProvider {
    static let url = URL(string: "https://t-minus.lucasp.net/api/widget")!
    static let sample = LeaveEntry(date: Date(), content: LeaveContent(
        name: "Home → Work",
        entry: WidgetView.Entry(at: 0, row: 0, title: "Leave 7:42am", count: "in 9 min", warn: false, next: "Arrive 8:25am", head: "Leave in 9 min", headTime: "7:42am"),
        rows: [WidgetView.Row(time: "7:42am", vehicle: "Bus 132", color: "FFC72C", label: "132", line: "Bus 132 → Malden", arrive: "arrive 8:25am", arriveTitle: "Arrive 8:25am", long: "Bus 132", headsign: "Malden")]))

    func placeholder(in context: Context) -> LeaveEntry { Self.sample }

    func getSnapshot(in context: Context, completion: @escaping (LeaveEntry) -> Void) {
        if context.isPreview { return completion(Self.sample) }
        Task {
            let (view, _) = await Self.load()
            let now = Date()
            completion(LeaveContent.timeline(view, now: now).last { $0.0 <= now }.map { LeaveEntry(date: now, content: $0.1) } ?? Self.sample)
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LeaveEntry>) -> Void) {
        Task {
            let (view, fresh) = await Self.load()
            let now = Date()
            let entries = LeaveContent.timeline(view, now: now).map { LeaveEntry(date: $0.0, content: $0.1) }
            let retry = now.addingTimeInterval(600)
            let next = fresh && view != nil ? max(Date(timeIntervalSince1970: view!.refresh), now.addingTimeInterval(60)) : retry
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }

    // The server's answer (saved for later), else the last one saved: (answer, fresh).
    static func load() async -> (WidgetView?, Bool) {
        let defaults = UserDefaults.standard
        let saved = defaults.data(forKey: WidgetStore.last).flatMap { try? JSONDecoder().decode(WidgetView.self, from: $0) }
        guard let body = WidgetStore.loadRequest() else { return (saved, false) }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = Data(body.utf8)
        do {
            let (data, res) = try await URLSession.shared.data(for: req)
            guard (res as? HTTPURLResponse)?.statusCode == 200 else { return (saved, false) }
            let view = try JSONDecoder().decode(WidgetView.self, from: data)
            defaults.set(data, forKey: WidgetStore.last)
            return (view, true)
        } catch {
            return (saved, false)
        }
    }
}

struct LeaveWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetStore.kind, provider: LeaveProvider()) { entry in
            LeaveWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Leave times")
        .description("When to leave for the trip T-Minus shows.")
        .supportedFamilies([.systemSmall, .systemMedium])
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
        default:
            LeaveWidgetView(content: entry.content, size: .small).containerBackground(Theme.of(scheme).card, for: .widget)
        }
    }
}
