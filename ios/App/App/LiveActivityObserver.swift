import ActivityKit
import Foundation
import UIKit

// Leave cards (iOS Phase 3a): the server starts a reminder's Live Activity by push, with the app's
// push-to-start token; the card's own token must then reach the server for its updates. iOS hands
// both over in the app process, possibly launched in the background (no web page loaded), so they
// are handled here, from launch: the start token is kept for the web app (TMinusPlugin's
// liveActivityStartToken, its `startToken` event), and each leave card's token is sent straight
// to PUT /api/reminders/<reminderId>.
final class LiveActivityObserver {
    static let shared = LiveActivityObserver()
    static let startTokenKey = "startToken"
    static let startTokenChanged = Notification.Name("TMinusStartToken")

    private var observed = Set<String>()
    private let lock = NSLock()

    func start() {
        Task {
            for await data in Activity<RideAttributes>.pushToStartTokenUpdates {
                let token = Self.hex(data)
                UserDefaults.standard.set(token, forKey: Self.startTokenKey)
                NotificationCenter.default.post(name: Self.startTokenChanged, object: token)
            }
        }
        Task {
            for act in Activity<RideAttributes>.activities { observe(act) }
            for await act in Activity<RideAttributes>.activityUpdates { observe(act) }
        }
    }

    private func observe(_ act: Activity<RideAttributes>) {
        guard let reminderId = act.attributes.reminderId else { return }
        lock.lock()
        let isNew = observed.insert(act.id).inserted
        lock.unlock()
        guard isNew else { return }
        Task {
            for await data in act.pushTokenUpdates {
                await send(reminderId: reminderId, token: Self.hex(data))
            }
        }
    }

    @MainActor private func send(reminderId: String, token: String) async {
        guard let url = URL(string: "\(Self.baseURL)/api/reminders/\(reminderId)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["activity": ["token": token]])
        let task = UIApplication.shared.beginBackgroundTask(withName: "leave card token", expirationHandler: nil)
        defer { UIApplication.shared.endBackgroundTask(task) }
        for attempt in 0..<3 {
            if attempt > 0 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
            do {
                let (_, res) = try await URLSession.shared.data(for: req)
                let status = (res as? HTTPURLResponse)?.statusCode ?? 0
                if status < 500 { return } // 204, or 404: the reminder is gone
            } catch {
                continue
            }
        }
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
