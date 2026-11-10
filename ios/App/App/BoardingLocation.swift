import ActivityKit
import CoreLocation
import Foundation
import JavaScriptCore
import UIKit

// Boarding from location (DESIGN.md "Boarding from location"): a belled ride's boarding stop as a
// geofence, GPS from "At the stop" / "Leaving now" until the ride is over, and the MBTA's vehicle
// positions, matched by core.js's nativeBoardingStep. A geofence entry can relaunch the app in
// the background without its web page, so all of it runs here: core.js (the same file the page
// imports, cached on the device) in a JSContext, fed with the phone's fixes and the proxy's
// answers. The page arms and disarms it (TMinusPlugin's boarding* methods), shows what it
// decided (the `boarding` event, boardingPending) and its log.
// Coordinates and distances never leave the phone: they go only to the on-device log.

// The on-device log (Settings → "Boarding log"): [{ at, line }] for BOARDING_LOG_DAYS.
final class BoardingLog {
    static let shared = BoardingLog()
    private struct Entry: Codable { let at: Double; let line: String }
    private let queue = DispatchQueue(label: "boarding-log")
    private let keepMs: Double = 7 * 24 * 3600 * 1000
    private var url: URL { BoardingStore.dir.appendingPathComponent("boarding-log.json") }

    private func read() -> [Entry] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    func append(_ line: String) {
        queue.async {
            let now = Date().timeIntervalSince1970 * 1000
            var list = self.read().filter { now - $0.at < self.keepMs }
            list.append(Entry(at: now, line: line))
            if let data = try? JSONEncoder().encode(Array(list.suffix(5000))) { try? data.write(to: self.url, options: .atomic) }
        }
    }

    func all() -> [[String: Any]] {
        queue.sync { read().map { ["at": $0.at, "line": $0.line] } }
    }
}

enum BoardingStore {
    static let dir: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
}

// core.js in a JSContext: `export` stripped (it is an ES module with no imports), its
// nativeBoardingStep called with JSON text. The text is kept for relaunches without the page.
final class BoardingEngine {
    private var context: JSContext?
    private var step: JSValue?
    private static let urlKey = "boardingCoreURL"
    private var file: URL { BoardingStore.dir.appendingPathComponent("boarding-core.js") }

    var loaded: Bool { step != nil || loadCached() }

    private func loadCached() -> Bool {
        guard let src = try? String(contentsOf: file, encoding: .utf8) else { return false }
        return evaluate(src)
    }

    private func evaluate(_ src: String) -> Bool {
        guard let re = try? NSRegularExpression(pattern: "^export (?=(const|let|function|async function) )", options: [.anchorsMatchLines]),
              let ctx = JSContext() else { return false }
        let stripped = re.stringByReplacingMatches(in: src, range: NSRange(src.startIndex..., in: src), withTemplate: "")
        ctx.exceptionHandler = { _, exc in
            BoardingLog.shared.append("script error: \(exc?.toString() ?? "unknown")")
        }
        ctx.evaluateScript(stripped + "\n;globalThis.__boardingStep = nativeBoardingStep;")
        guard let fn = ctx.objectForKeyedSubscript("__boardingStep"), fn.isObject else {
            BoardingLog.shared.append("core.js did not load")
            return false
        }
        context = ctx
        step = fn
        return true
    }

    // The page's core.js (`CORE_JS`, stamped with its hash): fetched when it changed.
    func load(_ url: String) async {
        if step != nil, UserDefaults.standard.string(forKey: Self.urlKey) == url { return }
        guard let u = URL(string: url) else { return }
        do {
            let (data, res) = try await URLSession.shared.data(from: u)
            guard (res as? HTTPURLResponse)?.statusCode == 200, let src = String(data: data, encoding: .utf8) else { return }
            if evaluate(src) {
                try? data.write(to: file, options: .atomic)
                UserDefaults.standard.set(url, forKey: Self.urlKey)
            }
        } catch {
            BoardingLog.shared.append("core.js not loaded: \(error.localizedDescription)")
        }
    }

    func run(_ input: String) -> String? {
        guard loaded, let out = step?.call(withArguments: [input]), out.isString else { return nil }
        return out.toString()
    }
}

final class BoardingLocation: NSObject, CLLocationManagerDelegate {
    static let shared = BoardingLocation()
    static let settingKey = "boardingOn"
    static let defaultsKey = "boardingDefaults"
    static let changed = Notification.Name("TMinusBoarding") // a new pending action for the page

    private let manager = CLLocationManager()
    private let engine = BoardingEngine()
    private var session: [String: Any]?
    private var regionId: String?
    private var gps = false
    private var queries: [[String: Any]] = []
    private var fetchedAt: [String: Date] = [:]
    private var inFlight = Set<String>()
    private var samples: [[String: Any]] = []
    private var lastSample = Date.distantPast
    private var lastPump = Date.distantPast
    private var timer: Timer?
    private var authWaiters: [(String) -> Void] = []
    private var sessionFile: URL { BoardingStore.dir.appendingPathComponent("boarding-session.json") }

    var on: Bool { UserDefaults.standard.bool(forKey: Self.settingKey) }

    // From launch (also a background relaunch by a geofence event): the delegate first, so the
    // event is delivered here.
    func start() {
        manager.delegate = self
        manager.pausesLocationUpdatesAutomatically = false
        manager.activityType = .otherNavigation
        if let data = try? Data(contentsOf: sessionFile), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            session = obj
        }
        if session != nil { run(["type": "tick"]) }
    }

    // ---------- permission ----------

    var status: String {
        switch manager.authorizationStatus {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied, .restricted: return "denied"
        default: return "notDetermined"
        }
    }

    // Precise Location (iOS Settings → T-Minus → Location → Precise Location).
    var precise: Bool { manager.accuracyAuthorization == .fullAccuracy }

    // While Using first, then Always (iOS asks once for each); resolves when it settles.
    func authorize(_ done: @escaping (String) -> Void) {
        switch manager.authorizationStatus {
        case .notDetermined:
            authWaiters.append(done)
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            authWaiters.append(done)
            manager.requestAlwaysAuthorization()
        default:
            done(status)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.settleAuth() }
    }

    private func settleAuth() {
        let waiters = authWaiters
        authWaiters = []
        for w in waiters { w(status) }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus == .authorizedWhenInUse, !authWaiters.isEmpty, !askedAlways {
            askedAlways = true
            manager.requestAlwaysAuthorization()
            // iOS doesn't call back when the Always prompt is declined: settle after a while.
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.settleAuth() }
            return
        }
        if manager.authorizationStatus != .notDetermined { settleAuth() }
        if session != nil { run(["type": "tick"]) }
    }
    private var askedAlways = false

    // ---------- the page's calls ----------

    func setOn(_ on: Bool, defaults: [String: Any]?) {
        UserDefaults.standard.set(on, forKey: Self.settingKey)
        if let defaults, let data = try? JSONSerialization.data(withJSONObject: defaults) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
        if !on { disarm() }
    }

    func arm(session web: [String: Any], coreUrl: String) async {
        await engine.load(coreUrl)
        await MainActor.run { _ = run(["type": "arm", "session": web]) }
    }

    func disarm() {
        run(["type": "disarm"])
    }

    // The latest action for the page (consumed).
    func takePending() -> [String: Any]? {
        guard let p = session?["pending"] as? [String: Any] else { return nil }
        run(["type": "take"])
        return p
    }

    func undo(_ undoId: String) {
        run(["type": "undo", "undoId": undoId])
    }

    // An auto-bell's leave card started (LiveActivityObserver), maybe with the page closed: armed
    // from the server's bell (POST /api/bells) unless a trip is already armed.
    func leaveCardStarted(id: String, reminderId: String) {
        guard on, manager.authorizationStatus == .authorizedAlways,
              let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
              let defaults = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let subscription = defaults["subscription"] as? [String: Any] else { return }
        if let st = session?["enRoute"] as? [String: Any], st["ride"] != nil || (st["kind"] as? String) != "track" { return }
        Task { @MainActor in
            guard engine.loaded,
                  let res = await post("/bells", ["subscription": subscription]),
                  let bells = res["bells"] as? [[String: Any]],
                  let bell = bells.first(where: { $0["id"] as? String == reminderId }) else { return }
            run(["type": "bell", "bell": bell, "defaults": defaults, "card": ["id": id, "kind": "leave"]])
        }
    }

    // ---------- the engine ----------

    @discardableResult
    private func run(_ event: [String: Any]) -> Bool {
        if session == nil, !["arm", "bell"].contains(event["type"] as? String ?? "") { return false }
        // A leave card's token comes from iOS after its start (LiveActivityObserver keeps it).
        if var card = session?["card"] as? [String: Any], card["token"] == nil || card["token"] is NSNull,
           let id = card["id"] as? String, let token = LiveActivityObserver.token(id) {
            card["token"] = token
            session?["card"] = card
        }
        let input: [String: Any] = [
            "session": session ?? NSNull(), "event": event, "nowMs": Date().timeIntervalSince1970 * 1000,
            "active": UIApplication.shared.applicationState == .active,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: input), let text = String(data: data, encoding: .utf8),
              let out = engine.run(text), let outData = out.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: outData) as? [String: Any] else { return false }
        session = obj["session"] as? [String: Any]
        if let session, let data = try? JSONSerialization.data(withJSONObject: session) { try? data.write(to: sessionFile, options: .atomic) } else { try? FileManager.default.removeItem(at: sessionFile) }
        for a in obj["actions"] as? [[String: Any]] ?? [] { perform(a) }
        reconcile(obj["wants"] as? [String: Any] ?? [:])
        return true
    }

    private func perform(_ a: [String: Any]) {
        switch a["type"] as? String {
        case "log":
            BoardingLog.shared.append(a["line"] as? String ?? "")
        case "state":
            NotificationCenter.default.post(name: Self.changed, object: nil)
        case "http":
            let method = a["method"] as? String ?? "GET"
            let path = a["path"] as? String ?? ""
            let then = a["then"] as? String
            Task { @MainActor in
                let res = await request(method, path, a["body"] as? [String: Any])
                if then == "ride", let id = res?["id"] as? String { run(["type": "posted", "id": id]) }
            }
        case "card":
            guard let id = a["id"] as? String, let act = Activity<RideAttributes>.activities.first(where: { $0.id == id }) else { return }
            if a["end"] as? Bool == true {
                LiveActivityObserver.shared.endedByApp(id)
                Task { await act.end(nil, dismissalPolicy: .immediate) }
            } else if let obj = a["state"], let data = try? JSONSerialization.data(withJSONObject: obj),
                      let state = try? JSONDecoder().decode(RideState.self, from: data) {
                // No AlertConfiguration: a quiet update.
                Task { await act.update(ActivityContent(state: state, staleDate: state.staleDate)) }
            }
        default:
            break
        }
    }

    private func reconcile(_ wants: [String: Any]) {
        // The geofence (Always only): one region at a time.
        let region = wants["region"] as? [String: Any]
        let id = region?["id"] as? String
        for r in manager.monitoredRegions where r.identifier.hasPrefix("tminus-stop-") && (r.identifier != id || manager.authorizationStatus != .authorizedAlways) {
            manager.stopMonitoring(for: r)
        }
        regionId = nil
        if let region, let id, manager.authorizationStatus == .authorizedAlways,
           let lat = region["lat"] as? Double, let lon = region["lon"] as? Double, let radius = region["radius"] as? Double {
            regionId = id
            let current = manager.monitoredRegions.first { $0.identifier == id } as? CLCircularRegion
            if current == nil || current?.center.latitude != lat || current?.center.longitude != lon {
                let r = CLCircularRegion(center: CLLocationCoordinate2D(latitude: lat, longitude: lon), radius: radius, identifier: id)
                r.notifyOnEntry = true
                r.notifyOnExit = true
                manager.startMonitoring(for: r)
                manager.requestState(for: r)
            }
        }
        // GPS: high accuracy, in the background too (the blue indicator shows).
        let allowed: [CLAuthorizationStatus] = [.authorizedAlways, .authorizedWhenInUse]
        let wantGps = (wants["gps"] as? Bool ?? false) && allowed.contains(manager.authorizationStatus)
        if wantGps != gps {
            gps = wantGps
            if wantGps {
                manager.desiredAccuracy = kCLLocationAccuracyBest
                manager.distanceFilter = kCLDistanceFilterNone
                manager.allowsBackgroundLocationUpdates = true
                manager.showsBackgroundLocationIndicator = true
                manager.startUpdatingLocation()
            } else {
                manager.stopUpdatingLocation()
                manager.allowsBackgroundLocationUpdates = false
            }
            BoardingLog.shared.append(wantGps ? "GPS on" : "GPS off")
        }
        queries = wants["queries"] as? [[String: Any]] ?? []
        if queries.isEmpty {
            timer?.invalidate()
            timer = nil
        } else if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.pump() }
        }
        pump()
    }

    // Fixes to the engine (at most every 5 s), and the queries that are due.
    private func pump() {
        let now = Date()
        if !samples.isEmpty, now.timeIntervalSince(lastPump) >= 5 {
            lastPump = now
            let batch = samples
            samples = []
            run(["type": "location", "samples": batch])
        }
        for q in queries {
            guard let key = q["key"] as? String, !inFlight.contains(key) else { continue }
            let every = (q["every"] as? Double ?? 60_000) / 1000
            if let at = fetchedAt[key], now.timeIntervalSince(at) < every { continue }
            inFlight.insert(key)
            fetchedAt[key] = now
            Task { @MainActor in
                defer { inFlight.remove(key) }
                guard let doc = await mbta(q["path"] as? String ?? "", q["params"] as? [String: Any] ?? [:]) else { return }
                run(["type": "doc", "key": key, "doc": doc])
            }
        }
    }

    // ---------- CLLocationManagerDelegate ----------

    func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        guard region.identifier == regionId, state != .unknown else { return }
        run(["type": "geofence", "inside": state == .inside])
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for loc in locations where loc.horizontalAccuracy >= 0 && loc.timestamp.timeIntervalSince(lastSample) >= 2 {
            lastSample = loc.timestamp
            samples.append(["t": loc.timestamp.timeIntervalSince1970 * 1000, "lat": loc.coordinate.latitude,
                            "lon": loc.coordinate.longitude, "acc": loc.horizontalAccuracy])
        }
        // In the background the app runs on location updates: the timer may not fire.
        if Date().timeIntervalSince(lastPump) >= 5 { pump() }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        BoardingLog.shared.append("location error: \(error.localizedDescription)")
    }

    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        BoardingLog.shared.append("geofence error: \(error.localizedDescription)")
    }

    // ---------- requests (no coordinates in any of them) ----------

    private func mbta(_ path: String, _ params: [String: Any]) async -> [String: Any]? {
        guard var c = URLComponents(string: "\(LiveActivityObserver.baseURL)/api/mbta\(path)") else { return nil }
        c.queryItems = params.keys.sorted().map { URLQueryItem(name: $0, value: "\(params[$0] ?? "")") }
        guard let url = c.url else { return nil }
        do {
            let (data, res) = try await URLSession.shared.data(from: url)
            guard (res as? HTTPURLResponse)?.statusCode == 200 else {
                BoardingLog.shared.append("\(path): \((res as? HTTPURLResponse)?.statusCode ?? 0)")
                return nil
            }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            BoardingLog.shared.append("\(path): \(error.localizedDescription)")
            return nil
        }
    }

    private func post(_ path: String, _ body: [String: Any]) async -> [String: Any]? {
        await request("POST", path, body)
    }

    // The server (`/api…`), retried twice on a network error or a 5xx, in a background task.
    @MainActor private func request(_ method: String, _ path: String, _ body: [String: Any]?) async -> [String: Any]? {
        guard let url = URL(string: "\(LiveActivityObserver.baseURL)/api\(path)") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        let task = UIApplication.shared.beginBackgroundTask(withName: "boarding \(method)", expirationHandler: nil)
        defer { UIApplication.shared.endBackgroundTask(task) }
        for attempt in 0..<3 {
            if attempt > 0 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
            do {
                let (data, res) = try await URLSession.shared.data(for: req)
                let status = (res as? HTTPURLResponse)?.statusCode ?? 0
                if status >= 500 { continue }
                BoardingLog.shared.append("\(method) \(path.split(separator: "?").first ?? ""): \(status)")
                return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            } catch {
                continue
            }
        }
        BoardingLog.shared.append("\(method) \(path.split(separator: "?").first ?? ""): failed")
        return nil
    }
}
