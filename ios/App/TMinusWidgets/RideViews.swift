import SwiftUI

// The Live Activity's views: the Lock Screen card and the Dynamic Island's parts, in the app's
// colors (light / dark). SwiftUI only, so ios/Previews can render them on macOS.

extension Color {
    init(hex: String) {
        let v = UInt64(hex, radix: 16) ?? 0
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

struct Theme {
    let card, text, muted, track, amber, red: Color
    static func of(_ scheme: ColorScheme) -> Theme {
        scheme == .dark
            ? Theme(card: Color(hex: "1C1F24"), text: Color(hex: "ECEEF1"), muted: Color(hex: "9AA0A8"), track: Color(hex: "2E333A"), amber: Color(hex: "F0A830"), red: Color(hex: "FF6B6B"))
            : Theme(card: .white, text: Color(hex: "1C1F24"), muted: Color(hex: "6B7078"), track: Color(hex: "DCDDE0"), amber: Color(hex: "A35F00"), red: Color(hex: "C62828"))
    }
}

// The connection's time color (`thenState`, 2026-11-06): amber when tight, red when missed; nil
// (the line's own color) otherwise.
func thenTimeColor(_ state: String?, amber: Color, red: Color) -> Color? {
    switch state { case "tight": return amber; case "missed": return red; default: return nil }
}

// "Orange Line to Malden Center": the line and the drop-off while riding, cut at the end.
struct LineTo: View {
    let line: String
    let dropOff: String
    var body: some View { Text("\(line) to \(dropOff)").lineLimit(1).truncationMode(.tail) }
}

struct RouteDot: View {
    let hex: String
    var size: CGFloat = 12
    var body: some View {
        if !hex.isEmpty { Circle().fill(Color(hex: hex)).frame(width: size, height: size) }
    }
}

// The compact island's short form: "28 min" (rounded down, ticking on its own), "<1 min".
func shortCountdown(_ state: RideState) -> Text? {
    if state.soon == true { return Text("<1 min") }
    guard let until = state.untilDate, until > Date() else { return nil }
    // now..<until as whole minutes: `durationOffset` counts from the date, so it reads "-28 min".
    return Text(.dateRange(endingAt: until), format: .components(style: .abbreviated, fields: [.minute]))
}

// The leave card's countdown (to `countTo`): "28 min", "1h 14m" an hour or more ahead (as the
// widget's), "<1 min". Ticks on its own.
func headCountdown(_ state: RideState) -> Text? {
    if state.soon == true { return Text("<1 min") }
    guard let to = state.countTo, to > 0 else { return nil }
    let until = Date(timeIntervalSince1970: to)
    guard until > Date() else { return nil }
    if state.phase == "early" { return Text(.dateRange(endingAt: until), format: .components(style: .narrow, fields: [.hour, .minute])) }
    return Text(.dateRange(endingAt: until), format: .components(style: .abbreviated, fields: [.minute]))
}

// "8:24am" in the device's time zone.
private let clockFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "h:mma"
    f.amSymbol = "am"
    f.pmSymbol = "pm"
    return f
}()

// The headline on the dimmed Always-On screen, where iOS dashes self-ticking date text: the time
// instead of the countdown ("Departs 9:43am", "Get off in 5 stops"). Nil when no live countdown
// would be drawn (none, past, or the fixed "<1 min"): the lit form is used then.
func dimmedHead(_ state: RideState) -> String? {
    if state.soon == true { return nil }
    guard let to = state.countTo, to > 0, Date(timeIntervalSince1970: to) > Date() else { return nil }
    let head = state.head ?? ""
    if state.countAfter == true { return head }
    let lead = head.hasSuffix(" in") ? String(head.dropLast(3)) : head
    let time = (state.headTime ?? "").isEmpty ? clockFormatter.string(from: Date(timeIntervalSince1970: to)) : state.headTime!
    return lead.isEmpty ? time : "\(lead) \(time)"
}

// The legs bar (2026-11-13): the route map's look on a straight line. One line per leg in its
// route's color, as wide as its share of the riding time (at least 8%), the legs joined; the part
// ahead at 50%, the part behind full (the ridden leg advances on its own). Rings like the map's
// stops: the leg ends and the transfer large, the stops between small (`leg.at`: their shares of
// the leg's time; none: the ends only), hollow and faded ahead, filled once passed. The ridden
// leg's rings fill by the stops left (`stops`, as the headline says) or, without it, by time.
// `card`: the surface under the rings (their hollow centers). `now`: the moment drawn (the
// widget's entry; the ridden leg's fill moves by its own timer).
struct LegsBar: View {
    let legs: [RideState.Leg]
    var stops: Int = -1
    let card: Color
    var now: Date = Date()
    // Computed, so the memberwise init (used from LeaveWidgetViews.swift too) stays internal.
    private var inset: CGFloat { 7.5 }
    private var lineHeight: CGFloat { 5 }
    private var height: CGFloat { 15 }

    private func widths(_ total: CGFloat) -> [CGFloat] {
        let durations = legs.map { max($0.arr - $0.dep, 1) }
        let sum = durations.reduce(0, +)
        let shares = durations.map { max($0 / sum, 0.08) }
        let norm = shares.reduce(0, +)
        return shares.map { total * CGFloat($0 / norm) }
    }

    // The stops to draw (indexes): at least `minGap` from the last one drawn (the leg's start
    // first) and from the leg's end, as the map's stopsToShow.
    static func shown(_ xs: [CGFloat], start: CGFloat, end: CGFloat, minGap: CGFloat = 14) -> [Int] {
        var out: [Int] = []
        var last = start
        for (i, x) in xs.enumerated() where x - last >= minGap && end - x >= minGap {
            out.append(i)
            last = x
        }
        return out
    }

    private func tint(_ leg: RideState.Leg) -> Color { leg.color.isEmpty ? Color.gray : Color(hex: leg.color) }
    private func dep(_ leg: RideState.Leg) -> Date { Date(timeIntervalSince1970: leg.dep) }
    private func arr(_ leg: RideState.Leg) -> Date { Date(timeIntervalSince1970: max(leg.arr, leg.dep + 1)) }

    var body: some View {
        GeometryReader { g in
            let w = widths(max(g.size.width - 2 * inset, 0))
            let xs = w.indices.map { i in inset + w[..<i].reduce(0, +) }
            ZStack(alignment: .topLeading) {
                if !legs.isEmpty { bar(w: w, xs: xs) }
            }
        }
        .frame(height: height)
    }

    @ViewBuilder private func bar(w: [CGFloat], xs: [CGFloat]) -> some View {
        ForEach(Array(legs.enumerated()), id: \.offset) { i, leg in
            line(leg).frame(width: w[i], height: lineHeight).position(x: xs[i] + w[i] / 2, y: height / 2)
        }
        ForEach(Array(legs.enumerated()), id: \.offset) { i, leg in
            stopRings(leg, from: xs[i], width: w[i])
        }
        // The ends and the transfers: one ring per boundary, in the arriving leg's color.
        ForEach(0...legs.count, id: \.self) { k in
            ring(tint(legs[max(k - 1, 0)]), filled: k == 0 ? now >= dep(legs[0]) : now >= arr(legs[k - 1]), radius: 6, stroke: 3)
                .position(x: k == 0 ? xs[0] : xs[k - 1] + w[k - 1], y: height / 2)
        }
    }

    private func line(_ leg: RideState.Leg) -> some View {
        let t = tint(leg)
        return ZStack(alignment: .leading) {
            Rectangle().fill(t.opacity(0.5))
            if now >= arr(leg) {
                Rectangle().fill(t)
            } else if now >= dep(leg) {
                #if os(iOS)
                ProgressView(timerInterval: dep(leg)...arr(leg), countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
                    .progressViewStyle(.linear).tint(t)
                #else
                // The previews (macOS can't draw the timer progress in a still image).
                GeometryReader { g in
                    Rectangle().fill(t).frame(width: g.size.width * now.timeIntervalSince(dep(leg)) / arr(leg).timeIntervalSince(dep(leg)))
                }
                #endif
            }
        }
        .clipped()
    }

    // The leg's stops between its ends.
    @ViewBuilder private func stopRings(_ leg: RideState.Leg, from x0: CGFloat, width: CGFloat) -> some View {
        if let at = leg.at, !at.isEmpty {
            let xs = at.map { x0 + CGFloat($0) * width }
            let n = at.count
            let passedCount: Int = {
                if now >= arr(leg) { return n }
                if now < dep(leg) { return 0 }
                if stops > 0 { return max(0, min(n, n - (stops - 1))) }
                return at.filter { dep(leg).addingTimeInterval($0 * (arr(leg).timeIntervalSince(dep(leg)))) <= now }.count
            }()
            ForEach(LegsBar.shown(xs, start: x0, end: x0 + width), id: \.self) { i in
                ring(tint(leg), filled: i < passedCount, radius: 3.5, stroke: 1.5).position(x: xs[i], y: height / 2)
            }
        }
    }

    private func ring(_ color: Color, filled: Bool, radius: CGFloat, stroke: CGFloat) -> some View {
        ZStack {
            Circle().fill(filled ? color : card)
            Circle().stroke(color.opacity(filled ? 1 : 0.5), lineWidth: stroke)
        }
        .frame(width: 2 * radius, height: 2 * radius)
    }
}

// Every card (leave and walk 2026-10-29, ride 2026-10-31), like the medium Home Screen widget:
// "Leave in 28 min · 7:39am" / "Get off in 5 stops · 9 min", "● Bus 132 toward Malden   arrive
// 8:25am", a note ("At the stop ~7:44am · 2 min late", red with `late`; the transfer's spare,
// amber when tight), the connection ("then ● Bus 132 6:38pm · 4 min to spare"; "No connection
// after 6:31pm" red with `nextLate`), the legs.
// While riding with `dropOff` (2026-11-06): "● Orange Line to Malden Center", then "then ● Bus 132
// at 6:38pm" (the time amber or red, `thenState`) with the arrival on its right, or "Arrive
// 7:21pm" alone on the last leg.
// The headline (2026-11-08): muted once gone, plain while riding (the connection line says it),
// red with `late` (too late at your pace), amber with `warn` (at risk).
// Dimmed (Always-On), the headline shows the time instead of the countdown (dimmedHead).
// The Lock Screen card under its header; the expanded island under the island's top row.
struct LeaveBody: View {
    let state: RideState
    let text, muted, amber, red, track, card: Color
    @Environment(\.isLuminanceReduced) private var dimmed
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Its full height: with a note below, the stack squeezed it to its minimum scale (only
            // the width may shrink it).
            headline.font(.title3.weight(.bold)).foregroundStyle(headColor).lineLimit(1).minimumScaleFactor(0.7)
                .fixedSize(horizontal: false, vertical: true)
            let drop = state.dropOff ?? ""
            let right = state.right ?? ""
            let hasThen = !(state.then ?? []).isEmpty || !(state.thenText ?? "").isEmpty
            if let long = state.long, !long.isEmpty {
                HStack(spacing: 6) {
                    RouteDot(hex: state.color, size: 10)
                    if drop.isEmpty {
                        LineToward(line: long, headsign: state.headsign ?? "", muted: muted).foregroundStyle(text)
                        Spacer(minLength: 8)
                        if !right.isEmpty { Text(right).foregroundStyle(muted).lineLimit(1).fixedSize() }
                    } else {
                        LineTo(line: long, dropOff: drop).foregroundStyle(text)
                        Spacer(minLength: 0)
                    }
                }
                .font(.subheadline)
            }
            if let note = state.note, !note.isEmpty {
                Text(note).font(.subheadline).foregroundStyle(state.late == true ? red : state.warn ? amber : text).lineLimit(2)
            }
            if !drop.isEmpty {
                // The third line: the connection with the arrival on its right, or the arrival alone.
                HStack(spacing: 8) {
                    if hasThen {
                        ThenLine(legs: state.then ?? [], text: state.thenText ?? "", muted: muted,
                                 textColor: thenTimeColor(state.thenState, amber: amber, red: red))
                            .foregroundStyle(state.nextWarn == true && (state.thenState ?? "").isEmpty ? (state.nextLate == true ? red : amber) : text)
                        Spacer(minLength: 8)
                        if !right.isEmpty { Text(right).foregroundStyle(muted).lineLimit(1).fixedSize() }
                    } else if !right.isEmpty {
                        Text(right.prefix(1).uppercased() + right.dropFirst()).foregroundStyle(muted).lineLimit(1)
                    }
                }
                .font(.subheadline)
            } else if hasThen {
                ThenLine(legs: state.then ?? [], text: state.thenText ?? "", muted: muted)
                    .font(.subheadline).foregroundStyle(state.nextWarn == true ? (state.nextLate == true ? red : amber) : text)
            }
            if state.phase == "ask", let dep = state.askDep {
                AnswerButtons(dep: dep, text: text, track: track).padding(.top, 6)
            } else {
                LegsBar(legs: state.legs, stops: state.phase == "riding" ? state.stops : -1, card: card).padding(.top, 6)
            }
        }
    }

    private var headColor: Color {
        if state.phase == "gone" { return muted }
        if state.phase == "riding" { return text }
        if state.late == true { return red }
        return state.warn ? amber : text
    }

    private var headline: Text {
        if dimmed, let head = dimmedHead(state) { return Text(head) }
        var t = Text(state.head ?? "")
        if state.countAfter == true {
            if let countdown = headCountdown(state) { t = t + (Text(" · ") + countdown).font(.subheadline.weight(.semibold)) }
            return t
        }
        if let countdown = headCountdown(state) { t = t + Text(" ") + countdown }
        if let time = state.headTime, !time.isEmpty { t = t + Text(" · \(time)").font(.subheadline.weight(.semibold)) }
        return t
    }
}

// "Did you get on?": [Yes] [Missed it], links that open the app with the answer (RideState.answerURL).
struct AnswerButtons: View {
    let dep: Double
    let text, track: Color
    var body: some View {
        HStack(spacing: 8) {
            button("Yes", yes: true, fg: .white, bg: Color(hex: "2F6FDB"))
            button("Missed it", yes: false, fg: text, bg: track)
        }
        .font(.subheadline.weight(.semibold))
    }

    @ViewBuilder private func button(_ label: String, yes: Bool, fg: Color, bg: Color) -> some View {
        let face = Text(label).foregroundStyle(fg).lineLimit(1).frame(maxWidth: .infinity).padding(.vertical, 7)
            .background(bg, in: RoundedRectangle(cornerRadius: 12))
        #if os(iOS)
        Link(destination: RideState.answerURL(yes: yes, dep: dep)) { face }
        #else
        // The previews (macOS draws a link as a placeholder in a still image).
        face
        #endif
    }
}

// "then ● Bus 132 · ● Red" (the later legs in short form), with `text` after them ("6:38pm · 4
// min to spare"); no legs: the text alone ("No connection after 6:31pm"). Cut at the end.
struct ThenLine: View {
    let legs: [RideState.ThenLeg]
    let text: String
    let muted: Color
    var textColor: Color? = nil // the text alone ("at 6:38pm") amber or red (thenTimeColor)
    var body: some View {
        HStack(spacing: 5) {
            if !legs.isEmpty {
                Text("then")
                ForEach(Array(legs.enumerated()), id: \.offset) { i, leg in
                    if i > 0 { Text("·").foregroundStyle(muted) }
                    RouteDot(hex: leg.color, size: 8)
                    Text(leg.label)
                }
            }
            if !text.isEmpty {
                if let textColor { Text(text).foregroundStyle(textColor) } else { Text(text) }
            }
        }
        .lineLimit(1).truncationMode(.tail)
    }
}

struct RideCardView: View {
    let tripName: String
    let state: RideState
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(tripName)
                Spacer()
                Text("T-Minus")
            }
            .font(.caption).foregroundStyle(th.muted)
            LeaveBody(state: state, text: th.text, muted: th.muted, amber: th.amber, red: th.red, track: th.track, card: th.card)
        }
        .padding(16)
    }
}

// The Dynamic Island's compact parts: the route (dot and label) and the stops left, or the
// countdown when stops don't apply (no stop data, a transfer, the final walk).
struct IslandLeading: View {
    let state: RideState
    var body: some View {
        HStack(spacing: 5) {
            RouteDot(hex: state.color, size: 10)
            Text(state.label).font(.subheadline.weight(.semibold))
        }
    }
}

// A leave or walk card: "🚶 28 min" to the leave-by ("🚶 7:39am" an hour or more ahead), the
// vehicle's emoji past it ("🚌 7 min", amber), "Got on?" at the departure; the ride card (2026-10-31):
// "🚇 5 stops", "🚇 next", "🚇 here", else the countdown ("🚌 6 min" to a connection); older servers: the
// word ("Leave 7:39am", "Leave now") or the countdown alone. The ride card: the stops left, or the
// countdown when stops don't apply (no stop data, a transfer, the final walk).
struct IslandTrailing: View {
    let state: RideState
    var body: some View {
        if let emoji = state.emoji, state.head != nil {
            if emoji.isEmpty && state.phase != "ask" {
                EmptyView() // missed, cancelled
            } else {
                trailing(emoji)
            }
        } else {
            legacy
        }
    }

    private func trailing(_ emoji: String) -> some View {
        Group {
            if state.phase == "ask" {
                Text(state.island ?? "")
            } else if let text = state.islandText, !text.isEmpty {
                Text("\(emoji) \(text)")
            } else if state.phase == "early" {
                Text("\(emoji) \(state.headTime ?? "")")
            } else if let countdown = headCountdown(state) {
                Text("\(emoji) ") + countdown
            } else {
                Text(emoji)
            }
        }
        // Fixed (sized for "🚌 59 min") so the island doesn't resize as it counts down.
        .font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.6)
        .frame(width: 88, alignment: .trailing)
        .foregroundStyle(state.late == true ? Color(hex: "FF6B6B") : state.warn ? Color(hex: "F0A830") : .white)
    }

    @ViewBuilder private var legacy: some View {
        // A leave or walk card: the countdown alone ("28 min"; the word is in the expanded view), or
        // the word without one ("Leave 7:39am", "Leave now", "Got on?"). The countdown's width is
        // fixed (sized for "59 min") so the island doesn't resize as it counts down.
        if let word = state.island {
            Group {
                if state.phase != "now", let countdown = shortCountdown(state) {
                    countdown.frame(width: 60, alignment: .trailing)
                } else {
                    Text(word).frame(maxWidth: 110)
                }
            }
            .font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.6)
            .foregroundStyle(state.late == true ? Color(hex: "FF6B6B") : state.warn ? Color(hex: "F0A830") : .white)
        } else if state.phase == "riding" && state.stops > 0 {
            Text("\(state.stops) stop\(state.stops == 1 ? "" : "s")").font(.subheadline.weight(.semibold))
        } else if let countdown = shortCountdown(state) {
            countdown.font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7).frame(width: 60, alignment: .trailing)
        } else {
            EmptyView()
        }
    }
}

// Expanded (long press): the card's content on black under a top row of the trip name and
// "T-Minus" (`IslandTop`), nothing that repeats the headline; the ride card's route dot before its
// headline, as on the Lock Screen.
struct IslandTop: View {
    let text: String
    // The island's outer side (.leading for the trip name, .trailing for "T-Minus"): inset past the
    // body's margins, as the corners beside the camera are rounder (the phone clipped "Office").
    let edge: Edge.Set
    var body: some View { Text(text).font(.caption).foregroundStyle(.gray).lineLimit(1).padding(edge, 10) }
}

struct IslandExpanded: View {
    let state: RideState
    var body: some View {
        let amber = Color(hex: "F0A830"), track = Color(hex: "333333")
        LeaveBody(state: state, text: .white, muted: .gray, amber: amber, red: Color(hex: "FF6B6B"), track: track, card: .black)
    }
}
