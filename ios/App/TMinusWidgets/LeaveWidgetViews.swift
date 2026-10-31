import SwiftUI

// The leave-times widget's views (LeaveWidget): Home Screen small and medium in the app's colors
// (the Lock Screen sizes were removed 2026-10-31: the leave and ride cards are the Lock Screen's).
// SwiftUI only, so ios/Previews can render them on macOS (the WidgetKit wrappers are in
// LeaveWidget.swift).

enum LeaveSize { case small, medium }

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
    var askDep: Double? { entry?.dep }
    // A countdown to show (else "No more today", "Plan a trip", "Open T-Minus").
    var isHome: Bool { entry?.head != nil }
}

struct LeaveWidgetView: View {
    let content: LeaveContent
    let size: LeaveSize
    var body: some View {
        switch size {
        case .small: if content.isHome { SmallHome(content: content) } else { Plain(content: content, size: size) }
        case .medium: if content.isHome { MediumHome(content: content) } else { Plain(content: content, size: size) }
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
// trip's arrival (amber when the connection is tight or missed: no room for its line).
private struct SmallHome: View {
    let content: LeaveContent
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        let tint = content.warn ? th.amber : th.text
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
                if !content.headsign.isEmpty {
                    Text("toward \(content.headsign)").foregroundStyle(th.muted).lineLimit(1).minimumScaleFactor(0.8).padding(.leading, content.color.isEmpty ? 0 : 13)
                }
            }
            if !content.arrive.isEmpty { Text(content.arrive).foregroundStyle(content.thenWarn ? th.amber : th.muted).lineLimit(1) }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// Home Screen medium (2026-10-29; one ride 2026-10-30; followed rides 2026-10-31): "Leave in 5 min
// · 12:17am" (or "Get off in 5 stops · 9 min"), the line and direction in full ("→" only where
// "toward" doesn't fit), then at the bottom the note (amber with `warn`), the connection on its
// own line ("then ● Bus 132 6:38pm · 4 min to spare", amber when tight or missed), and the later
// legs ("then ● Bus 132", when there's no connection line) with the arrival (never cut). "Did you
// get on?" (2026-10-31): the arrival at the line's end and [Yes] [Missed it] at the bottom.
private struct MediumHome: View {
    let content: LeaveContent
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        let tint = content.warn ? th.amber : th.text
        let time = content.entry?.headTime ?? ""
        VStack(alignment: .leading, spacing: 2) {
            Text(content.shownName).font(.caption.weight(.semibold)).foregroundStyle(th.muted).lineLimit(1)
            (Text(content.entry?.head ?? "").font(.title2.weight(.bold)) + Text(time.isEmpty ? "" : " · \(time)").font(.subheadline.weight(.semibold)))
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity, alignment: .leading)
            if !content.long.isEmpty {
                HStack(spacing: 5) {
                    RouteDot(hex: content.color, size: 8)
                    LineToward(line: content.long, headsign: content.headsign, muted: th.muted)
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
        if !content.thenText.isEmpty {
            ThenLine(legs: content.thenLegs, text: content.thenText, muted: th.muted).foregroundStyle(content.thenWarn ? th.amber : th.text)
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
