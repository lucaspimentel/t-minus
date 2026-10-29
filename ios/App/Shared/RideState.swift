import Foundation

// The Live Activity's content: liveActivityState (a ride) or leaveActivityState / walkActivityState
// (a leave card) in core.js (built by the app for local updates
// and by the server for pushes). Times are Unix seconds. Plain Codable (no ActivityKit) so the
// views also compile on macOS for the CI previews (ios/Previews).
struct RideState: Codable, Hashable {
    struct Leg: Codable, Hashable {
        var color: String
        var dep: Double
        var arr: Double
    }

    var phase: String   // riding, transfer, walking, arrived; leave, now, departs, gone, cancelled, walk
    var warn: Bool      // a missed or no connection (amber)
    var color: String   // the route's hex color, "" for none
    var label: String   // the Dynamic Island's route label ("OL", "132", "🚶")
    var title: String
    var until: Double   // the countdown's end, 0 for none
    var stops: Int      // stops left, -1 when unknown
    var sub: String
    var next: String
    var legs: [Leg]
    var soon: Bool? = nil // the countdown's last 80 s: "<1 minute" (absent from older servers)
    var island: String? = nil // a leave or walk card: the Dynamic Island's word ("Leave", "Leave now", "Departs", "" walking)
    var join: String? = nil   // between the title and the countdown: " · " (default), " " ("Leave in 9 minutes")
    // The leave and walk cards' layout (2026-10-29, build 32; absent: the ride card, or an older
    // server): `head` ("Leave in") with a live countdown to `countTo` (0: none), then `headTime`;
    // the line `long` "toward `headsign`" with `right` ("arrive 8:25am") at its end ("" long: no
    // line); `note` below; `emoji` before the compact island's countdown (🚶, 🚌, 🚇, 🚊).
    var head: String? = nil
    var countTo: Double? = nil
    var headTime: String? = nil
    var long: String? = nil
    var headsign: String? = nil
    var right: String? = nil
    var note: String? = nil
    var emoji: String? = nil

    var untilDate: Date? { until > 0 ? Date(timeIntervalSince1970: until) : nil }
    // Dimmed by iOS 2 min after the countdown ends without a newer update (as the server's pushes).
    var staleDate: Date? { untilDate.map { max($0, Date()).addingTimeInterval(120) } }
}
