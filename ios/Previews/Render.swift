import AppKit
import SwiftUI

// The Live Activity's previews for review without a Mac (the ios workflow's artifact): the views
// in ios/App/TMinusWidgets/RideViews.swift rendered from sample states to one PNG per theme.
// swiftc -parse-as-library ios/App/Shared/RideState.swift ios/App/TMinusWidgets/RideViews.swift ios/Previews/Render.swift -o render
// ./render <out dir>

private let now = Date().timeIntervalSince1970
private let orange = "ED8B00", bus = "FFC72C"
private func legs(_ a: (String, Double, Double)...) -> [RideState.Leg] { a.map { RideState.Leg(color: $0.0, dep: now + $0.1 * 60, arr: now + $0.2 * 60) } }
private let trip = legs((orange, -8, 6), (bus, 14, 26))

private let samples: [(String, RideState)] = [
    ("Riding", RideState(phase: "riding", warn: false, color: orange, label: "OL", title: "Orange · 4 stops", until: now + 360, stops: 4,
                         sub: "Get off 7:54am at Sullivan Square", next: "Then Bus 132 toward Malden 8:02am · 3 min to spare", legs: trip)),
    ("Get off", RideState(phase: "riding", warn: false, color: orange, label: "OL", title: "Next stop: get off", until: now + 60, stops: 1,
                          sub: "Get off 7:54am at Sullivan Square", next: "Then Bus 132 toward Malden 8:02am · 3 min to spare", legs: trip)),
    ("Transfer", RideState(phase: "transfer", warn: false, color: bus, label: "132", title: "Transfer · Bus 132", until: now + 300, stops: -1,
                           sub: "Bus 132 toward Malden · 8:02am", next: "Arrive ~8:25am", legs: legs((orange, -20, -6), (bus, 5, 17)))),
    ("Missed connection", RideState(phase: "transfer", warn: true, color: bus, label: "132", title: "Missed the 8:02am · next 8:14am", until: now + 420, stops: -1,
                                    sub: "Bus 132 · 8:14am", next: "Arrive ~8:37am", legs: legs((orange, -20, -6), (bus, 7, 19)))),
    ("No connection", RideState(phase: "transfer", warn: true, color: bus, label: "132", title: "No connection after 8:01am", until: 0, stops: -1,
                                sub: "", next: "Open the app for another way.", legs: legs((orange, -20, -6), (bus, 7, 19)))),
    ("Walking", RideState(phase: "walking", warn: false, color: "", label: "🚶", title: "Walking", until: now + 240, stops: -1,
                          sub: "Arrive ~8:25am", next: "", legs: legs((orange, -30, -16), (bus, -12, -1)))),
    ("Arrived", RideState(phase: "arrived", warn: false, color: "", label: "", title: "Arrived ~8:25am", until: 0, stops: -1,
                          sub: "", next: "", legs: legs((orange, -30, -16), (bus, -12, -4)))),
]

private struct Sheet: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            let until = Date().addingTimeInterval(12 * 60 + 34)
            Group {
                Text("A offset: ") + Text(until, format: .offset(to: Date(), allowedFields: [.minute], maxFieldCount: 1))
                Text("B reference: ") + Text(until, format: .reference(to: Date(), allowedFields: [.minute]))
                Text("C relative: ") + Text(until, style: .relative)
                Text("D timer: ") + Text(timerInterval: Date()...until, countsDown: true)
                Text("E offset h/m: ") + Text(Date().addingTimeInterval(72 * 60), format: .offset(to: Date(), allowedFields: [.hour, .minute], maxFieldCount: 2))
                Text("F reference h/m: ") + Text(Date().addingTimeInterval(72 * 60), format: .reference(to: Date(), allowedFields: [.hour, .minute]))
            }
            .font(.title3.weight(.bold)).foregroundStyle(.white)
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

@main
struct Render {
    @MainActor static func main() throws {
        let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
        for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
            let renderer = ImageRenderer(content: Sheet().environment(\.colorScheme, scheme))
            renderer.scale = 2
            guard let cg = renderer.cgImage, let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else {
                throw NSError(domain: "Render", code: 1, userInfo: [NSLocalizedDescriptionKey: "rendering \(name) failed"])
            }
            try png.write(to: out.appendingPathComponent("live-activity-\(name).png"))
        }
    }
}
