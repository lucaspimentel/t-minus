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

// Ride cards in the leave card's layout (2026-10-31): Office → Home, the Orange Line to Oak Grove,
// then the 6:38pm Bus 132.
private func ride(_ phase: String, _ head: String, countTo: Double = 0, after: Bool = false, time: String = "", warn: Bool = false,
                  long: String = "Orange Line", headsign: String = "Oak Grove", color: String = orange, right: String = "arrive 7:21pm", note: String = "",
                  then: [(String, String)] = [], thenText: String = "", nextWarn: Bool = false, emoji: String = "🚇", island: String = "",
                  legs: [RideState.Leg] = trip) -> RideState {
    var st = RideState(phase: phase, warn: warn, color: color, label: color == bus ? "132" : color.isEmpty ? "" : "OL", title: head, until: countTo, stops: -1,
                       sub: "", next: "", legs: legs, soon: false, nextWarn: nextWarn)
    st.head = head; st.countTo = countTo; st.countAfter = after; st.headTime = time; st.long = long; st.headsign = headsign; st.right = right
    st.note = note; st.emoji = emoji; st.islandText = island; st.then = then.map { RideState.ThenLeg(label: $0.0, color: $0.1) }; st.thenText = thenText
    return st
}
private let busNext = [("Bus 132", bus)]
private let atTransfer = legs((orange, -20, -6), (bus, 6, 30))
private let samples: [(String, RideState)] = [
    ("Riding", ride("riding", "Get off in 5 stops", countTo: now + 540, after: true, then: busNext, thenText: "6:38pm · 4 min to spare", island: "5 stops")),
    ("Riding, tight connection", ride("riding", "Get off in 5 stops", countTo: now + 540, after: true, then: busNext, thenText: "6:38pm · tight", nextWarn: true, island: "5 stops")),
    ("Riding, missed connection", ride("riding", "Get off in 5 stops", countTo: now + 540, after: true, warn: true, right: "arrive 7:41pm", then: busNext,
                                       thenText: "6:58pm (missed 6:38pm)", nextWarn: true, island: "5 stops")),
    ("Next stop", ride("riding", "Get off next stop", countTo: now + 120, after: true, then: busNext, thenText: "6:38pm · 4 min to spare", island: "next")),
    ("Get off here", ride("riding", "Get off here", then: busNext, thenText: "6:38pm · 4 min to spare", island: "here")),
    ("No stop list yet", ride("riding", "Get off in", countTo: now + 540, then: busNext, thenText: "6:38pm · 4 min to spare")),
    ("Transfer", ride("transfer", "Bus 132 in", countTo: now + 360, time: "6:38pm", long: "Bus 132", headsign: "Redstone", color: bus, note: "4 min to spare",
                      emoji: "🚌", legs: atTransfer)),
    ("Transfer, tight", ride("transfer", "Bus 132 in", countTo: now + 120, time: "6:38pm", warn: true, long: "Bus 132", headsign: "Redstone", color: bus, note: "tight",
                             emoji: "🚌", legs: atTransfer)),
    ("Missed connection", ride("transfer", "Bus 132 in", countTo: now + 420, time: "6:58pm", warn: true, long: "Bus 132", headsign: "Redstone", color: bus,
                               right: "arrive 7:41pm", note: "Missed the 6:38pm", emoji: "🚌", legs: atTransfer)),
    ("No connection", ride("transfer", "No connection after 6:31pm", warn: true, long: "", color: bus, right: "", note: "Open the app for another way.", emoji: "",
                           legs: atTransfer)),
    ("Walking", ride("walking", "Arrive in", countTo: now + 300, time: "7:21pm", long: "", color: "", right: "", emoji: "🚶", legs: legs((orange, -30, -16), (bus, -12, -1)))),
    ("Arrived", ride("arrived", "Arrived", time: "7:21pm", long: "", color: "", right: "", emoji: "", legs: legs((orange, -30, -16), (bus, -12, -4)))),
]

// Leave cards (Phase 3a; the layout of 2026-10-29): Home to office, the 7:48 bus 132.
private let ahead = legs((bus, 9, 23), (orange, 27, 36))
private func leave(_ phase: String, _ head: String, countTo: Double = 0, time: String = "", warn: Bool = false, right: String = "arrive 8:25am",
                   note: String = "", emoji: String = "🚶", island: String = "", long: String = "Bus 132", soon: Bool = false) -> RideState {
    var st = RideState(phase: phase, warn: warn, color: bus, label: "132", title: head, until: countTo, stops: -1, sub: "", next: "", legs: ahead,
                       soon: soon, island: island, join: " ")
    st.head = head; st.countTo = countTo; st.headTime = time; st.long = long; st.headsign = long.isEmpty ? "" : "Malden"
    st.right = right; st.note = note; st.emoji = emoji; st.then = long.isEmpty ? [] : [RideState.ThenLeg(label: "Orange", color: orange)]
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
    ("Did you get on? (at the departure)", leave("ask", "Did you get on?", time: "left 7:48am", emoji: "", island: "Got on?")),
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
                RideCardView(tripName: "Office → Home", state: state)
                    .background(Theme.of(scheme).card)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
            }
            Text("Dynamic Island: compact (riding, next stop, here, no stop list, transfer, walking), expanded, minimal").font(.caption).foregroundStyle(.white)
            ForEach([samples[0].1, samples[3].1, samples[4].1, samples[5].1, samples[6].1, samples[10].1], id: \.self) { state in
                HStack { IslandLeading(state: state); Spacer(); IslandTrailing(state: state) }
                    .padding(.horizontal, 14).frame(width: 250, height: 37)
                    .background(.black).clipShape(Capsule()).foregroundStyle(.white)
                    .environment(\.colorScheme, .dark)
                    .frame(maxWidth: .infinity)
            }
            Expanded(tripName: "Office → Home", state: samples[0].1)
            Expanded(tripName: "Office → Home", state: samples[1].1)
            Expanded(tripName: "Office → Home", state: samples[6].1)
            RouteDot(hex: orange, size: 10).frame(width: 37, height: 37).background(.black).clipShape(Circle()).frame(maxWidth: .infinity)
        }
        .padding(16)
        .frame(width: 400)
        .background(LinearGradient(colors: scheme == .dark ? [Color(hex: "232A3A"), Color(hex: "0B0D12")] : [Color(hex: "5B6B8C"), Color(hex: "2C3447")],
                                   startPoint: .topLeading, endPoint: .bottomTrailing))
    }
}

// The leave-times widget without a countdown (Phase 3b).
private func plain(_ title: String, next: String) -> WidgetView.Entry { WidgetView.Entry(at: 0, row: -1, title: title, count: "", warn: false, next: next) }
private let plainSamples: [(String, LeaveContent)] = [
    ("No more today", LeaveContent(name: "Home → Work", entry: plain("No more today", next: "First 5:12am"), rows: [])),
    ("Set up", LeaveContent(name: "", entry: plain("Plan a trip in T-Minus", next: ""), rows: [])),
    ("Stale", .stale("Home → Work")),
]

// The Home Screen layouts of 2026-10-29: the answer's `long`, `headsign` and `headTime`.
private func hrow(_ time: String, _ arrive: String, long: String, short: String, headsign: String, color: String, label: String,
                  then: [(String, String)] = []) -> WidgetView.Row {
    WidgetView.Row(time: time, vehicle: short, short: short, color: color, label: label, line: short, arrive: "arrive \(arrive)", arriveTitle: "Arrive \(arrive)",
                   long: long, headsign: headsign, then: then.map { WidgetView.Row.Leg(label: $0.0, color: $0.1) })
}
private func hent(_ head: String, _ headTime: String, warn: Bool = false) -> WidgetView.Entry {
    WidgetView.Entry(at: 0, row: 0, title: head, count: "", warn: warn, next: "", head: head, headTime: headTime)
}
// A followed ride (2026-10-31): the entry's own line, arrival, note and connection.
private func fent(_ head: String, _ headTime: String = "", warn: Bool = false, long: String = "Orange Line", headsign: String = "Oak Grove", color: String = orange,
                  arrive: String = "arrive 7:21pm", note: String = "", then: [(String, String)] = [("Bus 132", bus)], thenText: String = "", thenWarn: Bool = false) -> LeaveContent {
    var e = WidgetView.Entry(at: 0, row: -1, title: head, count: "", warn: warn, next: "", head: head, headTime: headTime)
    e.long = long; e.headsign = headsign; e.color = color; e.arrive = arrive; e.note = note
    e.then = then.map { RideState.ThenLeg(label: $0.0, color: $0.1) }; e.thenText = thenText; e.thenWarn = thenWarn
    return LeaveContent(name: "Office → Home", entry: e, rows: [])
}
private let followSamples: [(String, LeaveContent)] = [
    ("Walking to the stop", fent("Departs in 6 min", "6:15pm", note: "At the stop ~6:13pm · 2 min to spare")),
    ("Walking, late", fent("Departs in 3 min", "6:15pm", warn: true, note: "At the stop ~6:17pm · 2 min late")),
    ("Did you get on?", fent("Did you get on?", "left 6:15pm")),
    ("Riding", fent("Get off in 5 stops", "9 min", thenText: "6:38pm · 4 min to spare")),
    ("Riding, tight", fent("Get off in 5 stops", "9 min", thenText: "6:38pm · tight", thenWarn: true)),
    ("Riding, missed", fent("Get off in 5 stops", "9 min", arrive: "arrive 7:41pm", thenText: "6:58pm (missed 6:38pm)", thenWarn: true)),
    ("Next stop", fent("Get off next stop", "2 min", thenText: "6:38pm · 4 min to spare")),
    ("Get off here", fent("Get off here", thenText: "6:38pm · 4 min to spare")),
    ("No stop list", fent("Get off in 9 min", thenText: "6:38pm · 4 min to spare")),
    ("Transfer", fent("Bus 132 in 6 min", "6:38pm", long: "Bus 132", headsign: "Redstone", color: bus, note: "4 min to spare", then: [])),
    ("Transfer, tight", fent("Bus 132 in 2 min", "6:38pm", warn: true, long: "Bus 132", headsign: "Redstone", color: bus, note: "tight", then: [])),
    ("Walking to the destination", fent("Arrive in 5 min", "7:21pm", long: "", headsign: "", color: "", arrive: "", then: [])),
    ("Arrived", fent("Arrived", "7:21pm", long: "", headsign: "", color: "", arrive: "", then: [])),
]
private let ol = { (t: String, a: String) in hrow(t, a, long: "Orange Line", short: "Orange", headsign: "Forest Hills", color: orange, label: "OL") }
private let rl = { (t: String, a: String, h: String) in hrow(t, a, long: "Red Line", short: "Red", headsign: h, color: "DA291C", label: "RL") }
private let gl = { (t: String, a: String, b: String, h: String) in hrow(t, a, long: "Green Line \(b)", short: "Green \(b)", headsign: h, color: "00843D", label: "GL·\(b)") }
private let orangeRows = [hrow("6:33pm", "7:21pm", long: "Orange Line", short: "Orange", headsign: "Oak Grove", color: orange, label: "OL", then: [("Bus 132", bus)]),
                          ol("7:31pm", "8:17pm"), ol("8:32pm", "9:17pm")]
private let homeSamples: [(String, LeaveContent)] = [
    ("Leave in (two legs)", LeaveContent(name: "Office → Home", entry: hent("Leave in 17 min", "6:33pm"), rows: orangeRows)),
    ("Departs", LeaveContent(name: "Office → Home", entry: hent("Departs in 7 min", "6:43pm", warn: true), rows: orangeRows)),
    ("Widest countdown", LeaveContent(name: "Office → Home", entry: hent("Leave in 59 min", "6:33pm"), rows: orangeRows)),
    ("Three legs", LeaveContent(name: "Home → Airport", entry: hent("Leave in 9 min", "7:42am"),
        rows: [hrow("7:42am", "8:51am", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132",
                    then: [("Orange", orange), ("Silver SL1", "7C878E")])])),
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
            Text("Home Screen small: leave in, departs, widest, three legs, an hour+ ahead, long headsign, Red branches, Green C or D").font(.caption).foregroundStyle(.white)
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
            Text("Following a ride (2026-10-31): small, then medium").font(.caption).foregroundStyle(.white)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                ForEach(Array(stride(from: 0, to: followSamples.count, by: 2)), id: \.self) { i in
                    GridRow {
                        home(followSamples[i].1, .small, width: 170)
                        if i + 1 < followSamples.count { home(followSamples[i + 1].1, .small, width: 170) }
                    }
                }
            }
            ForEach(followSamples.indices, id: \.self) { i in
                Text(followSamples[i].0).font(.caption).foregroundStyle(.white)
                home(followSamples[i].1, .medium, width: 338)
            }
            Text("No countdown: no more today, set up, stale (small, medium)").font(.caption).foregroundStyle(.white)
            ForEach(plainSamples.indices, id: \.self) { i in
                HStack(spacing: 12) { home(plainSamples[i].1, .small, width: 170); home(plainSamples[i].1, .medium, width: 200) }
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
