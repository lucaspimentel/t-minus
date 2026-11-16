import Foundation

// The app's server (DESIGN.md "Staging", "In the iOS app"): production (capacitor.config.json's
// server.url) or staging, set in iOS Settings › T-Minus (Settings.bundle, key `server`) or Setup ›
// Developer (TMinusPlugin.serverSet). Staging lasts 2 h from when the app first sees it, then the
// setting goes back to production (iOS Settings shows that too). Only the WebView follows it: the
// native calls (LiveActivityObserver.baseURL, boarding, RUM's config, the widget) stay on production.
enum ServerSwitch {
    static let stagingURL = "https://staging.t-minus.lucasp.net"
    static let duration: TimeInterval = 2 * 60 * 60
    private static let key = "server" // Settings.bundle's value: "production" (default) or "staging"
    private static let sinceKey = "serverStagingSince"
    private static var defaults: UserDefaults { .standard }

    // The setting with the 2 h limit applied: an expired staging is written back as production.
    static var staging: Bool {
        guard defaults.string(forKey: key) == "staging" else {
            defaults.removeObject(forKey: sinceKey)
            return false
        }
        let now = Date().timeIntervalSince1970
        guard let since = defaults.object(forKey: sinceKey) as? Double else {
            defaults.set(now, forKey: sinceKey) // turned on in iOS Settings: the 2 h start now
            return true
        }
        if now - since >= duration {
            set(staging: false)
            return false
        }
        return true
    }

    // When staging ends (epoch ms), or nil on production.
    static var until: Double? {
        guard staging, let since = defaults.object(forKey: sinceKey) as? Double else { return nil }
        return (since + duration) * 1000
    }

    static func set(staging on: Bool) {
        defaults.set(on ? "staging" : "production", forKey: key)
        if on { defaults.set(Date().timeIntervalSince1970, forKey: sinceKey) } else { defaults.removeObject(forKey: sinceKey) }
    }
}
