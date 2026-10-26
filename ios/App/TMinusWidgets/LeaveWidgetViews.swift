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
                    Text(row.line).lineLimit(1).minimumScaleFactor(0.8)
                }
                .font(.caption).foregroundStyle(th.text)
            }
            if !content.next.isEmpty { Text(content.next).font(.caption).foregroundStyle(th.muted).lineLimit(1).minimumScaleFactor(0.8) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// The entry's header, then its row and the next two in one format: departure, route, arrival.
private struct MediumLeave: View {
    let content: LeaveContent
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let th = Theme.of(scheme)
        let tint = content.warn ? th.amber : th.text
        VStack(alignment: .leading, spacing: 2) {
            Text(content.shownName).font(.caption.weight(.semibold)).foregroundStyle(th.muted).lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(content.title).font(.title2.weight(.bold)).lineLimit(1).minimumScaleFactor(0.7)
                if let count = content.entry?.count, !count.isEmpty { Text(count).font(.subheadline.weight(.semibold)).lineLimit(1) }
            }
            .foregroundStyle(tint)
            Spacer(minLength: 0)
            if content.rows.isEmpty {
                if !content.next.isEmpty { Text(content.next).font(.subheadline).foregroundStyle(th.muted) }
            } else {
                Rectangle().fill(th.track).frame(height: 1).padding(.bottom, 4)
                ForEach(Array(content.rows.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 6) {
                        Text(row.time).font(.subheadline.weight(.semibold)).frame(width: 62, alignment: .leading)
                        RouteDot(hex: row.color, size: 8)
                        Text(row.vehicle).font(.subheadline).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(row.arrive).font(.subheadline).foregroundStyle(th.muted).lineLimit(1)
                    }
                    .foregroundStyle(th.text)
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

private struct CircularLeave: View {
    let content: LeaveContent
    var body: some View {
        VStack(spacing: 0) {
            Text(content.entry?.circle ?? "–").font(.title2.weight(.bold)).lineLimit(1).minimumScaleFactor(0.5)
            if let sub = content.entry?.circleSub, !sub.isEmpty { Text(sub).font(.caption2).lineLimit(1).minimumScaleFactor(0.7) }
        }
        .padding(6)
    }
}
