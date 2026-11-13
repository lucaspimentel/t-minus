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
// The legs bar's stop shares (2026-11-13): the Orange leg's 8 stops, the bus's 20 (some are skipped
// where they'd be closer than 14 pt).
private func withAt(_ l: [RideState.Leg], _ at: [[Double]?]) -> [RideState.Leg] {
    zip(l, at).map { var leg = $0.0; leg.at = $0.1; return leg }
}
private let orangeAt: [Double] = [0.1, 0.22, 0.33, 0.45, 0.58, 0.7, 0.82, 0.92]
private let busAt: [Double] = (1...20).map { Double($0) / 21 }
private let trip = withAt(legs((orange, -8, 6), (bus, 14, 44)), [orangeAt, busAt]) // 14 and 30 min: proportional segments

// Ride cards in the leave card's layout (2026-10-31): Office → Home, the Orange Line to Oak Grove,
// then the 6:38pm Bus 132.
private func ride(_ phase: String, _ head: String, countTo: Double = 0, after: Bool = false, time: String = "", warn: Bool = false,
                  long: String = "Orange Line", headsign: String = "Oak Grove", color: String = orange, right: String = "arrive 7:21pm", note: String = "",
                  then: [(String, String)] = [], thenText: String = "", nextWarn: Bool = false, emoji: String = "🚇", island: String = "",
                  dropOff: String = "", thenState: String = "", legs: [RideState.Leg] = trip, late: Bool = false, nextLate: Bool = false, stops: Int = -1) -> RideState {
    var st = RideState(phase: phase, warn: warn, color: color, label: color == bus ? "132" : color.isEmpty ? "" : "OL", title: head, until: countTo, stops: stops,
                       sub: "", next: "", legs: legs, soon: false, nextWarn: nextWarn)
    st.head = head; st.countTo = countTo; st.countAfter = after; st.headTime = time; st.long = long; st.headsign = headsign; st.right = right
    st.note = note; st.emoji = emoji; st.islandText = island; st.then = then.map { RideState.ThenLeg(label: $0.0, color: $0.1) }; st.thenText = thenText
    if !dropOff.isEmpty { st.dropOff = dropOff; st.headsign = ""; st.thenState = thenState }
    st.late = late; st.nextLate = nextLate
    return st
}
private let busNext = [("Bus 132", bus)]
private let atTransfer = withAt(legs((orange, -20, -6), (bus, 6, 30)), [orangeAt, busAt])
private let samples: [(String, RideState)] = [
    // Riding (2026-11-06): "● Orange Line to Oak Grove", then "then ● Bus 132 at 6:38pm" with the
    // arrival, the time amber when tight, red when missed; the last leg: "Arrive 7:21pm" alone.
    ("Riding", ride("riding", "Get off in 5 stops", countTo: now + 540, after: true, then: busNext, thenText: "at 6:38pm", island: "5 stops", dropOff: "Oak Grove", stops: 5)),
    ("Riding, tight connection", ride("riding", "Get off in 5 stops", countTo: now + 540, after: true, then: busNext, thenText: "at 6:38pm", nextWarn: true, island: "5 stops",
                                      dropOff: "Oak Grove", thenState: "tight", stops: 5)),
    ("Riding, missed connection", ride("riding", "Get off in 5 stops", countTo: now + 540, after: true, warn: true, right: "arrive 7:41pm", then: busNext,
                                       thenText: "at 6:58pm", nextWarn: true, island: "5 stops", dropOff: "Oak Grove", thenState: "missed", late: true, stops: 5)),
    ("Next stop", ride("riding", "Get off next stop", countTo: now + 120, after: true, then: busNext, thenText: "at 6:38pm", island: "next", dropOff: "Oak Grove", stops: 1)),
    ("Get off here", ride("riding", "Get off here", then: busNext, thenText: "at 6:38pm", island: "here", dropOff: "Oak Grove")),
    ("Riding, last leg, long stop name", ride("riding", "Get off in 9 stops", countTo: now + 840, after: true, long: "Bus 132", color: bus, right: "arrive 6:52pm", emoji: "🚌",
                                              island: "9 stops", dropOff: "Washington St opp Ruggles St", legs: legs((bus, -5, 14)))),
    ("Riding, flag stop", ride("riding", "Get off in 3 stops", countTo: now + 660, after: true, long: "Haverhill Line", color: "80276C", emoji: "🚆",
                               island: "3 stops", dropOff: "🚩 Malden Center", legs: legs(("80276C", -5, 11)))),
    ("No stop list yet (the dots fill by time)", ride("riding", "Get off in", countTo: now + 540, then: busNext, thenText: "at 6:38pm")),
    // An older server or no stop list on the phone: the ends and the transfer only.
    ("Old payload (no stop shares)", ride("riding", "Get off in 5 stops", countTo: now + 540, after: true, then: busNext, thenText: "at 6:38pm", island: "5 stops", dropOff: "Oak Grove",
                                          legs: legs((orange, -8, 6), (bus, 14, 44)), stops: 5)),
    ("Transfer", ride("transfer", "Bus 132 in", countTo: now + 360, time: "6:38pm", long: "Bus 132", headsign: "Redstone", color: bus, note: "4 min to spare",
                      emoji: "🚌", legs: atTransfer)),
    ("Transfer, tight", ride("transfer", "Bus 132 in", countTo: now + 120, time: "6:38pm", warn: true, long: "Bus 132", headsign: "Redstone", color: bus, note: "tight",
                             emoji: "🚌", legs: atTransfer)),
    ("Missed connection", ride("transfer", "Bus 132 in", countTo: now + 420, time: "6:58pm", warn: true, long: "Bus 132", headsign: "Redstone", color: bus,
                               right: "arrive 7:41pm", note: "Missed the 6:38pm", emoji: "🚌", legs: atTransfer, late: true)),
    ("No connection", ride("transfer", "No connection after 6:31pm", warn: true, long: "", color: bus, right: "", note: "Open the app for another way.", emoji: "",
                           legs: atTransfer, late: true)),
    ("Walking", ride("walking", "Arrive in", countTo: now + 300, time: "7:21pm", long: "", color: "", right: "", emoji: "🚶", legs: legs((orange, -30, -16), (bus, -12, -1)))),
    ("Arrived", ride("arrived", "Arrived", time: "7:21pm", long: "", color: "", right: "", emoji: "", legs: legs((orange, -30, -16), (bus, -12, -4)))),
    // 2026-11-08: no connection ahead: the whole line red (`nextLate`), the headline plain.
    ("Riding, no connection", ride("riding", "Get off in 5 stops", countTo: now + 540, after: true, warn: true, thenText: "No connection after 6:31pm", nextWarn: true,
                                   island: "5 stops", dropOff: "Oak Grove", late: true, nextLate: true)),
]

// Leave cards (Phase 3a; the layout of 2026-10-29): Home to office, the 7:48 bus 132.
private let ahead = withAt(legs((bus, 9, 23), (orange, 27, 36)), [busAt, orangeAt])
private func leave(_ phase: String, _ head: String, countTo: Double = 0, time: String = "", warn: Bool = false, right: String = "arrive 8:25am",
                   note: String = "", emoji: String = "🚶", island: String = "", long: String = "Bus 132", soon: Bool = false, late: Bool = false) -> RideState {
    var st = RideState(phase: phase, warn: warn, color: bus, label: "132", title: head, until: countTo, stops: -1, sub: "", next: "", legs: ahead,
                       soon: soon, island: island, join: " ")
    st.head = head; st.countTo = countTo; st.headTime = time; st.long = long; st.headsign = long.isEmpty ? "" : "Malden"
    st.right = right; st.note = note; st.emoji = emoji; st.then = long.isEmpty ? [] : [RideState.ThenLeg(label: "Orange", color: orange)]
    st.late = late
    return st
}
private let leaveSamples: [(String, RideState)] = [
    ("An hour+ ahead", leave("early", "Leave in", countTo: now + 74 * 60 + 30, time: "7:39am")),
    ("Moved", leave("leave", "Leave in", countTo: now + 25 * 60 + 30, time: "7:42am", warn: true, right: "arrive 8:28am", note: "Moved (was 7:39am)")),
    ("Leave in (10-min heads-up)", leave("leave", "Leave in", countTo: now + 540, time: "7:39am")),
    ("Leave in 28 min", leave("leave", "Leave in", countTo: now + 28 * 60 + 30, time: "7:58am", right: "arrive 8:44am")),
    ("Leave in <1 minute", leave("leave", "Leave in", countTo: now + 50, time: "7:39am", soon: true)),
    ("Past the leave-by", leave("now", "Departs in", countTo: now + 420, time: "7:48am", warn: true, emoji: "🚌")),
    // 2026-11-08: amber to the last chance ("now"), red past it ("departs", `late`), muted once gone.
    ("Departs in (subway), too late", { var st = leave("departs", "Departs in", countTo: now + 120, time: "7:48am", warn: true, emoji: "🚇", long: "Orange Line", late: true)
        st.color = orange; st.label = "OL"; st.headsign = "Forest Hills"; return st }()),
    ("Walk card", leave("walk", "Departs in", countTo: now + 360, time: "7:48am", note: "At the stop ~7:45am · 3 min to spare", emoji: "🚌")),
    ("Walk card, late", leave("walk", "Departs in", countTo: now + 120, time: "7:48am", warn: true, note: "At the stop ~7:50am · 2 min late", emoji: "🚌", late: true)),
    ("Did you get on? (at the departure; Yes / Missed it)", { var st = leave("ask", "Did you get on?", time: "left 7:48am", emoji: "", island: "Got on?")
        st.askDep = now - 60; return st }()),
    ("Missed (the end)", leave("gone", "Missed · left 7:48am", warn: true, right: "", emoji: "")),
    ("Ride cancelled", leave("cancelled", "Ride cancelled", right: "", note: "Open the app for the next one.", emoji: "", long: "")),
]

// The cards on the dimmed Always-On screen: the headline's time instead of the dashed countdown.
private func dimmedOf(_ list: [(String, RideState)], _ names: [String]) -> [(String, RideState)] {
    list.filter { sample in names.contains { sample.0.hasPrefix($0) } }
}
private let leaveDimmed = dimmedOf(leaveSamples, ["An hour+ ahead", "Leave in 28 min", "Leave in <1 minute", "Past the leave-by", "Walk card, late", "Did you get on?"])
private let rideDimmed = dimmedOf(samples, ["Riding", "Next stop", "No stop list yet", "Transfer", "Walking", "Arrived"])

private struct Dimmed: View {
    let tripName: String
    let list: [(String, RideState)]
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Text("Dimmed (Always-On)").font(.caption).foregroundStyle(.white)
        ForEach(list, id: \.0) { name, state in
            Text(name).font(.caption).foregroundStyle(.white)
            RideCardView(tripName: tripName, state: state)
                .environment(\.isLuminanceReduced, true)
                .background(Theme.of(scheme).card)
                .clipShape(RoundedRectangle(cornerRadius: 22))
        }
    }
}

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
            Dimmed(tripName: "Home to office", list: leaveDimmed)
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
            Dimmed(tripName: "Office → Home", list: rideDimmed)
            Text("Dynamic Island: compact (riding, next stop, here, no stop list, transfer, walking), expanded, minimal").font(.caption).foregroundStyle(.white)
            // Then the leave cards past the leave-by: amber, red too late, red walking late.
            ForEach([samples[0].1, samples[3].1, samples[4].1, samples[5].1, samples[6].1, samples[10].1,
                     leaveSamples[5].1, leaveSamples[6].1, leaveSamples[8].1], id: \.self) { state in
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
private func hent(_ head: String, _ headTime: String, warn: Bool = false, late: Bool = false) -> WidgetView.Entry {
    var e = WidgetView.Entry(at: 0, row: 0, title: head, count: "", warn: warn, next: "", head: head, headTime: headTime)
    e.late = late
    return e
}
// A followed ride (2026-10-31): the entry's own line, arrival, note and connection.
private func fent(_ head: String, _ headTime: String = "", warn: Bool = false, long: String = "Orange Line", headsign: String = "Oak Grove", color: String = orange,
                  arrive: String = "arrive 7:21pm", note: String = "", then: [(String, String)] = [("Bus 132", bus)], thenText: String = "", thenWarn: Bool = false,
                  dep: Double? = nil, dropOff: String? = nil, thenState: String? = nil, late: Bool = false, thenLate: Bool = false,
                  bar: [RideState.Leg] = [], stops: Int? = nil) -> LeaveContent {
    var e = WidgetView.Entry(at: now, row: -1, title: head, count: "", warn: warn, next: "", head: head, headTime: headTime)
    e.long = long; e.headsign = dropOff == nil ? headsign : ""; e.color = color; e.arrive = arrive; e.note = note
    e.then = then.map { RideState.ThenLeg(label: $0.0, color: $0.1) }; e.thenText = thenText; e.thenWarn = thenWarn; e.dep = dep
    e.dropOff = dropOff; e.thenState = thenState; e.late = late; e.thenLate = thenLate
    if !bar.isEmpty { e.bar = true; e.stops = stops } // the legs bar (2026-11-13)
    return LeaveContent(name: "Office → Home", entry: e, rows: [], legs: bar)
}
private let walkLegs = withAt(legs((orange, 6, 20), (bus, 23, 53)), [orangeAt, busAt])
private let doneLegs = legs((orange, -30, -16), (bus, -12, -4))
private let followSamples: [(String, LeaveContent)] = [
    ("Walking to the stop", fent("Departs in 6 min", "6:15pm", note: "At the stop ~6:13pm · 2 min to spare", bar: walkLegs)),
    ("Walking, late", fent("Departs in 3 min", "6:15pm", warn: true, note: "At the stop ~6:17pm · 2 min late", late: true, bar: walkLegs)),
    ("Did you get on? (Yes / Missed it on medium)", fent("Did you get on?", "left 6:15pm", dep: now - 60)),
    ("Riding", fent("Get off in 5 stops", "9 min", thenText: "at 6:38pm", dropOff: "Oak Grove", bar: trip, stops: 5)),
    ("Riding, tight", fent("Get off in 5 stops", "9 min", thenText: "at 6:38pm", thenWarn: true, dropOff: "Oak Grove", thenState: "tight", bar: trip, stops: 5)),
    ("Riding, missed", fent("Get off in 5 stops", "9 min", arrive: "arrive 7:41pm", thenText: "at 6:58pm", thenWarn: true, dropOff: "Oak Grove", thenState: "missed", bar: trip, stops: 5)),
    ("Next stop", fent("Get off next stop", "2 min", thenText: "at 6:38pm", dropOff: "Oak Grove", bar: trip, stops: 1)),
    ("Get off here", fent("Get off here", thenText: "at 6:38pm", dropOff: "Oak Grove", bar: trip, stops: 1)),
    ("Riding, last leg", fent("Get off in 9 stops", "14 min", long: "Bus 132", color: bus, arrive: "arrive 6:52pm", then: [], dropOff: "Washington St opp Ruggles St",
                             bar: withAt(legs((bus, -5, 14)), [busAt]), stops: 9)),
    ("No stop list (the dots fill by time)", fent("Get off in 9 min", thenText: "at 6:38pm", bar: trip)),
    ("Transfer", fent("Bus 132 in 6 min", "6:38pm", long: "Bus 132", headsign: "Redstone", color: bus, note: "4 min to spare", then: [], bar: atTransfer)),
    ("Transfer, tight", fent("Bus 132 in 2 min", "6:38pm", warn: true, long: "Bus 132", headsign: "Redstone", color: bus, note: "tight", then: [], bar: atTransfer)),
    ("Walking to the destination", fent("Arrive in 5 min", "7:21pm", long: "", headsign: "", color: "", arrive: "", then: [], bar: doneLegs)),
    ("Arrived", fent("Arrived", "7:21pm", long: "", headsign: "", color: "", arrive: "", then: [], bar: doneLegs)),
    ("Riding, no connection", fent("Get off in 5 stops", "9 min", then: [], thenText: "No connection after 6:31pm", thenWarn: true, dropOff: "Oak Grove", thenLate: true, bar: trip, stops: 5)),
    ("Missed connection", fent("Bus 132 in 7 min", "6:58pm", warn: true, long: "Bus 132", headsign: "Redstone", color: bus, arrive: "arrive 7:41pm",
                               note: "Missed the 6:38pm", then: [], late: true, bar: atTransfer)),
]
private let ol = { (t: String, a: String) in hrow(t, a, long: "Orange Line", short: "Orange", headsign: "Forest Hills", color: orange, label: "OL") }
private let rl = { (t: String, a: String, h: String) in hrow(t, a, long: "Red Line", short: "Red", headsign: h, color: "DA291C", label: "RL") }
private let gl = { (t: String, a: String, b: String, h: String) in hrow(t, a, long: "Green Line \(b)", short: "Green \(b)", headsign: h, color: "00843D", label: "GL·\(b)") }
private let orangeRows = [hrow("6:33pm", "7:21pm", long: "Orange Line", short: "Orange", headsign: "Oak Grove", color: orange, label: "OL", then: [("Bus 132", bus)]),
                          ol("7:31pm", "8:17pm"), ol("8:32pm", "9:17pm")]
private let homeSamples: [(String, LeaveContent)] = [
    ("Leave in (two legs)", LeaveContent(name: "Office → Home", entry: hent("Leave in 17 min", "6:33pm"), rows: orangeRows)),
    // Belled (2026-11-13): the legs bar under the row; the plain leave times above have none.
    ("Belled (legs bar)", { var e = hent("Leave in 17 min", "6:33pm"); e.at = now; e.bar = true
        return LeaveContent(name: "Office → Home", entry: e, rows: orangeRows, legs: walkLegs) }()),
    ("Departs", LeaveContent(name: "Office → Home", entry: hent("Departs in 7 min", "6:43pm", warn: true), rows: orangeRows)),
    ("Departs, too late", LeaveContent(name: "Office → Home", entry: hent("Departs in 2 min", "6:43pm", warn: true, late: true), rows: orangeRows)),
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

// The large size (2026-11-13): leave times (More rides, Trip timeline), and the followed states on
// the app's timeline, at 338 × 354 (6.1"). The trip: Bus 132 Main St @ South St 7:48am → Malden
// Center 8:05am, Orange Line → Downtown Crossing 8:31am, walk 6 min, arrive 8:37am.
private typealias TL = WidgetView.TLRow
private func tw(_ text: String, walking: Bool = true) -> TL { TL(kind: "walk", text: text, walking: walking) }
private func ts(_ name: String, _ time: String, _ color: String, start: Bool) -> TL { TL(kind: "stop", name: name, time: time, color: color, bar: start ? "start" : "end") }
private func tr(_ text: String, _ toward: String, _ color: String) -> TL { TL(kind: "ride", text: text, color: color, toward: toward) }
private func tleg(_ from: String, _ dep: String, _ ride: String, _ toward: String, _ to: String, _ arr: String, _ color: String) -> [TL] {
    [ts(from, dep, color, start: true), tr(ride, toward, color), ts(to, arr, color, start: false)]
}
private let busLeg = tleg("Main St @ South St", "7:48am", "Bus 132 · 6 stops · 17 min", "toward Malden", "Malden Center", "8:05am", bus)
private let olLeg = tleg("Malden Center", "8:11am", "Orange Line · 8 stops · 20 min", "toward Forest Hills", "Downtown Crossing", "8:31am", orange)
private let tripTL = busLeg + [tw("6 min to transfer")] + olLeg + [tw("Walk 6 min"), TL(kind: "end", name: "Arrive", time: "8:37am")]
private let leaveTL = [tw("Walk 4 min · 2 min early at the stop")] + tripTL
private func marks(_ done: Int, _ current: Int, _ hide: Int, along: WidgetView.TLMarks.Along? = nil) -> WidgetView.TLMarks {
    WidgetView.TLMarks(done: done, current: current, hide: hide, along: along)
}
private func alongStops(_ names: [String], from minute: Int) -> [WidgetView.TLMarks.Stop] {
    names.enumerated().map { i, n -> WidgetView.TLMarks.Stop in
        let m = 7 * 60 + minute + 2 * i
        return n.hasPrefix("…") ? .init(more: n) : .init(name: n, time: "\(m / 60):\(String(format: "%02d", m % 60))am")
    }
}
private let busRow = hrow("7:42am", "8:37am", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132", then: [("Orange", orange)])
private let laterRows = [hrow("7:57am", "8:52am", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132"),
                         hrow("8:12am", "9:04am", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132"),
                         hrow("8:24am", "9:12am", long: "Bus 137", short: "Bus 137", headsign: "Malden", color: bus, label: "137"),
                         hrow("8:42am", "~9:31am", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132"),
                         hrow("8:57am", "~9:46am", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132")]
// Two-digit hours (the "Later" time column cut "10:16am" and wrapped "12:16pm", 2026-11-13).
private let lateRows = [hrow("8:37am", "9:28am", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132"),
                        hrow("9:17am", "10:02am", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132"),
                        hrow("10:16am", "11:02am", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132"),
                        hrow("11:16am", "12:04pm", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132"),
                        hrow("12:16pm", "1:04pm", long: "Bus 132", short: "Bus 132", headsign: "Malden", color: bus, label: "132")]
// "More rides" (`timeline` false): the server sends no timeline.
private func leaveLarge(_ e: WidgetView.Entry, hide: Int, timeline: Bool, later: [WidgetView.Row]? = nil) -> LeaveContent {
    var e = e
    e.tl = timeline ? marks(0, 0, hide) : nil
    var first = busRow
    first.timeline = timeline ? leaveTL : nil
    return LeaveContent(name: "To work", entry: e, rows: [first] + (later ?? laterRows), timeline: first.timeline)
}
private func followLarge(_ head: String, _ headTime: String, note: String = "", warn: Bool = false, late: Bool = false, dep: Double? = nil,
                         tl: WidgetView.TLMarks?, rows: [TL] = tripTL) -> LeaveContent {
    var e = WidgetView.Entry(at: 0, row: -1, title: head, count: "", warn: warn, next: "", head: head, headTime: headTime)
    e.note = note; e.late = late; e.dep = dep; e.tl = tl
    e.long = ""; e.arrive = ""
    return LeaveContent(name: "To work", entry: e, rows: [], timeline: tl == nil ? nil : rows)
}
private let ride5 = WidgetView.TLMarks.Along(after: 1, veh: "gap", stops: alongStops(["Main St @ Salem St", "Main St @ Eastern Ave", "Pleasant St @ Commercial St", "Centre St @ Main St"], from: 57))
private let ride9 = WidgetView.TLMarks.Along(after: 1, veh: "gap", stops: alongStops(["Main St @ Wyoming Ave", "Main St @ Highland Ave", "… 5 more", "Centre St @ Main St"], from: 51))
private let boarding = WidgetView.TLMarks.Along(after: 1, veh: "board", stops: alongStops(["Main St @ Wyoming Ave", "Main St @ Highland Ave", "… 2 more", "Centre St @ Main St"], from: 50))
private let olAlong = WidgetView.TLMarks.Along(after: 5, veh: "gap", stops: [.init(name: "Haymarket", time: "8:26am"), .init(name: "State", time: "8:28am")])
private let longTL = tleg("Washington St opp Ruggles St Station Busway", "7:12am", "Bus 28 · 14 stops · 22 min", "toward Mattapan Station", "Nubian Station Lower Busway", "7:34am", bus)
    + [tw("5 min to transfer")] + tleg("Nubian Station", "7:39am", "Silver Line SL5 · 9 stops · 18 min", "toward Downtown Crossing", "Tremont St @ Boylston Station", "7:57am", "7C878E")
    + [tw("4 min to transfer")] + tleg("Boylston", "8:01am", "Green Line D · 11 stops · 24 min", "toward Riverside", "Brookline Hills", "8:25am", "00843D")
    + [tw("Walk 9 min"), TL(kind: "end", name: "Arrive", time: "8:34am")]
private let largeSamples: [(String, LeaveContent)] = [
    ("Leave · More rides (default)", leaveLarge(hent("Leave in 9 min", "7:42am"), hide: -1, timeline: false)),
    ("Leave · More rides, two-digit hours", leaveLarge(hent("Leave in 15 min", "8:02am"), hide: -1, timeline: false, later: lateRows)),
    ("Leave · Trip timeline", leaveLarge(hent("Leave in 9 min", "7:42am"), hide: -1, timeline: true)),
    ("Departs · Trip timeline (boarding time hidden)", leaveLarge(hent("Departs in 7 min", "7:48am", warn: true), hide: 1, timeline: true)),
    ("Departs, too late · More rides", leaveLarge(hent("Departs in 2 min", "7:48am", warn: true, late: true), hide: 1, timeline: false)),
    ("Walking", followLarge("Departs in 6 min", "7:48am", note: "At the stop ~7:46am · 2 min to spare", tl: marks(0, 0, 0))),
    ("Walking, late", followLarge("Departs in 3 min", "7:48am", note: "At the stop ~7:50am · 2 min late", warn: true, late: true, tl: marks(0, 0, 0))),
    ("Did you get on?", followLarge("Did you get on?", "left 7:48am", dep: now - 60, tl: marks(0, 0, 0))),
    ("Riding, 5 stops left", followLarge("Get off in 5 stops", "9 min", tl: marks(1, 2, 2, along: ride5))),
    ("Riding, 9 stops left", followLarge("Get off in 9 stops", "14 min", tl: marks(1, 2, 2, along: ride9))),
    ("Riding, at the boarding stop", followLarge("Get off in 6 stops", "17 min", tl: marks(1, 2, 2, along: boarding))),
    ("Riding, last leg", followLarge("Get off in 3 stops", "7 min", tl: marks(5, 2, 6, along: olAlong))),
    ("Transfer", followLarge("Orange in 5 min", "8:11am", note: "4 min to spare", tl: marks(3, 2, 4))),
    ("Transfer, tight", followLarge("Orange in 2 min", "8:11am", note: "tight", warn: true, tl: marks(3, 2, 4))),
    ("Missed connection", followLarge("Orange in 7 min", "8:17am", note: "Missed the 8:11am", warn: true, late: true, tl: marks(3, 2, 4))),
    ("Final walk", followLarge("Arrive in 6 min", "8:37am", tl: marks(7, 2, 8))),
    ("Three legs, long names (overflow)", followLarge("Get off in 9 stops", "14 min", tl: marks(1, 2, 2, along: ride9), rows: longTL)),
    ("Arrived (the medium's layout)", followLarge("Arrived", "8:37am", tl: nil)),
    ("Old answer, no timeline (fallback)", fent("Get off in 5 stops", "9 min", thenText: "at 6:38pm", dropOff: "Oak Grove")),
    ("No more today", plainSamples[0].1),
    ("Set up", plainSamples[1].1),
    ("Stale", plainSamples[2].1),
]

private struct LargeWidgetSheet: View {
    @Environment(\.colorScheme) private var scheme
    private func cell(_ i: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(largeSamples[i].0).font(.caption).foregroundStyle(.white)
            LeaveWidgetView(content: largeSamples[i].1, size: .large).padding(16).frame(width: 338, height: 354)
                .background(Theme.of(scheme).card).clipShape(RoundedRectangle(cornerRadius: 22))
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Home Screen large (2026-11-13), 6.1\": leave times, then following a ride").font(.caption).foregroundStyle(.white)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                ForEach(Array(stride(from: 0, to: largeSamples.count, by: 3)), id: \.self) { i in
                    GridRow {
                        cell(i)
                        if i + 1 < largeSamples.count { cell(i + 1) }
                        if i + 2 < largeSamples.count { cell(i + 2) }
                    }
                }
            }
        }
        .padding(16)
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
            try write(LargeWidgetSheet().environment(\.colorScheme, scheme), "widget-large-\(name).png")
        }
    }
}
