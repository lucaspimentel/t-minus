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

// The countdown, ticking down on the phone without updates: "12 minutes" (rounded down like the
// app's "12 min"; "72 minutes" past an hour), "34 seconds" in the last minute (iOS 18's date offset
// format). Past its time it reads "−1 minute" until the next update (the server polls every 20 s).
func countdownText(_ until: Date) -> Text {
    Text(until, format: .offset(to: Date(), allowedFields: [.minute, .second], maxFieldCount: 1))
}

// "Orange · 4 stops · 12 minutes": the title, then the countdown.
struct Headline: View {
    let state: RideState
    var body: some View {
        if let until = state.untilDate, until > Date() {
            Text(state.title + " · ") + countdownText(until)
        } else {
            Text(state.title)
        }
    }
}

// One segment per leg: full once done, advancing on its own while ridden.
struct LegsBar: View {
    let legs: [RideState.Leg]
    let track: Color
    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(legs.enumerated()), id: \.offset) { _, leg in
                let dep = Date(timeIntervalSince1970: leg.dep), arr = Date(timeIntervalSince1970: max(leg.arr, leg.dep + 1))
                let tint = leg.color.isEmpty ? Color.gray : Color(hex: leg.color)
                ZStack {
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

struct IslandTrailing: View {
    let state: RideState
    var body: some View {
        if state.phase == "riding" && state.stops > 0 {
            Text("\(state.stops) stop\(state.stops == 1 ? "" : "s")").font(.subheadline.weight(.semibold))
        } else if let until = state.untilDate, until > Date() {
            Text(timerInterval: Date()...until, countsDown: true).font(.subheadline.weight(.semibold)).monospacedDigit().frame(maxWidth: 48)
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
