import SwiftUI

// The leave-times widget's views (LeaveWidget): Home Screen small and medium in the app's colors,
// Lock Screen rectangular, inline and circular in the system's (iOS tints them). SwiftUI only, so
// ios/Previews can render them on macOS (the WidgetKit wrappers are in LeaveWidget.swift).

enum LeaveSize { case small, medium, rectangular, inline, circular }

private extension LeaveContent {
    var shownName: String { name.isEmpty ? "T-Minus" : name }
    var title: String { entry?.title ?? "Open T-Minus" }
    var next: String { entry == nil ? "for new times" : entry!.next }
    var warn: Bool { entry?.warn ?? false }
    var firstRow: WidgetView.Row? { rows.first }
    var headCount: String? { entry?.head == nil ? entry?.count : entry?.headCount }
    // Answers from 2026-10-29 on carry the Home Screen layouts' fields (older ones: the layouts before).
    var isHome: Bool { (entry?.row ?? -1) >= 0 && !(entry?.headTime ?? "").isEmpty && entry?.head != nil && firstRow?.long != nil }
}

struct LeaveWidgetView: View {
    let content: LeaveContent
    let size: LeaveSize
    var body: some View {
        switch size {
        case .small: if content.isHome { SmallHome(content: content) } else { SmallLeave(content: content) }
        case .medium: if content.isHome { MediumHome(content: content) } else { MediumLeave(content: content) }
        case .rectangular: RectangularLeave(content: content)
        case .inline: Text(content.entry?.inline ?? "Open T-Minus")
        case .circular: CircularLeave(content: content)
        }
    }
}

private struct SmallLeave: View {
    let content: LeaveContent
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        let tint = content.warn ? th.amber : th.text
        VStack(alignment: .leading, spacing: 2) {
            Text(content.shownName).font(.caption.weight(.semibold)).foregroundStyle(th.muted).lineLimit(1)
            Text(content.title).font(.title3.weight(.bold)).foregroundStyle(tint).lineLimit(2).minimumScaleFactor(0.7)
            if let count = content.entry?.count, !count.isEmpty {
                Text(count).font(.subheadline.weight(.semibold)).foregroundStyle(tint).lineLimit(2).minimumScaleFactor(0.8)
            }
            Spacer(minLength: 0)
            if let row = content.firstRow {
                HStack(spacing: 5) {
                    RouteDot(hex: row.color, size: 8)
                    Text(content.entry?.line ?? row.line).lineLimit(1).minimumScaleFactor(0.8)
                }
                .font(.caption).foregroundStyle(th.text)
            }
            if !content.next.isEmpty { Text(content.next).font(.caption).foregroundStyle(th.muted).lineLimit(1).minimumScaleFactor(0.8) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// The countdown ("Leave in 9 min"), then the entry's row and the next two in one format: leave-by
// (the first row's departure, amber, past it), route, arrival. Answers without `head`: the
// small size's title and count. Only the route column gives way (shrinks, then truncates), so
// long text can't widen the view past the widget and clip it on both sides (seen 2026-10-28).
private struct MediumLeave: View {
    let content: LeaveContent
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        let tint = content.warn ? th.amber : th.text
        VStack(alignment: .leading, spacing: 2) {
            Text(content.shownName).font(.caption.weight(.semibold)).foregroundStyle(th.muted).lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(content.entry?.head ?? content.title).font(.title2.weight(.bold)).lineLimit(1).minimumScaleFactor(0.7)
                if let count = content.headCount, !count.isEmpty { Text(count).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8) }
            }
            .foregroundStyle(tint).frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
            if content.rows.isEmpty {
                if !content.next.isEmpty { Text(content.next).font(.subheadline).foregroundStyle(th.muted) }
            } else {
                Rectangle().fill(th.track).frame(height: 1).padding(.bottom, 4)
                // A grid: the time column as wide as its widest time ("10:22am"; a fixed width cut it).
                Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 2) {
                    ForEach(Array(content.rows.enumerated()), id: \.offset) { i, row in
                        let late = i == 0 ? content.entry?.rowTime : nil
                        GridRow {
                            Text(late ?? row.time).font(.subheadline.weight(.semibold)).lineLimit(1).fixedSize()
                                .foregroundStyle(late == nil ? th.text : th.amber)
                            HStack(spacing: 6) {
                                RouteDot(hex: row.color, size: 8)
                                Text(row.vehicle).font(.subheadline).lineLimit(1).minimumScaleFactor(0.7).truncationMode(.tail)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Text(row.arrive).font(.subheadline).foregroundStyle(th.muted).lineLimit(1).fixedSize()
                                .gridColumnAlignment(.trailing)
                        }
                        .foregroundStyle(th.text)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// "Orange Line toward Forest Hills", or "Orange Line → Forest Hills" where "toward" doesn't fit
// (then truncated); the direction muted. No headsign: the line alone.
private struct LineToward: View {
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

// Home Screen small (2026-10-29): the countdown ("Leave in 5 min"), its time ("12:17am", the
// leave-by; "departs 12:20am" past it), the line in long form and its direction on up to two lines.
// No arrival (the medium size and the app have it).
private struct SmallHome: View {
    let content: LeaveContent
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        let tint = content.warn ? th.amber : th.text
        let row = content.firstRow!
        VStack(alignment: .leading, spacing: 2) {
            Text(content.shownName).font(.caption.weight(.semibold)).foregroundStyle(th.muted).lineLimit(1)
            Text(content.entry?.head ?? "").font(.title3.weight(.bold)).foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.7)
            Text(content.entry?.headTime ?? "").font(.subheadline.weight(.semibold)).foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.7)
            Spacer(minLength: 0)
            HStack(spacing: 5) {
                RouteDot(hex: row.color, size: 8)
                Text(row.long ?? row.vehicle).lineLimit(1).minimumScaleFactor(0.8)
            }
            .font(.caption).foregroundStyle(th.text)
            if let h = row.headsign, !h.isEmpty {
                Text("toward \(h)").font(.caption).foregroundStyle(th.muted).lineLimit(2).padding(.leading, row.color.isEmpty ? 0 : 13)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// Home Screen medium (2026-10-29): "Leave in 5 min · 12:17am", the first ride's line and direction
// with its arrival, then the next two rides (leave-by, arrival), naming their vehicle only where it
// differs from the first's ("Red → Braintree"). Only the route text gives way.
private struct MediumHome: View {
    let content: LeaveContent
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        let tint = content.warn ? th.amber : th.text
        let first = content.firstRow!
        VStack(alignment: .leading, spacing: 2) {
            Text(content.shownName).font(.caption.weight(.semibold)).foregroundStyle(th.muted).lineLimit(1)
            (Text(content.entry?.head ?? "").font(.title2.weight(.bold)) + Text(" · \(content.entry?.headTime ?? "")").font(.subheadline.weight(.semibold)))
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity, alignment: .leading)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                HStack(spacing: 5) {
                    RouteDot(hex: first.color, size: 8)
                    LineToward(line: first.long ?? first.vehicle, headsign: first.headsign ?? "", muted: th.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(first.arrive).foregroundStyle(th.muted).lineLimit(1).fixedSize()
            }
            .font(.subheadline).foregroundStyle(th.text)
            Spacer(minLength: 0)
            let later = Array(content.rows.dropFirst().prefix(2))
            if !later.isEmpty {
                Rectangle().fill(th.track).frame(height: 1).padding(.bottom, 4)
                Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 2) {
                    ForEach(Array(later.enumerated()), id: \.offset) { _, row in
                        let differs = (row.short ?? row.vehicle) != (first.short ?? first.vehicle) || (row.headsign ?? "") != (first.headsign ?? "")
                        GridRow {
                            Text(row.time).font(.subheadline.weight(.semibold)).lineLimit(1).fixedSize()
                            HStack(spacing: 6) {
                                if differs {
                                    RouteDot(hex: row.color, size: 8)
                                    LineToward(line: row.short ?? row.vehicle, headsign: row.headsign ?? "", muted: th.muted)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Text(row.arrive).foregroundStyle(th.muted).lineLimit(1).fixedSize().gridColumnAlignment(.trailing)
                        }
                        .font(.subheadline).foregroundStyle(th.text)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct RectangularLeave: View {
    let content: LeaveContent
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(content.shownName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Text(content.entry?.lock ?? content.title).font(.headline).lineLimit(1).minimumScaleFactor(0.7)
            Text(content.entry?.lockSub ?? content.next).font(.caption).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// "38m" over "Bus 132" in a ring like the system's circular gauge (open at the bottom), draining
// over the hour before the leave-by. Drawn by hand, not Gauge, so the macOS previews show it.
private struct CircularLeave: View {
    let content: LeaveContent
    private let sweep = 0.75 // of the circle; the gap is the rest, centered at the bottom
    var body: some View {
        ZStack {
            if let ring = content.entry?.ring, ring >= 0 {
                Circle().trim(from: 0, to: sweep).stroke(.primary.opacity(0.3), style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .rotationEffect(.degrees(135))
                if ring > 0 {
                    Circle().trim(from: 0, to: sweep * min(ring, 1)).stroke(.primary, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .rotationEffect(.degrees(135))
                }
            }
            VStack(spacing: 0) {
                Text(content.entry?.circle ?? "–").font(.title3.weight(.bold)).lineLimit(1).minimumScaleFactor(0.5)
                if let sub = content.entry?.circleSub, !sub.isEmpty { Text(sub).font(.system(size: 10, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.6) }
            }
            .padding(.horizontal, 9)
        }
        .padding(3)
    }
}
