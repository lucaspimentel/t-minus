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
    let card, text, muted, track, amber: Color
    static func of(_ scheme: ColorScheme) -> Theme {
        scheme == .dark
            ? Theme(card: Color(hex: "1C1F24"), text: Color(hex: "ECEEF1"), muted: Color(hex: "9AA0A8"), track: Color(hex: "2E333A"), amber: Color(hex: "F0A830"))
            : Theme(card: .white, text: Color(hex: "1C1F24"), muted: Color(hex: "6B7078"), track: Color(hex: "DCDDE0"), amber: Color(hex: "A35F00"))
    }
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

// One segment per leg, as wide as its share of the riding time (at least 8% so a short leg shows):
// full once done, advancing on its own while ridden.
struct LegsBar: View {
    let legs: [RideState.Leg]
    let track: Color
    private let gap: CGFloat = 4

    private func widths(_ total: CGFloat) -> [CGFloat] {
        let durations = legs.map { max($0.arr - $0.dep, 1) }
        let sum = durations.reduce(0, +)
        let shares = durations.map { max($0 / sum, 0.08) }
        let norm = shares.reduce(0, +)
        let room = max(total - gap * CGFloat(legs.count - 1), 0)
        return shares.map { room * CGFloat($0 / norm) }
    }

    var body: some View {
        GeometryReader { g in
            let w = widths(g.size.width)
            HStack(spacing: gap) {
                ForEach(Array(legs.enumerated()), id: \.offset) { i, leg in
                    segment(leg).frame(width: w[i])
                }
            }
        }
        .frame(height: 5)
    }

    private func segment(_ leg: RideState.Leg) -> some View {
        let dep = Date(timeIntervalSince1970: leg.dep), arr = Date(timeIntervalSince1970: max(leg.arr, leg.dep + 1))
        let tint = leg.color.isEmpty ? Color.gray : Color(hex: leg.color)
        return ZStack(alignment: .leading) {
            Capsule().fill(track)
            if Date() >= arr {
                Capsule().fill(tint)
            } else if Date() >= dep {
                #if os(iOS)
                ProgressView(timerInterval: dep...arr, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
                    .progressViewStyle(.linear).tint(tint)
                #else
                // The previews (macOS can't draw the timer progress in a still image).
                GeometryReader { g in
                    Capsule().fill(tint).frame(width: g.size.width * Date().timeIntervalSince(dep) / arr.timeIntervalSince(dep))
                }
                #endif
            }
        }
        .frame(height: 5)
        .clipShape(Capsule())
    }
}

// Every card (leave and walk 2026-10-29, ride 2026-10-31), like the medium Home Screen widget:
// "Leave in 28 min · 7:39am" / "Get off in 5 stops · 9 min", "● Bus 132 toward Malden   arrive
// 8:25am", a note ("At the stop ~7:44am · 4 min to spare", amber when late; the transfer's spare),
// the connection ("then ● Bus 132 6:38pm · 4 min to spare", amber when tight or missed), the legs.
// The headline is amber with `warn`, except while riding (the connection line says it).
// The Lock Screen card under its header; the expanded island under the island's top row.
struct LeaveBody: View {
    let state: RideState
    let text, muted, amber, track: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Its full height: with a note below, the stack squeezed it to its minimum scale (only
            // the width may shrink it).
            headline.font(.title3.weight(.bold)).foregroundStyle(state.warn && state.phase != "riding" ? amber : text).lineLimit(1).minimumScaleFactor(0.7)
                .fixedSize(horizontal: false, vertical: true)
            if let long = state.long, !long.isEmpty {
                HStack(spacing: 6) {
                    RouteDot(hex: state.color, size: 10)
                    LineToward(line: long, headsign: state.headsign ?? "", muted: muted).foregroundStyle(text)
                    Spacer(minLength: 8)
                    if let right = state.right, !right.isEmpty { Text(right).foregroundStyle(muted).lineLimit(1).fixedSize() }
                }
                .font(.subheadline)
            }
            if let note = state.note, !note.isEmpty {
                Text(note).font(.subheadline).foregroundStyle(state.warn ? amber : text).lineLimit(2)
            }
            if !(state.then ?? []).isEmpty || !(state.thenText ?? "").isEmpty {
                ThenLine(legs: state.then ?? [], text: state.thenText ?? "", muted: muted)
                    .font(.subheadline).foregroundStyle(state.nextWarn == true ? amber : text)
            }
            if state.phase == "ask", let dep = state.askDep {
                AnswerButtons(dep: dep, text: text, track: track).padding(.top, 6)
            } else {
                LegsBar(legs: state.legs, track: track).padding(.top, 6)
            }
        }
    }

    private var headline: Text {
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
            if !text.isEmpty { Text(text) }
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
            LeaveBody(state: state, text: th.text, muted: th.muted, amber: th.amber, track: th.track)
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
        .foregroundStyle(state.warn ? Color(hex: "F0A830") : .white)
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
            .foregroundStyle(state.warn ? Color(hex: "F0A830") : .white)
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
        LeaveBody(state: state, text: .white, muted: .gray, amber: amber, track: track)
    }
}
