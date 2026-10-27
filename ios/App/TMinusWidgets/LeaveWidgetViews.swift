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
}

struct LeaveWidgetView: View {
    let content: LeaveContent
    let size: LeaveSize
    var body: some View {
        switch size {
        case .small: SmallLeave(content: content)
        case .medium: MediumLeave(content: content)
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
// small size's title and count.
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
                if let count = content.headCount, !count.isEmpty { Text(count).font(.subheadline.weight(.semibold)).lineLimit(1) }
            }
            .foregroundStyle(tint)
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
                                Text(row.vehicle).font(.subheadline).lineLimit(1)
                            }
                            Text(row.arrive).font(.subheadline).foregroundStyle(th.muted).lineLimit(1).fixedSize()
                                .gridColumnAlignment(.trailing).frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        .foregroundStyle(th.text)
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
