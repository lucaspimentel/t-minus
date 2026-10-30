import AppKit
import SwiftUI

// The Live Activity's previews for review without a Mac (the ios workflow's artifact): the views
// in ios/App/TMinusWidgets/RideViews.swift rendered from sample states to PNGs per theme (ride
// cards, and the leave cards).
// The leave-times widget's sizes too (widget-<theme>.png).
// swiftc -parse-as-library ios/App/Shared/RideState.swift ios/App/Shared/WidgetData.swift ios/App/TMinusWidgets/RideViews.swift ios/App/TMinusWidgets/LeaveWidgetViews.swift ios/Previews/Render.swift -o render
// ./render <out dir>

private let now = Date().timeIntervalSince1970
private let orange = "ED8B00", bus = "FFC72C"
private func legs(_ a: (String, Double, Double)...) -> [RideState.Leg] { a.map { RideState.Leg(color: $0.0, dep: now + $0.1 * 60, arr: now + $0.2 * 60) } }
private let trip = legs((orange, -8, 6), (bus, 14, 44)) // 14 and 30 min: proportional segments

private let samples: [(String, RideState)] = [
    ("Riding", RideState(phase: "riding", warn: false, color: orange, label: "OL", title: "Orange · 4 stops", until: now + 360, stops: 4,
                         sub: "Get off 7:54am at Sullivan Square", next: "Then Bus 132 toward Malden 8:02am · 3 min to spare", legs: trip)),
    ("Get off", RideState(phase: "riding", warn: false, color: orange, label: "OL", title: "Next stop: get off", until: now + 60, stops: 1,
                          sub: "Get off 7:54am at Sullivan Square", next: "Then Bus 132 toward Malden 8:02am · 3 min to spare", legs: trip, soon: true)),
    ("Transfer", RideState(phase: "transfer", warn: false, color: bus, label: "132", title: "Bus 132", until: now + 300, stops: -1,
                           sub: "Toward Malden · 8:02am · 3 min to spare", next: "Arrive ~8:25am", legs: legs((orange, -20, -6), (bus, 5, 17)))),
    ("Missed connection", RideState(phase: "transfer", warn: true, color: bus, label: "132", title: "Missed the 8:02am · next 8:14am", until: now + 420, stops: -1,
                                    sub: "Bus 132 · 8:14am", next: "Arrive ~8:37am", legs: legs((orange, -20, -6), (bus, 7, 19)))),
    ("No connection", RideState(phase: "transfer", warn: true, color: bus, label: "132", title: "No connection after 8:01am", until: 0, stops: -1,
                                sub: "", next: "Open the app for another way.", legs: legs((orange, -20, -6), (bus, 7, 19)))),
    ("Walking", RideState(phase: "walking", warn: false, color: "", label: "🚶", title: "Walking", until: now + 240, stops: -1,
                          sub: "Arrive ~8:25am", next: "", legs: legs((orange, -30, -16), (bus, -12, -1)))),
    ("Arrived", RideState(phase: "arrived", warn: false, color: "", label: "", title: "Arrived ~8:25am", until: 0, stops: -1,
                          sub: "", next: "", legs: legs((orange, -30, -16), (bus, -12, -4)))),
]

// Leave cards (Phase 3a; the layout of 2026-10-29): Home to office, the 7:48 bus 132.
private let ahead = legs((bus, 9, 23), (orange, 27, 36))
private func leave(_ phase: String, _ head: String, countTo: Double = 0, time: String = "", warn: Bool = false, right: String = "arrive 8:25am",
                   note: String = "", emoji: String = "🚶", island: String = "", long: String = "Bus 132", soon: Bool = false) -> RideState {
    var st = RideState(phase: phase, warn: warn, color: bus, label: "132", title: head, until: countTo, stops: -1, sub: "", next: "", legs: ahead,
                       soon: soon, island: island, join: " ")
    st.head = head; st.countTo = countTo; st.headTime = time; st.long = long; st.headsign = long.isEmpty ? "" : "Malden"
    st.right = right; st.note = note; st.emoji = emoji
    return st
}
private let leaveSamples: [(String, RideState)] = [
    ("An hour+ ahead", leave("early", "Leave in", countTo: now + 74 * 60 + 30, time: "7:39am")),
    ("Moved", leave("leave", "Leave in", countTo: now + 25 * 60 + 30, time: "7:42am", warn: true, right: "arrive 8:28am", note: "Moved (was 7:39am)")),
    ("Leave in (10-min heads-up)", leave("leave", "Leave in", countTo: now + 540, time: "7:39am")),
    ("Leave in 28 min", leave("leave", "Leave in", countTo: now + 28 * 60 + 30, time: "7:58am", right: "arrive 8:44am")),
    ("Leave in <1 minute", leave("leave", "Leave in", countTo: now + 50, time: "7:39am", soon: true)),
    ("Past the leave-by", leave("now", "Departs in", countTo: now + 420, time: "7:48am", warn: true, emoji: "🚌")),
    ("Departs in (subway)", { var st = leave("departs", "Departs in", countTo: now + 120, time: "7:48am", warn: true, emoji: "🚇", long: "Orange Line")
        st.color = orange; st.label = "OL"; st.headsign = "Forest Hills"; return st }()),
    ("Walk card", leave("walk", "Departs in", countTo: now + 360, time: "7:48am", note: "At the stop ~7:45am · 3 min to spare", emoji: "🚌")),
    ("Walk card, late", leave("walk", "Departs in", countTo: now + 120, time: "7:48am", warn: true, note: "At the stop ~7:50am · 2 min late", emoji: "🚌")),
    ("Did you get on? (at the departure)", leave("ask", "Did you get on?", right: "left 7:48am", emoji: "", island: "Got on?")),
    ("Missed (the end)", leave("gone", "Missed · left 7:48am", warn: true, right: "", emoji: "")),
    ("Ride cancelled", leave("cancelled", "Ride cancelled", right: "", note: "Open the app for the next one.", emoji: "", long: "")),
]

private struct Compact: View {
    let state: RideState
    var body: some View {
        HStack { IslandLeading(state: state); Spacer(); IslandTrailing(state: state) }
            .padding(.horizontal, 14).frame(width: 250, height: 37)
            .background(.black).clipShape(Capsule()).foregroundStyle(.white)
            .environment(\.colorScheme, .dark)
            .frame(maxWidth: .infinity)
    }
}

// The expanded island: the trip name and "T-Minus" by the camera, then the body.
private struct Expanded: View {
    let tripName: String
    let state: RideState
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack { IslandTop(text: tripName, edge: .leading); Spacer(); IslandTop(text: "T-Minus", edge: .trailing) }
            IslandExpanded(state: state)
        }
        .padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 18)
        .background(.black).clipShape(RoundedRectangle(cornerRadius: 40))
        .environment(\.colorScheme, .dark)
    }
}

// The leave cards on their own sheet (leave-card-<theme>.png).
private struct LeaveSheet: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(leaveSamples, id: \.0) { name, state in
                Text(name).font(.caption).foregroundStyle(.white)
                RideCardView(tripName: "Home to office", state: state)
                    .background(Theme.of(scheme).card)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
            }
            Text("Dynamic Island: compact, then expanded (top row and body), per card").font(.caption).foregroundStyle(.white)
            ForEach(leaveSamples, id: \.0) { name, state in
                Text(name).font(.caption).foregroundStyle(.white)
                Compact(state: state)
                Expanded(tripName: "Home to office", state: state)
            }
        }
        .padding(16)
        .frame(width: 400)
        .background(LinearGradient(colors: scheme == .dark ? [Color(hex: "232A3A"), Color(hex: "0B0D12")] : [Color(hex: "5B6B8C"), Color(hex: "2C3447")],
                                   startPoint: .topLeading, endPoint: .bottomTrailing))
    }
}

private struct Sheet: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(samples, id: \.0) { name, state in
                Text(name).font(.caption).foregroundStyle(.white)
                RideCardView(tripName: "Home to office", state: state)
                    .background(Theme.of(scheme).card)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
            }
            Text("Dynamic Island: compact (riding, transfer, walking), expanded, minimal").font(.caption).foregroundStyle(.white)
            ForEach([samples[0].1, samples[2].1, samples[5].1], id: \.self) { state in
                HStack { IslandLeading(state: state); Spacer(); IslandTrailing(state: state) }
                    .padding(.horizontal, 14).frame(width: 250, height: 37)
                    .background(.black).clipShape(Capsule()).foregroundStyle(.white)
                    .environment(\.colorScheme, .dark)
                    .frame(maxWidth: .infinity)
            }
            Expanded(tripName: "Home to office", state: samples[0].1)
            Expanded(tripName: "Home to office", state: samples[2].1)
            RouteDot(hex: orange, size: 10).frame(width: 37, height: 37).background(.black).clipShape(Circle()).frame(maxWidth: .infinity)
        }
        .padding(16)
        .frame(width: 400)
        .background(LinearGradient(colors: scheme == .dark ? [Color(hex: "232A3A"), Color(hex: "0B0D12")] : [Color(hex: "5B6B8C"), Color(hex: "2C3447")],
                                   startPoint: .topLeading, endPoint: .bottomTrailing))
    }
}

// The leave-times widget (Phase 3b): Home to office, buses 132 at 7:48, 7:54 and 8:06; rows show
// the leave-by (CLAUDE.md "UI rules").
private func wrow(_ time: String, _ arrive: String, vehicle: String = "Bus 132", color: String = bus, label: String = "132") -> WidgetView.Row {
    WidgetView.Row(time: time, vehicle: vehicle, color: color, label: label, line: vehicle, arrive: "arrive \(arrive)", arriveTitle: "Arrive \(arrive)")
}
private let wrows = [wrow("7:42am", "8:25am"), wrow("7:48am", "8:37am"), wrow("8:00am", "8:49am")]
// Wide times (the phone cut "10:22am" to "10:2…" in a fixed-width column).
private let lateRows = [wrow("10:22am", "11:08am"), wrow("11:22am", "12:04pm"), wrow("12:22pm", "1:04pm")]
// Late at night (the phone, 2026-10-28: "Thu" times overflowed both sides), and a long route name
// in the phone's 6.1" width: only the route column gives way.
private let nightRows = [wrow("11:26pm", "12:08am"), wrow("5:57am", "6:45am"), wrow("6:27am", "7:15am")]
private let longRows = [wrow("12:22pm", "~12:58pm", vehicle: "Silver SL4 → South Station via Essex", color: "7C878E", label: "SL4"),
                        wrow("10:22am", "~11:08am", vehicle: "Green Line E → Heath Street", color: "00843D", label: "GL·E"),
                        wrow("12:22pm", "~1:04pm")]
private func went(_ title: String, _ count: String, warn: Bool = false, next: String = "Arrive 8:25am", lock: String? = nil, lockSub: String, inline: String, circle: String,
                  ring: Double = 0, row: Int = 0, head: String? = nil, headCount: String? = nil, line: String? = nil, rowTime: String? = nil) -> WidgetView.Entry {
    WidgetView.Entry(at: 0, row: row, title: title, count: count, warn: warn, next: next, lock: lock ?? title, lockSub: lockSub, inline: inline, circle: circle,
                     circleSub: row >= 0 ? "Bus 132" : "", ring: row >= 0 ? ring : -1, head: head, headCount: headCount, line: line, rowTime: rowTime)
}
private let widgetSamples: [(String, LeaveContent)] = [
    ("Leave in", LeaveContent(name: "Home → Work", entry: went("Leave 7:42am", "in 9 min", lockSub: "in 9 min · Bus 132", inline: "132 Leave 7:42am", circle: "9m", ring: 9.0 / 60,
                                                              head: "Leave in 9 min"), rows: wrows)),
    ("Leave now", LeaveContent(name: "Home → Work", entry: went("Leave now", "departs in 5 min", warn: true, lockSub: "Bus 132 at 7:48am", inline: "132 Leave now", circle: "now",
                                                               head: "Leave now", headCount: "departs in 5 min", line: "Bus 132 at 7:48am", rowTime: "7:48am"), rows: wrows)),
    ("Departs", LeaveContent(name: "Home → Work", entry: went("Departs", "in 2 min", warn: true, lock: "Departs in 2 min", lockSub: "Bus 132 at 7:48am", inline: "132 Departs in 2 min", circle: "2m",
                                                             head: "Departs in 2 min", line: "Bus 132 at 7:48am", rowTime: "7:48am"), rows: wrows)),
    ("An hour+ ahead", LeaveContent(name: "Work → Home", entry: WidgetView.Entry(at: 0, row: 0, title: "Leave 5:12pm", count: "", warn: false, next: "Arrive 6:01pm", lock: "Leave 5:12pm",
        lockSub: "Orange Line", inline: "OL Leave 5:12pm", circle: "5:12", circleSub: "Orange", ring: -1, head: "Leave in 1h 06m"),
        rows: [wrow("5:12pm", "6:01pm", vehicle: "Orange Line", color: orange, label: "OL")])),
    ("No more today", LeaveContent(name: "Home → Work", entry: went("No more today", "", next: "First 5:12am", lockSub: "First 5:12am", inline: "No more today", circle: "–", row: -1), rows: [])),
    ("Set up", LeaveContent(name: "", entry: went("Plan a trip in T-Minus", "", next: "", lockSub: "", inline: "Set up a trip in T-Minus", circle: "–", row: -1), rows: [])),
    ("Stale", .stale("Home → Work")),
]

// The Home Screen layouts of 2026-10-29: the answer's `long`, `headsign` and `headTime`.
private func hrow(_ time: String, _ arrive: String, long: String, short: String, headsign: String, color: String, label: String) -> WidgetView.Row {
    WidgetView.Row(time: time, vehicle: short, short: short, color: color, label: label, line: short, arrive: "arrive \(arrive)", arriveTitle: "Arrive \(arrive)",
                   long: long, headsign: headsign)
}
private func hent(_ head: String, _ headTime: String, warn: Bool = false) -> WidgetView.Entry {
    var e = went(head, "", warn: warn, lockSub: "", inline: "", circle: "", head: head)
    e.headTime = headTime
    return e
}
private let ol = { (t: String, a: String) in hrow(t, a, long: "Orange Line", short: "Orange", headsign: "Forest Hills", color: orange, label: "OL") }
private let rl = { (t: String, a: String, h: String) in hrow(t, a, long: "Red Line", short: "Red", headsign: h, color: "DA291C", label: "RL") }
private let gl = { (t: String, a: String, b: String, h: String) in hrow(t, a, long: "Green Line \(b)", short: "Green \(b)", headsign: h, color: "00843D", label: "GL·\(b)") }
private let orangeRows = [ol("12:17am", "12:42am"), ol("12:23am", "12:48am"), ol("12:26am", "12:50am")]
private let homeSamples: [(String, LeaveContent)] = [
    ("Leave in", LeaveContent(name: "Oak Grove → State", entry: hent("Leave in 5 min", "12:17am"), rows: orangeRows)),
    ("Leave now", LeaveContent(name: "Oak Grove → State", entry: hent("Leave now", "departs 12:20am", warn: true), rows: orangeRows)),
    ("Departs", LeaveContent(name: "Oak Grove → State", entry: hent("Departs in 2 min", "12:20am", warn: true), rows: orangeRows)),
    ("Widest countdown", LeaveContent(name: "Oak Grove → State", entry: hent("Leave in 59 min", "12:17am"), rows: orangeRows)),
    ("An hour+ ahead", LeaveContent(name: "Work → Home", entry: hent("Leave in 1h 06m", "5:12pm"),
        rows: [hrow("5:12pm", "6:01pm", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132"),
               hrow("5:42pm", "6:31pm", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132")])),
    ("Long headsign", LeaveContent(name: "Home → Work", entry: hent("Leave in 9 min", "7:42am"),
        rows: [hrow("7:42am", "8:25am", long: "Bus 111", short: "Bus 111", headsign: "Haymarket Station", color: bus, label: "111")])),
    ("Red branches", LeaveContent(name: "Downtown → Home", entry: hent("Leave in 9 min", "7:42am"),
        rows: [rl("7:42am", "8:05am", "Ashmont"), rl("7:47am", "8:10am", "Braintree"), rl("7:54am", "8:17am", "Ashmont")])),
    ("Green C or D", LeaveContent(name: "Downtown → Home", entry: hent("Leave in 4 min", "8:03am"),
        rows: [gl("8:03am", "8:21am", "C", "Cleveland Circle"), gl("8:06am", "8:24am", "D", "Riverside"), gl("8:11am", "8:29am", "C", "Cleveland Circle")])),
]

private struct WidgetSheet: View {
    @Environment(\.colorScheme) private var scheme
    private func home(_ c: LeaveContent, _ size: LeaveSize, width: CGFloat) -> some View {
        LeaveWidgetView(content: c, size: size).padding(16).frame(width: width, height: 170)
            .background(Theme.of(scheme).card).clipShape(RoundedRectangle(cornerRadius: 22))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Home Screen (2026-10-29) small: leave in, leave now, departs, widest, an hour+ ahead, long headsign, Red branches, Green C or D").font(.caption).foregroundStyle(.white)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                ForEach(Array(stride(from: 0, to: homeSamples.count, by: 2)), id: \.self) { i in
                    GridRow {
                        home(homeSamples[i].1, .small, width: 170)
                        if i + 1 < homeSamples.count { home(homeSamples[i + 1].1, .small, width: 170) }
                    }
                }
            }
            Text("Home Screen (2026-10-29) medium, 6.1\" width: the same samples").font(.caption).foregroundStyle(.white)
            ForEach(homeSamples.indices, id: \.self) { i in home(homeSamples[i].1, .medium, width: 338) }
            Text("Answers before 2026-10-29 (builds' old layout): small").font(.caption).foregroundStyle(.white)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                ForEach(Array(stride(from: 0, to: widgetSamples.count, by: 2)), id: \.self) { i in
                    GridRow {
                        home(widgetSamples[i].1, .small, width: 170)
                        if i + 1 < widgetSamples.count { home(widgetSamples[i + 1].1, .small, width: 170) }
                    }
                }
            }
            Text("Home medium: leave in, leave now, departs, an hour+ ahead, no more today, wide times; 6.1\" width: late night, long routes").font(.caption).foregroundStyle(.white)
            ForEach([0, 1, 2, 3, 4], id: \.self) { i in home(widgetSamples[i].1, .medium, width: 364) }
            home(LeaveContent(name: "Home → Office", entry: widgetSamples[0].1.entry, rows: lateRows), .medium, width: 364)
            home(LeaveContent(name: "Home → Office", entry: widgetSamples[0].1.entry.map { var e = $0; e.head = "Leave in 24 min"; return e }, rows: nightRows), .medium, width: 338)
            home(LeaveContent(name: "Home → Office", entry: widgetSamples[1].1.entry, rows: longRows), .medium, width: 338)
            Text("Lock Screen: inline, rectangular, circular (iOS tints them)").font(.caption).foregroundStyle(.white)
            ForEach([0, 1, 2, 3, 6], id: \.self) { i in
                let c = widgetSamples[i].1
                VStack(spacing: 8) {
                    LeaveWidgetView(content: c, size: .inline).font(.subheadline.weight(.semibold))
                    HStack(spacing: 10) {
                        LeaveWidgetView(content: c, size: .rectangular).padding(.horizontal, 8).frame(width: 170, height: 72)
                            .background(.white.opacity(0.15)).clipShape(RoundedRectangle(cornerRadius: 12))
                        LeaveWidgetView(content: c, size: .circular).frame(width: 72, height: 72).background(.white.opacity(0.15)).clipShape(Circle())
                        if i == 0 {
                            LeaveWidgetView(content: LeaveContent(name: c.name, entry: widgetSamples[0].1.entry.map { var e = $0; e.circle = "38m"; e.ring = 38.0 / 60; return e }, rows: c.rows), size: .circular)
                                .frame(width: 72, height: 72).background(.white.opacity(0.15)).clipShape(Circle())
                        }
                    }
                }
                .foregroundStyle(.white).environment(\.colorScheme, .dark).frame(maxWidth: .infinity)
            }
        }
        .padding(16)
        .frame(width: 400)
        .background(LinearGradient(colors: scheme == .dark ? [Color(hex: "232A3A"), Color(hex: "0B0D12")] : [Color(hex: "5B6B8C"), Color(hex: "2C3447")],
                                   startPoint: .topLeading, endPoint: .bottomTrailing))
    }
}

@main
struct Render {
    @MainActor static func main() throws {
        let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
        func write<V: View>(_ view: V, _ file: String) throws {
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            guard let cg = renderer.cgImage, let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else {
                throw NSError(domain: "Render", code: 1, userInfo: [NSLocalizedDescriptionKey: "rendering \(file) failed"])
            }
            try png.write(to: out.appendingPathComponent(file))
        }
        for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
            try write(Sheet().environment(\.colorScheme, scheme), "live-activity-\(name).png")
            try write(LeaveSheet().environment(\.colorScheme, scheme), "leave-card-\(name).png")
            try write(WidgetSheet().environment(\.colorScheme, scheme), "widget-\(name).png")
        }
    }
}
