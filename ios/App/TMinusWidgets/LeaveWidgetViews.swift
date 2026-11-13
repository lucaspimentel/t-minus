import SwiftUI

// The leave-times widget's views (LeaveWidget): Home Screen small, medium and large (2026-11-13) in the app's colors
// (the Lock Screen sizes were removed 2026-10-31: the leave and ride cards are the Lock Screen's).
// SwiftUI only, so ios/Previews can render them on macOS (the WidgetKit wrappers are in
// LeaveWidget.swift).

enum LeaveSize { case small, medium, large }
// The large size's leave state (the widget's "Show" option): the next rides, or the trip's timeline.
enum LeaveShow { case rides, timeline }

private extension LeaveContent {
    var shownName: String { name.isEmpty ? "T-Minus" : name }
    var title: String { entry?.title ?? "Open T-Minus" }
    var next: String { entry == nil ? "for new times" : entry!.next }
    var warn: Bool { entry?.warn ?? false }
    var firstRow: WidgetView.Row? { rows.first }
    // A followed ride's entry carries its own line, arrival and connection; else its row's.
    var long: String { entry?.long ?? firstRow?.long ?? firstRow?.vehicle ?? "" }
    var headsign: String { entry?.headsign ?? firstRow?.headsign ?? "" }
    var color: String { entry?.color ?? firstRow?.color ?? "" }
    var arrive: String { entry?.arrive ?? firstRow?.arrive ?? "" }
    var note: String { entry?.note ?? "" }
    var thenLegs: [RideState.ThenLeg] { entry?.then ?? (firstRow?.then ?? []).map { RideState.ThenLeg(label: $0.label, color: $0.color) } }
    var thenText: String { entry?.thenText ?? "" }
    var thenWarn: Bool { entry?.thenWarn ?? false }
    var dropOff: String { entry?.dropOff ?? "" }
    var thenState: String? { entry?.thenState }
    var late: Bool { entry?.late ?? false }         // red (2026-11-08): too late at your pace
    var thenLate: Bool { entry?.thenLate ?? false } // red: no connection
    var askDep: Double? { entry?.dep }
    // A countdown to show (else "No more today", "Plan a trip", "Open T-Minus").
    var isHome: Bool { entry?.head != nil }
}

struct LeaveWidgetView: View {
    let content: LeaveContent
    let size: LeaveSize
    var show: LeaveShow = .rides
    var body: some View {
        switch size {
        case .small: if content.isHome { SmallHome(content: content) } else { Plain(content: content, size: size) }
        case .medium: if content.isHome { MediumHome(content: content) } else { Plain(content: content, size: size) }
        case .large: if content.isHome { LargeHome(content: content, show: show) } else { Plain(content: content, size: .medium) }
        }
    }
}

// No countdown: the trip name, "No more today" / "First 5:12am", "Open T-Minus" / "for new times".
private struct Plain: View {
    let content: LeaveContent
    let size: LeaveSize
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        VStack(alignment: .leading, spacing: 2) {
            Text(content.shownName).font(.caption.weight(.semibold)).foregroundStyle(th.muted).lineLimit(1)
            Text(content.title).font((size == .small ? Font.title3 : .title2).weight(.bold)).foregroundStyle(th.text).lineLimit(2).minimumScaleFactor(0.7)
            Spacer(minLength: 0)
            if !content.next.isEmpty { Text(content.next).font(.subheadline).foregroundStyle(th.muted).lineLimit(1) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// "Orange Line toward Forest Hills", or "Orange Line → Forest Hills" where "toward" doesn't fit
// (then truncated); the direction muted. No headsign: the line alone.
struct LineToward: View {
    let line: String
    let headsign: String
    let muted: Color
    var body: some View {
        if headsign.isEmpty {
            Text(line).lineLimit(1).truncationMode(.tail)
        } else {
            ViewThatFits(in: .horizontal) {
                (Text(line + " ") + Text("toward \(headsign)").foregroundStyle(muted)).lineLimit(1).fixedSize()
                (Text(line + " ") + Text("→ \(headsign)").foregroundStyle(muted)).lineLimit(1).truncationMode(.tail)
            }
        }
    }
}

// Home Screen small (2026-10-29; 2026-10-31 the arrival): the countdown on two lines ("Leave in 5
// min" / "12:17am", "Get off in 5 stops" / "9 min"), then the line, its direction and the
// trip's arrival (amber when the connection is tight, red when missed or none: no room for its
// line). The headline red with `late`, amber with `warn`.
private struct SmallHome: View {
    let content: LeaveContent
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        let tint = content.late ? th.red : content.warn ? th.amber : th.text
        VStack(alignment: .leading, spacing: 2) {
            Text(content.shownName).font(.caption.weight(.semibold)).foregroundStyle(th.muted).lineLimit(1)
            Text(content.entry?.head ?? "").font(.title3.weight(.bold)).foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.6)
            if let time = content.entry?.headTime, !time.isEmpty {
                Text(time).font(.subheadline.weight(.semibold)).foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.7)
            }
            Spacer(minLength: 0)
            if !content.long.isEmpty {
                HStack(spacing: 5) {
                    RouteDot(hex: content.color, size: 8)
                    Text(content.long).lineLimit(1).minimumScaleFactor(0.8)
                }
                .foregroundStyle(th.text)
                // Riding (2026-11-06): "to Malden Center" in the headsign's place.
                let second = !content.dropOff.isEmpty ? "to \(content.dropOff)" : content.headsign.isEmpty ? "" : "toward \(content.headsign)"
                if !second.isEmpty {
                    Text(second).foregroundStyle(th.muted).lineLimit(1).minimumScaleFactor(0.8).padding(.leading, content.color.isEmpty ? 0 : 13)
                }
            }
            if !content.arrive.isEmpty {
                Text(content.arrive).foregroundStyle(thenTimeColor(content.thenState, amber: th.amber, red: th.red) ?? (content.thenLate ? th.red : content.thenWarn ? th.amber : th.muted)).lineLimit(1)
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// Home Screen medium (2026-10-29; one ride 2026-10-30; followed rides 2026-10-31): "Leave in 5 min
// · 12:17am" (or "Get off in 5 stops · 9 min"), the line and direction in full ("→" only where
// "toward" doesn't fit), then at the bottom the note (red with `late`, amber with `warn`, like the
// headline), the connection on its own line ("then ● Bus 132 6:38pm · 4 min to spare", amber when
// tight or missed, "No connection after 6:31pm" red with `thenLate`; riding with
// `dropOff`, 2026-11-06: "● Bus 132 to Malden Center" and "then ● Orange at 6:38pm" beside the
// arrival, the time amber or red), and the later
// legs ("then ● Bus 132", when there's no connection line) with the arrival (never cut). "Did you
// get on?" (2026-10-31): the arrival at the line's end and [Yes] [Missed it] at the bottom.
private struct MediumHome: View {
    let content: LeaveContent
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        let tint = content.late ? th.red : content.warn ? th.amber : th.text
        let time = content.entry?.headTime ?? ""
        VStack(alignment: .leading, spacing: 2) {
            Text(content.shownName).font(.caption.weight(.semibold)).foregroundStyle(th.muted).lineLimit(1)
            (Text(content.entry?.head ?? "").font(.title2.weight(.bold)) + Text(time.isEmpty ? "" : " · \(time)").font(.subheadline.weight(.semibold)))
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity, alignment: .leading)
            if !content.long.isEmpty {
                HStack(spacing: 5) {
                    RouteDot(hex: content.color, size: 8)
                    if content.dropOff.isEmpty {
                        LineToward(line: content.long, headsign: content.headsign, muted: th.muted)
                    } else {
                        LineTo(line: content.long, dropOff: content.dropOff)
                    }
                    // "Did you get on?": the arrival here, the buttons in the bottom row.
                    if content.askDep != nil && !content.arrive.isEmpty {
                        Spacer(minLength: 8)
                        Text(content.arrive).foregroundStyle(th.muted).lineLimit(1).fixedSize()
                    }
                }
                .foregroundStyle(th.text)
            }
            Spacer(minLength: 0)
            if let dep = content.askDep {
                AnswerButtons(dep: dep, text: th.text, track: th.track)
            } else {
                bottom(th, tint: tint)
            }
        }
        .font(.subheadline)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder private func bottom(_ th: Theme, tint: Color) -> some View {
        if !content.note.isEmpty { Text(content.note).foregroundStyle(tint).lineLimit(1) }
        if !content.dropOff.isEmpty {
            // Riding (2026-11-06): "then ● Bus 132 at 6:38pm" with the arrival on its right, or
            // "Arrive 7:21pm" alone on the last leg.
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if !content.thenText.isEmpty || !content.thenLegs.isEmpty {
                    ThenLine(legs: content.thenLegs, text: content.thenText, muted: th.muted,
                             textColor: thenTimeColor(content.thenState, amber: th.amber, red: th.red))
                        .foregroundStyle(content.thenWarn && content.thenState == nil ? (content.thenLate ? th.red : th.amber) : th.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(content.arrive).foregroundStyle(th.muted).lineLimit(1).fixedSize()
                } else {
                    Text(content.arrive.prefix(1).uppercased() + content.arrive.dropFirst()).foregroundStyle(th.muted).lineLimit(1)
                }
            }
        } else {
            legacyBottom(th)
        }
    }

    @ViewBuilder private func legacyBottom(_ th: Theme) -> some View {
        if !content.thenText.isEmpty {
            ThenLine(legs: content.thenLegs, text: content.thenText, muted: th.muted).foregroundStyle(content.thenWarn ? (content.thenLate ? th.red : th.amber) : th.text)
        }
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                if content.thenText.isEmpty && !content.thenLegs.isEmpty { ThenLine(legs: content.thenLegs, text: "", muted: th.muted) } else { Text("") }
            }
            .foregroundStyle(th.text).frame(maxWidth: .infinity, alignment: .leading)
            Text(content.arrive).foregroundStyle(th.muted).lineLimit(1).fixedSize()
        }
    }
}

// Home Screen large (2026-11-13; DESIGN.md "Widget"): the medium's headline, then
// - leave times with "More rides": the medium's content and "Later", the next 5 rides (leave-by,
//   the vehicle where it differs from the first ride's, arrival);
// - leave times with "Trip timeline", walking, "Did you get on?" ([Yes] [Missed it] below), riding,
//   the transfer and the final walk: the app's timeline (TripTimeline), with no vehicle line above
//   it (the timeline names the vehicle);
// - arrived, or an answer without a timeline (older servers): the medium's layout.
private struct LargeHome: View {
    let content: LeaveContent
    let show: LeaveShow
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        let row = content.entry?.row ?? -1
        let tl = content.entry?.tl
        if let rows = content.timeline, let tl, row < 0 || show == .timeline || content.rows.count < 2 {
            timelineLayout(th, rows: rows, marks: tl, next: row >= 0 && content.rows.count > 1 ? content.rows[1].time : nil)
        } else if row >= 0 {
            VStack(alignment: .leading, spacing: 0) {
                MediumHome(content: content).frame(height: 138)
                later(th)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            VStack(spacing: 0) {
                MediumHome(content: content).frame(height: 138)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func timelineLayout(_ th: Theme, rows: [WidgetView.TLRow], marks: WidgetView.TLMarks, next: String?) -> some View {
        let tint = content.late ? th.red : content.warn ? th.amber : th.text
        let time = content.entry?.headTime ?? ""
        return VStack(alignment: .leading, spacing: 2) {
            Text(content.shownName).font(.caption.weight(.semibold)).foregroundStyle(th.muted).lineLimit(1)
            (Text(content.entry?.head ?? "").font(.title2.weight(.bold)) + Text(time.isEmpty ? "" : " · \(time)").font(.subheadline.weight(.semibold)))
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity, alignment: .leading)
            if !content.note.isEmpty { Text(content.note).font(.subheadline).foregroundStyle(tint).lineLimit(1) }
            Rectangle().fill(th.track).frame(height: 1).padding(.top, 6).padding(.bottom, 2)
            TripTimeline(rows: rows, marks: marks, next: next.map { "Next: leave \($0)" }, th: th)
            if let dep = content.askDep {
                AnswerButtons(dep: dep, text: th.text, track: th.track).padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // "Later": rows 2-6, the vehicle in short form only where it differs from the first ride's.
    @ViewBuilder private func later(_ th: Theme) -> some View {
        let first = content.rows.first
        let more = Array(content.rows.dropFirst().prefix(5))
        if !more.isEmpty {
            Text("Later").font(.caption.weight(.semibold)).foregroundStyle(th.muted).padding(.top, 8).padding(.bottom, 2)
            ForEach(Array(more.enumerated()), id: \.offset) { i, r in
                if i > 0 { Rectangle().fill(th.track.opacity(0.6)).frame(height: 0.5) }
                HStack(spacing: 6) {
                    Text(r.time).foregroundStyle(th.text).frame(width: 64, alignment: .leading)
                    if (r.short ?? r.vehicle) != (first?.short ?? first?.vehicle) || r.color != first?.color {
                        RouteDot(hex: r.color, size: 8)
                        Text(r.short ?? r.vehicle).foregroundStyle(th.text).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Text(r.arrive).foregroundStyle(th.muted).lineLimit(1).fixedSize()
                }
                .font(.subheadline)
                .padding(.vertical, 5)
            }
        }
    }
}

// The large size's timeline, as the app's (index.html renderTimeline): stops as nodes on the
// rail with their times in a right-aligned column, each ride as a bar in its route's color with
// its line ("Bus 132 · 6 stops · 17 min", "toward Malden" before boarding), walks and transfers
// on a dotted rail, Arrive at the end; done steps dimmed, the current one bold, the headline's
// time left out (`hide`), and while riding the vehicle and the stops left on the ridden leg's bar.
// Too tall (timelineVariants, in order): no "Next: leave", no "toward" lines, smaller text, then
// steps cut (done ones first, then the upcoming ones nearest Arrive) as one "⋯" row each.
struct TripTimeline: View {
    let rows: [WidgetView.TLRow]
    let marks: WidgetView.TLMarks
    let next: String?
    let th: Theme
    var body: some View {
        ViewThatFits(in: .vertical) {
            ForEach(Array(timelineVariants(rows, marks, hasNext: next != nil).enumerated()), id: \.offset) { _, v in
                VStack(alignment: .leading, spacing: 0) {
                    TimelineRows(rows: rows, marks: marks, variant: v, th: th)
                    if v.next, let next {
                        Spacer(minLength: 6)
                        Text(next).font(.system(size: 14)).foregroundStyle(th.muted).lineLimit(1)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct TimelineVariant: Hashable {
    var next: Bool
    var toward: Bool
    var scale: CGFloat
    var cut: Set<Int> // row indices left out
}

// The overflow order: with "Next: leave" and "toward", without Next, without toward, at 0.9,
// then cutting whole steps (a walk, or a leg's stop, ride and stop): the done ones first (the
// earliest first), then the upcoming ones nearest before Arrive; never the current rows or Arrive.
func timelineVariants(_ rows: [WidgetView.TLRow], _ marks: WidgetView.TLMarks, hasNext: Bool) -> [TimelineVariant] {
    var out: [TimelineVariant] = []
    if hasNext { out.append(TimelineVariant(next: true, toward: true, scale: 1, cut: [])) }
    out.append(TimelineVariant(next: false, toward: true, scale: 1, cut: []))
    out.append(TimelineVariant(next: false, toward: false, scale: 1, cut: []))
    out.append(TimelineVariant(next: false, toward: false, scale: 0.9, cut: []))
    // Steps: [row indices].
    var steps: [[Int]] = []
    var i = 0
    while i < rows.count {
        if rows[i].kind == "stop", rows[i].bar == "start" {
            var j = i
            while j + 1 < rows.count, !(rows[j].kind == "stop" && rows[j].bar == "end") { j += 1 }
            steps.append(Array(i...j))
            i = j + 1
        } else {
            steps.append([i])
            i += 1
        }
    }
    let current = Set(marks.done..<(marks.done + marks.current))
    let cuttable = steps.filter { s in !s.contains { current.contains($0) } && rows[s[0]].kind != "end" }
    let done = cuttable.filter { $0.allSatisfy { $0 < marks.done } }
    let upcoming = cuttable.filter { !done.contains($0) }.reversed()
    var cut = Set<Int>()
    for s in done + upcoming {
        cut.formUnion(s)
        out.append(TimelineVariant(next: false, toward: false, scale: 0.9, cut: cut))
    }
    return out
}

private struct TimelineRows: View {
    let rows: [WidgetView.TLRow]
    let marks: WidgetView.TLMarks
    let variant: TimelineVariant
    let th: Theme

    private enum Part { case done, current, plain }
    private func part(_ i: Int) -> Part { i < marks.done ? .done : i < marks.done + marks.current ? .current : .plain }
    private func size(_ base: CGFloat) -> Font { .system(size: (base * variant.scale).rounded()) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                if variant.cut.contains(i) {
                    if i == 0 || !variant.cut.contains(i - 1) { line(rail: AnyView(DottedRail(color: th.muted))) { Text("⋯").font(size(12)).foregroundStyle(th.muted) } }
                } else {
                    row(i, r)
                    if let a = marks.along, a.after == i { along(a, color: r.color ?? "") }
                }
            }
        }
    }

    @ViewBuilder private func row(_ i: Int, _ r: WidgetView.TLRow) -> some View {
        let p = part(i)
        let text = p == .done ? th.muted : th.text
        let weight: Font.Weight = p == .current ? .semibold : .regular
        let fade = p == .done ? 0.4 : 1.0
        let color = Color(hex: r.color ?? "")
        switch r.kind {
        case "walk":
            line(rail: AnyView(DottedRail(color: th.muted).overlay {
                if r.walking == true { Image(systemName: "figure.walk").font(.system(size: 9)).foregroundStyle(p == .current ? th.text : th.muted).padding(.vertical, 1).background(th.card).opacity(fade) }
            })) {
                Text(r.text ?? "").font(size(12)).fontWeight(weight).foregroundStyle(p == .plain ? th.muted : text).lineLimit(1)
            }
        case "ride":
            line(rail: AnyView(color.frame(width: 8).opacity(fade))) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(r.text ?? "").font(size(12)).fontWeight(weight).foregroundStyle(p == .plain ? th.muted : text).lineLimit(1)
                    if variant.toward, p == .plain, let toward = r.toward, !toward.isEmpty {
                        Text(toward).font(size(11)).foregroundStyle(th.muted).lineLimit(1)
                    }
                }
                .padding(.vertical, 2)
            }
        case "stop":
            let board = marks.along.map { $0.veh == "board" && $0.after == i + 1 } ?? false
            line(rail: AnyView(ZStack { StopRail(color: color, start: r.bar == "start", fill: th.card).opacity(fade); if board { Vehicle(color: color, ring: th.card) } })) {
                stopText(r.name ?? "—", time: i == marks.hide ? "" : r.time ?? "", color: text, weight: weight, base: 14)
            }
        default: // "end": Arrive
            line(rail: AnyView(ZStack { VStack(spacing: 0) { DottedRail(color: th.muted); Color.clear }; Circle().fill(th.muted).frame(width: 10, height: 10) }.opacity(fade))) {
                stopText(r.name ?? "Arrive", time: i == marks.hide ? "" : r.time ?? "", color: text, weight: weight, base: 14)
            }
        }
    }

    // The ridden leg's stops left: the vehicle just above the next stop (on the boarding node
    // instead while it hasn't left it: `row`), then each stop, "… 3 more".
    @ViewBuilder private func along(_ a: WidgetView.TLMarks.Along, color hex: String) -> some View {
        let color = Color(hex: hex)
        if a.veh == "gap" {
            line(rail: AnyView(ZStack { color.frame(width: 8); Vehicle(color: color, ring: th.card) })) {
                Color.clear.frame(height: 12)
            }
        }
        ForEach(Array(a.stops.enumerated()), id: \.offset) { _, s in
            line(rail: AnyView(ZStack { color.frame(width: 8); Circle().fill(th.card).frame(width: 4, height: 4) })) {
                if let more = s.more {
                    Text(more).font(size(12)).foregroundStyle(th.muted)
                } else {
                    stopText(s.name ?? "—", time: s.time ?? "", color: th.text, weight: .regular, base: 13)
                }
            }
        }
    }

    private func stopText(_ name: String, time: String, color: Color, weight: Font.Weight, base: CGFloat) -> some View {
        HStack(spacing: 8) {
            Text(name).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
            if !time.isEmpty { Text(time).fixedSize() }
        }
        .font(size(base)).fontWeight(weight).foregroundStyle(color)
        .padding(.vertical, 2)
    }

    private func line<C: View>(rail: AnyView, @ViewBuilder _ content: () -> C) -> some View {
        HStack(alignment: .center, spacing: 10) {
            rail.frame(width: 18).frame(maxHeight: .infinity)
            content().frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

// The vehicle on the rail: a dot in the route's color with a card-colored ring.
private struct Vehicle: View {
    let color: Color
    let ring: Color
    var body: some View {
        Circle().fill(color).frame(width: 18, height: 18).overlay(Circle().stroke(ring, lineWidth: 3).padding(1.5)).overlay(Circle().stroke(color, lineWidth: 1))
    }
}

// A leg's end on the rail: its bar from the node down ("start") or up to it, and a hollow node.
private struct StopRail: View {
    let color: Color
    let start: Bool
    let fill: Color
    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                (start ? Color.clear : color).frame(width: 8)
                (start ? color : Color.clear).frame(width: 8)
            }
            Circle().fill(fill).frame(width: 10, height: 10).overlay(Circle().stroke(color, lineWidth: 2))
        }
    }
}

private struct DottedRail: View {
    let color: Color
    var body: some View {
        GeometryReader { g in
            Path { p in
                p.move(to: CGPoint(x: g.size.width / 2, y: 0))
                p.addLine(to: CGPoint(x: g.size.width / 2, y: g.size.height))
            }
            .stroke(color.opacity(0.6), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [0.5, 4]))
        }
    }
}
