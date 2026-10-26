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

// Leave cards (Phase 3a): Home to office, the 7:48 bus 132.
private let ahead = legs((bus, 9, 23), (orange, 27, 36))
private func leave(_ phase: String, _ title: String, until: Double, warn: Bool = false, island: String, sub: String = "Bus 132 toward Malden at 7:48am",
                   next: String, soon: Bool = false) -> RideState {
    RideState(phase: phase, warn: warn, color: bus, label: "132", title: title, until: until, stops: -1, sub: sub, next: next, legs: ahead,
              soon: soon, island: island, join: " ")
}
private let leaveSamples: [(String, RideState)] = [
    ("Leave at (an hour+ ahead)", leave("early", "Leave at 7:39am", until: 0, island: "Leave 7:39am", next: "Arrive ~8:25am")),
    ("Leave at, moved", leave("early", "Leave at 7:42am", until: 0, warn: true, island: "Leave 7:42am", next: "Moved (was 7:39am) · arrive ~8:28am")),
    ("Leave in (10-min heads-up)", leave("leave", "Leave in", until: now + 540, island: "Leave", next: "Leave by 7:39am · arrive ~8:25am")),
    ("Leave-by moved", leave("leave", "Leave in", until: now + 360, warn: true, island: "Leave", next: "Leave by 7:36am (was 7:39am)")),
    ("Leave in <1 minute", leave("leave", "Leave in", until: now + 50, island: "Leave", next: "Leave by 7:39am · arrive ~8:25am", soon: true)),
    ("Leave now", leave("now", "Leave now", until: 0, warn: true, island: "Leave now", next: "Last chance 7:42am")),
    ("Departs in", leave("departs", "Departs in", until: now + 120, warn: true, island: "Departs", next: "Too late at your walking pace")),
    ("Missed (the end)", RideState(phase: "gone", warn: true, color: bus, label: "132", title: "Missed · left 7:48am", until: 0, stops: -1,
                                   sub: "Bus 132 toward Malden at 7:48am", next: "", legs: ahead, island: "", join: " · ")),
    ("Ride cancelled", RideState(phase: "cancelled", warn: false, color: bus, label: "132", title: "Ride cancelled", until: 0, stops: -1,
                                 sub: "", next: "Open the app for the next one.", legs: ahead, island: "", join: " · ")),
    ("Did you get on? (at the departure)", leave("ask", "Did you get on?", until: 0, island: "Got on?", sub: "Bus 132 toward Malden left at 7:48am", next: "Tap to answer")),
    ("Walk card", leave("walk", "Bus 132 in", until: now + 360, island: "Departs", sub: "At the stop ~7:45am · 3 min to spare", next: "Arrive ~8:25am")),
    ("Walk card, late", leave("walk", "Bus 132 in", until: now + 120, warn: true, island: "Departs", sub: "At the stop ~7:50am · 2 min late", next: "Arrive ~8:25am")),
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
            Text("Dynamic Island: compact (leave at, leave at moved, leave, <1 min, leave now, departs, got on?, walk, walk late), expanded").font(.caption).foregroundStyle(.white)
            // By name, so a new sample doesn't shift which ones are drawn.
            ForEach(["Leave at (an hour+ ahead)", "Leave at, moved", "Leave in (10-min heads-up)", "Leave in <1 minute", "Leave now", "Departs in", "Did you get on? (at the departure)", "Walk card", "Walk card, late"], id: \.self) { name in
                Compact(state: leaveSamples.first { $0.0 == name }!.1)
            }
            IslandExpanded(state: leaveSamples.first { $0.0 == "Leave in (10-min heads-up)" }!.1)
                .padding(18).background(.black).clipShape(RoundedRectangle(cornerRadius: 36))
                .environment(\.colorScheme, .dark)
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
            IslandExpanded(state: samples[0].1)
                .padding(18).background(.black).clipShape(RoundedRectangle(cornerRadius: 36))
                .environment(\.colorScheme, .dark)
            RouteDot(hex: orange, size: 10).frame(width: 37, height: 37).background(.black).clipShape(Circle()).frame(maxWidth: .infinity)
        }
        .padding(16)
        .frame(width: 400)
        .background(LinearGradient(colors: scheme == .dark ? [Color(hex: "232A3A"), Color(hex: "0B0D12")] : [Color(hex: "5B6B8C"), Color(hex: "2C3447")],
                                   startPoint: .topLeading, endPoint: .bottomTrailing))
    }
}

// The leave-times widget (Phase 3b): Home to office, buses 132 at 7:48, 7:54 and 8:06.
private func wrow(_ time: String, _ arrive: String, vehicle: String = "Bus 132", color: String = bus, label: String = "132") -> WidgetView.Row {
    WidgetView.Row(time: time, vehicle: vehicle, color: color, label: label, line: "\(vehicle) at \(time)", arrive: "arrive \(arrive)", arriveTitle: "Arrive \(arrive)")
}
private let wrows = [wrow("7:48am", "8:25am"), wrow("7:54am", "8:37am"), wrow("8:06am", "8:49am")]
private func went(_ title: String, _ count: String, warn: Bool = false, next: String = "Arrive 8:25am", lock: String? = nil, lockSub: String, inline: String, circle: String,
                  row: Int = 0) -> WidgetView.Entry {
    WidgetView.Entry(at: 0, row: row, title: title, count: count, warn: warn, next: next, lock: lock ?? title, lockSub: lockSub, inline: inline, circle: circle, circleSub: row >= 0 ? "132" : "")
}
private let widgetSamples: [(String, LeaveContent)] = [
    ("Leave in", LeaveContent(name: "Home → Work", entry: went("Leave 7:42am", "in 9 min", lockSub: "in 9 min · Bus 132", inline: "132 Leave 7:42am", circle: "9"), rows: wrows)),
    ("Leave now", LeaveContent(name: "Home → Work", entry: went("Leave now", "Last chance 7:45am", warn: true, lockSub: "Last chance 7:45am", inline: "132 Leave now", circle: "now"), rows: wrows)),
    ("Departs", LeaveContent(name: "Home → Work", entry: went("Departs", "in 2 min", warn: true, next: "Too late at your pace", lock: "Departs in 2 min", lockSub: "Bus 132 at 7:48am", inline: "132 Departs in 2 min", circle: "2"), rows: wrows)),
    ("An hour+ ahead", LeaveContent(name: "Work → Home", entry: WidgetView.Entry(at: 0, row: 0, title: "Leave 5:12pm", count: "", warn: false, next: "Arrive 6:01pm", lock: "Leave 5:12pm",
        lockSub: "Orange Line at 5:20pm", inline: "OL Leave 5:12pm", circle: "5:12", circleSub: "OL"), rows: [wrow("5:20pm", "6:01pm", vehicle: "Orange Line", color: orange, label: "OL")])),
    ("No more today", LeaveContent(name: "Home → Work", entry: went("No more today", "", next: "First 5:12am", lockSub: "First 5:12am", inline: "No more today", circle: "–", row: -1), rows: [])),
    ("Set up", LeaveContent(name: "", entry: went("Set up a trip in T-Minus", "", next: "", lockSub: "", inline: "Set up a trip in T-Minus", circle: "–", row: -1), rows: [])),
    ("Stale", .stale("Home → Work")),
]

private struct WidgetSheet: View {
    @Environment(\.colorScheme) private var scheme
    private func home(_ c: LeaveContent, _ size: LeaveSize, width: CGFloat) -> some View {
        LeaveWidgetView(content: c, size: size).padding(16).frame(width: width, height: 170)
            .background(Theme.of(scheme).card).clipShape(RoundedRectangle(cornerRadius: 22))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Home small: leave in, leave now, departs, an hour+ ahead, no more today, set up, stale").font(.caption).foregroundStyle(.white)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                ForEach(Array(stride(from: 0, to: widgetSamples.count, by: 2)), id: \.self) { i in
                    GridRow {
                        home(widgetSamples[i].1, .small, width: 170)
                        if i + 1 < widgetSamples.count { home(widgetSamples[i + 1].1, .small, width: 170) }
                    }
                }
            }
            Text("Home medium: leave in, departs, no more today").font(.caption).foregroundStyle(.white)
            ForEach([0, 2, 4], id: \.self) { i in home(widgetSamples[i].1, .medium, width: 364) }
            Text("Lock Screen: inline, rectangular, circular (iOS tints them)").font(.caption).foregroundStyle(.white)
            ForEach([0, 2, 3, 6], id: \.self) { i in
                let c = widgetSamples[i].1
                VStack(spacing: 8) {
                    LeaveWidgetView(content: c, size: .inline).font(.subheadline.weight(.semibold))
                    HStack(spacing: 10) {
                        LeaveWidgetView(content: c, size: .rectangular).padding(.horizontal, 8).frame(width: 170, height: 72)
                            .background(.white.opacity(0.15)).clipShape(RoundedRectangle(cornerRadius: 12))
                        LeaveWidgetView(content: c, size: .circular).frame(width: 72, height: 72).background(.white.opacity(0.15)).clipShape(Circle())
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
