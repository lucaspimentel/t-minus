import ActivityKit
import Foundation
import UIKit

// Leave cards (iOS Phase 3a): the server starts a reminder's Live Activity by push, with the app's
// push-to-start token; the card's own token must then reach the server for its updates. iOS hands
// both over in the app process, possibly launched in the background (no web page loaded), so they
// are handled here, from launch: the start token is kept for the web app (TMinusPlugin's
// liveActivityStartToken, its `startToken` event), and each leave card's token is sent straight
// to PUT /api/reminders/<reminderId>.
// Dismissed cards (swiped away, or ended by iOS or the server; not those the app ended): kept for
// the web app (liveActivityDismissed, "Show again"), and a leave card's is sent to the server
// (`cardDismissed`), which then sends the reminder's steps as notifications.
final class LiveActivityObserver {
    static let shared = LiveActivityObserver()
    static let startTokenKey = "startToken"
    static let startTokenChanged = Notification.Name("TMinusStartToken")
    static let dismissedKey = "dismissedActivities"
    static let knownKey = "knownActivities" // the cards seen and not ended by the app: [{ id, reminderId? }]

    private var observed = Set<String>()
    private var appEnded = Set<String>()
    private let lock = NSLock()

    // The app ended this card (TMinusPlugin.liveActivityEnd): not counted as dismissed.
    func endedByApp(_ id: String) {
        lock.lock()
        appEnded.insert(id)
        lock.unlock()
        setKnown(Self.list(Self.knownKey).filter { $0["id"] != id })
    }

    private static func list(_ key: String) -> [[String: String]] {
        UserDefaults.standard.array(forKey: key) as? [[String: String]] ?? []
    }
    private func setKnown(_ list: [[String: String]]) {
        UserDefaults.standard.set(Array(list.suffix(20)), forKey: Self.knownKey)
    }
    private static func entry(_ id: String, _ reminderId: String?) -> [String: String] {
        var e = ["id": id]
        if let reminderId { e["reminderId"] = reminderId }
        return e
    }

    private func wasEndedByApp(_ id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return appEnded.contains(id)
    }

    // [{ id, reminderId? }], oldest first.
    static func dismissed() -> [[String: String]] { list(dismissedKey) }

    // Recorded for the web app; a leave card's also goes to the server.
    private func dismiss(id: String, reminderId: String?) async {
        var list = Self.dismissed().filter { $0["id"] != id }
        list.append(Self.entry(id, reminderId))
        UserDefaults.standard.set(Array(list.suffix(20)), forKey: Self.dismissedKey)
        setKnown(Self.list(Self.knownKey).filter { $0["id"] != id })
        if let reminderId { await send(reminderId: reminderId, body: ["cardDismissed": true], what: "leave card dismissed") }
    }

    // A new leave card for a reminder replaces its dismissed one.
    private func clearDismissed(reminderId: String) {
        let list = Self.dismissed().filter { $0["reminderId"] != reminderId }
        UserDefaults.standard.set(list, forKey: Self.dismissedKey)
    }

    func start() {
        Task {
            for await data in Activity<RideAttributes>.pushToStartTokenUpdates {
                let token = Self.hex(data)
                UserDefaults.standard.set(token, forKey: Self.startTokenKey)
                NotificationCenter.default.post(name: Self.startTokenChanged, object: token)
            }
        }
        Task {
            // Cards gone while the app wasn't running (no state update came): dismissed.
            let current = Set(Activity<RideAttributes>.activities.map(\.id))
            for e in Self.list(Self.knownKey) where !current.contains(e["id"] ?? "") {
                await dismiss(id: e["id"] ?? "", reminderId: e["reminderId"])
            }
            for act in Activity<RideAttributes>.activities { observe(act) }
            for await act in Activity<RideAttributes>.activityUpdates { observe(act) }
        }
    }

    func observe(_ act: Activity<RideAttributes>) {
        lock.lock()
        let isNew = observed.insert(act.id).inserted
        lock.unlock()
        guard isNew else { return }
        let reminderId = act.attributes.reminderId
        if act.activityState != .ended, act.activityState != .dismissed, !Self.list(Self.knownKey).contains(where: { $0["id"] == act.id }) {
            setKnown(Self.list(Self.knownKey) + [Self.entry(act.id, reminderId)])
        }
        if let reminderId {
            clearDismissed(reminderId: reminderId)
            Task {
                for await data in act.pushTokenUpdates {
                    await send(reminderId: reminderId, body: ["activity": ["token": Self.hex(data)]], what: "leave card token")
                }
            }
        }
        Task {
            for await state in act.activityStateUpdates where state == .dismissed {
                if wasEndedByApp(act.id) { continue }
                await dismiss(id: act.id, reminderId: reminderId)
            }
        }
    }

    @MainActor private func send(reminderId: String, body: [String: Any], what: String) async {
        guard let url = URL(string: "\(Self.baseURL)/api/reminders/\(reminderId)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let task = UIApplication.shared.beginBackgroundTask(withName: what, expirationHandler: nil)
        defer { UIApplication.shared.endBackgroundTask(task) }
        var lastStatus = 0
        var lastError: Error?
        for attempt in 0..<3 {
            if attempt > 0 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
            do {
                let (_, res) = try await URLSession.shared.data(for: req)
                let status = (res as? HTTPURLResponse)?.statusCode ?? 0
                if status < 500 { return } // 204, or 404: the reminder is gone
                lastStatus = status
            } catch {
                lastError = error
                continue
            }
        }
        // Never the token itself.
        Observability.addError(message: "\(what) not sent", type: "LiveActivityToken",
                               attributes: ["reminderId": reminderId, "status": lastStatus,
                                            "error": lastError?.localizedDescription ?? ""])
    }

    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    // The live site (capacitor.config.json's server.url, bundled by `npx cap sync`).
    static let baseURL: String = {
        if let url = Bundle.main.url(forResource: "capacitor.config", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let server = json["server"] as? [String: Any],
           let base = server["url"] as? String {
            return base.hasSuffix("/") ? String(base.dropLast()) : base
        }
        return "https://t-minus.lucasp.net"
    }()
}
