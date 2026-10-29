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

// The countdown: whole minutes, ticking down on the phone without updates ("12 minutes", rounded
// down like the app's "12 min"; iOS 18's date offset format), then "<1 minute" once the app or the
// server marks the last 80 s (`soon`; the times aren't accurate to the second).
func countdownText(_ state: RideState) -> Text? {
    if state.soon == true { return Text("<1 minute") }
    guard let until = state.untilDate, until > Date() else { return nil }
    return Text(until, format: .offset(to: Date(), allowedFields: [.minute], maxFieldCount: 1))
}

// The compact island's short form: "28 min" (rounded down, ticking on its own), "<1 min".
func shortCountdown(_ state: RideState) -> Text? {
    if state.soon == true { return Text("<1 min") }
    guard let until = state.untilDate, until > Date() else { return nil }
    return Text(.durationOffset(to: until), format: .units(allowed: [.minutes], width: .abbreviated, fractionalPart: .hide(rounded: .towardZero)))
}

// "Orange · 4 stops · 12 minutes" (or "Leave in 9 minutes": `join`): the title, then the countdown.
struct Headline: View {
    let state: RideState
    var body: some View {
        if let countdown = countdownText(state) {
            Text(state.title + (state.join ?? " · ")) + countdown
        } else {
            Text(state.title)
        }
    }
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
            HStack(spacing: 8) {
                RouteDot(hex: state.color)
                Headline(state: state).lineLimit(1).minimumScaleFactor(0.8)
            }
            .font(.title3.weight(.bold)).foregroundStyle(state.warn ? th.amber : th.text)
            if !state.sub.isEmpty { Text(state.sub).font(.subheadline).foregroundStyle(th.muted).lineLimit(1) }
            if !state.next.isEmpty { Text(state.next).font(.subheadline).foregroundStyle(th.text).lineLimit(2) }
            LegsBar(legs: state.legs, track: th.track).padding(.top, 6)
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

// A leave or walk card: "Leave 9 minutes", "Leave now", "Departs 2 minutes" (the walk card's, or
// amber when too late; scaled to fit: iOS has no live "9m" format).
struct IslandTrailing: View {
    let state: RideState
    var body: some View {
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

// Expanded (long press): the card's content on black.
struct IslandExpanded: View {
    let state: RideState
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Headline(state: state).font(.headline).foregroundStyle(state.warn ? Color(hex: "F0A830") : .white).lineLimit(1)
            if !state.sub.isEmpty { Text(state.sub).font(.subheadline).foregroundStyle(.gray).lineLimit(1) }
            if !state.next.isEmpty { Text(state.next).font(.subheadline).foregroundStyle(.white).lineLimit(2) }
            LegsBar(legs: state.legs, track: Color(hex: "333333")).padding(.top, 4)
        }
    }
}
