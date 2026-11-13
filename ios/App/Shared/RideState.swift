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
        // The stops between boarding and drop-off as shares of dep → arr, 0...1 (2026-11-13, the
        // legs bar's dots; absent from older servers and while the app has no stop list).
        var at: [Double]? = nil
    }

    var phase: String   // riding, transfer, walking, arrived; leave, now, departs, gone (shown muted), cancelled, walk
    var warn: Bool      // amber: at risk (older builds: also a missed or no connection, past the last chance, gone)
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
    var nextWarn: Bool? = nil // the ride card's `next` line amber ("· tight"; absent from older servers)
    // The leave and walk cards' layout (2026-10-29, build 35; absent: the ride card, or an older
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
    // The ride card in the same layout (2026-10-31; all cards from then on carry `head`):
    // `countAfter` puts the countdown after " · " in `headTime`'s place ("Get off in 5 stops · 9
    // min"); the connection line: "then" with `then` (the later legs in short form) and
    // `thenText` ("6:38pm · 4 min to spare"; alone: "No connection after 6:31pm"), amber with
    // `nextWarn`; `islandText` beside the compact island's emoji ("5 stops", "next", "here").
    struct ThenLeg: Codable, Hashable {
        var label: String
        var color: String
    }
    var countAfter: Bool? = nil
    var then: [ThenLeg]? = nil
    var thenText: String? = nil
    var islandText: String? = nil
    // While riding (2026-11-06): the drop-off in the headsign's place ("● Orange Line to Malden
    // Center", a flag stop "🚩 Malden Center"), the arrival (`right`) moved to the connection's
    // line; the connection reads "then ● Bus 132 at 6:38pm" (`thenText` "at 6:38pm"), its time
    // amber when `thenState` is "tight", red when "missed". Absent from older servers.
    var dropOff: String? = nil
    var thenState: String? = nil
    // Red (2026-11-08; absent from older servers): `late` the headline and the note (too late at
    // your pace: past the last chance, a late walk, a missed or no connection; `warn` is set too,
    // for older builds), `nextLate` the whole "No connection after 6:31pm" line.
    var late: Bool? = nil
    var nextLate: Bool? = nil
    // "Did you get on?" (2026-10-31): the asked departure (Unix seconds) for the Yes / Missed it
    // links (answerURL), in place of the legs bar.
    var askDep: Double? = nil

    // `tminus://answer?a=yes|missed&dep=<s>`: opens the app, which answers the question for that
    // departure (SceneDelegate → TMinusPlugin's `answer` event → index.html).
    static func answerURL(yes: Bool, dep: Double) -> URL {
        URL(string: "tminus://answer?a=\(yes ? "yes" : "missed")&dep=\(Int(dep))")!
    }

    var untilDate: Date? { until > 0 ? Date(timeIntervalSince1970: until) : nil }
    // Dimmed by iOS 2 min after the countdown ends without a newer update (as the server's pushes).
    var staleDate: Date? { untilDate.map { max($0, Date()).addingTimeInterval(120) } }
}
