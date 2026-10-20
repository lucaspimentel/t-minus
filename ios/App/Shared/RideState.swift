import Foundation

// The Live Activity's content: liveActivityState in core.js (built by the app for local updates
// and by the server for pushes). Times are Unix seconds. Plain Codable (no ActivityKit) so the
// views also compile on macOS for the CI previews (ios/Previews).
struct RideState: Codable, Hashable {
    struct Leg: Codable, Hashable {
        var color: String
        var dep: Double
        var arr: Double
    }

    var phase: String   // riding, transfer, walking, arrived
    var warn: Bool      // a missed or no connection (amber)
    var color: String   // the route's hex color, "" for none
    var label: String   // the Dynamic Island's route label ("OL", "132", "🚶")
    var title: String
    var until: Double   // the countdown's end, 0 for none
    var stops: Int      // stops left, -1 when unknown
    var sub: String
    var next: String
    var legs: [Leg]

    var untilDate: Date? { until > 0 ? Date(timeIntervalSince1970: until) : nil }
    // Dimmed by iOS 2 min after the countdown ends without a newer update (as the server's pushes).
    var staleDate: Date? { untilDate.map { max($0, Date()).addingTimeInterval(120) } }
}
