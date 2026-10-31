import Foundation
import Security

// The leave-times widget's data (IOS.md, DESIGN.md "Widget"). The app writes the widget's request
// to the shared keychain group (TMinus.widgetSave); the widget posts it to /api/widget and draws
// the answer, widgetView in core.js: rows and entries with their text, times in Unix seconds.
// Plain Codable so the views also compile on macOS for the CI previews (ios/Previews).
//
// Keychain sharing, not an App Group: the CI's App Store Connect API key can't register App
// Groups (401 on /appGroups), while every profile already allows the team's keychain groups. Both
// targets list `<team>.net.lucasp.tminus.shared` first in keychain-access-groups, so items added
// without a group land there, and reads without one search it.
enum WidgetStore {
    static let kind = "LeaveWidget"
    static let last = "widget.last" // the widget's last answer (its own UserDefaults), for when the server can't be reached
    private static let item: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "net.lucasp.tminus.widget",
        kSecAttrAccount as String: "request",
    ]

    // The request body (JSON text), from the app; readable by the widget once the phone has been
    // unlocked since it started. Returns the keychain's status (errSecSuccess when saved).
    static func saveRequest(_ body: String) -> OSStatus {
        let data = Data(body.utf8)
        let update: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
        let status = SecItemUpdate(item as CFDictionary, update as CFDictionary)
        guard status == errSecItemNotFound else { return status }
        return SecItemAdd(item.merging(update) { $1 } as CFDictionary, nil)
    }

    static func loadRequest() -> String? {
        var out: CFTypeRef?
        let query = item.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { $1 }
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

struct WidgetView: Codable, Hashable {
    struct Row: Codable, Hashable {
        var time: String        // "7:39am": the leave-by
        var vehicle: String     // "Bus 132", "Orange Line"
        var short: String? = nil // "Bus 132", "Orange" (absent from answers before the ring)
        var color: String       // the route's hex color, "" for none
        var label: String       // "132", "OL"
        var line: String        // "Bus 132" (answers before the leave-by rule: "Bus 132 at 7:48am")
        var arrive: String      // "arrive 8:25am"
        var arriveTitle: String // "Arrive 8:25am"
        // The Home Screen layouts (2026-10-29; absent from older answers):
        var long: String? = nil     // "Orange Line", "Bus 132"
        var headsign: String? = nil // "Forest Hills", "" for none
        // The later legs in short form (2026-10-30; absent from older answers): "then ● Bus 132".
        struct Leg: Codable, Hashable {
            var label: String
            var color: String
        }
        var then: [Leg]? = nil
    }
    struct Entry: Codable, Hashable {
        var at: Double          // shown from (Unix seconds)
        var row: Int            // its row, -1 for none
        var title: String       // "Leave 7:42am", "Departs", "No more today"
        var count: String       // "in 9 min", ""
        var warn: Bool          // the headline amber (and a walking or transfer note)
        var next: String        // "Arrive 8:25am", "First 5:12am"
        var head: String? = nil      // the countdown: "Leave in 9 min", "Departs in 4 min", "Get off in 5 stops"
        var headTime: String? = nil  // beside it: "12:17am", "9 min" (after a stop count)
        var line: String? = nil      // the vehicle line past the leave-by: "Bus 132 → Malden at 7:48am"
        var rowTime: String? = nil   // the departure past the leave-by
        // A followed ride (2026-10-31; row -1): the entry's own line, arrival, note and connection
        // in place of its row's (the cards' content: walking, the question, riding, the transfer).
        var long: String? = nil      // "Orange Line"; "" for none (walking to the destination, arrived)
        var headsign: String? = nil
        var color: String? = nil
        var arrive: String? = nil    // "arrive 7:21pm"
        var note: String? = nil      // "At the stop ~6:13pm · 2 min to spare", "4 min to spare" (amber with `warn`)
        var then: [RideState.ThenLeg]? = nil // the connection: "then ● Bus 132" …
        var thenText: String? = nil  // … "6:38pm · 4 min to spare"
        var thenWarn: Bool? = nil    // amber (and the small size's arrival)
        var dep: Double? = nil       // "Did you get on?": the asked departure, for Yes / Missed it (medium)
    }
    var name: String
    var rows: [Row]
    var entries: [Entry]
    var end: Double?            // past it: "Open T-Minus"
    var refresh: Double         // when to ask again
}

// What one timeline entry shows: an entry of the answer and its rows (from its own, up to 3), or
// "Open T-Minus" (`entry` nil: no answer yet, or every time in it has passed).
struct LeaveContent: Hashable {
    var name: String
    var entry: WidgetView.Entry?
    var rows: [WidgetView.Row]

    static func stale(_ name: String) -> LeaveContent { LeaveContent(name: name, entry: nil, rows: []) }

    // The answer as (date, content) pairs from `now` on: entries already replaced are left out,
    // and "Open T-Minus" follows at `end`.
    static func timeline(_ v: WidgetView?, now: Date) -> [(Date, LeaveContent)] {
        guard let v else { return [(now, .stale(""))] }
        var out: [(Date, LeaveContent)] = []
        for (i, e) in v.entries.enumerated() {
            if i + 1 < v.entries.count, Date(timeIntervalSince1970: v.entries[i + 1].at) <= now { continue }
            let rows = e.row >= 0 && e.row < v.rows.count ? Array(v.rows[e.row...].prefix(3)) : []
            out.append((max(Date(timeIntervalSince1970: e.at), out.isEmpty ? .distantPast : out[out.count - 1].0), LeaveContent(name: v.name, entry: e, rows: rows)))
        }
        if let end = v.end { out.append((Date(timeIntervalSince1970: end), .stale(v.name))) }
        if out.isEmpty || out[0].0 > now { out.insert((now, .stale(v.name)), at: 0) }
        return out
    }
}
