import ActivityKit
import Capacitor
import UIKit
import WidgetKit

// window.Capacitor.Plugins.TMinus: native calls the web app makes (index.html, `native`).
@objc(TMinusPlugin)
public class TMinusPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TMinusPlugin"
    public let jsName = "TMinus"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveActivityStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveActivityUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveActivityEnd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveActivityStartToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveActivityList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "liveActivityDismissed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "widgetSave", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "locationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "locationAuthorize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "boardingSetting", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "boardingArm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "boardingDisarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "boardingPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "boardingUndo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "boardingLog", returnType: CAPPluginReturnPromise),
    ]

    private var startTokenObserver: NSObjectProtocol?
    private var answerObserver: NSObjectProtocol?
    private var boardingObserver: NSObjectProtocol?

    // ---------- "Did you get on?" from the card or the widget (RideState.answerURL) ----------

    static let answerOpened = Notification.Name("TMinusAnswerOpened")
    // An answer opened before the plugin loaded (a cold start), sent once it has.
    private static var pendingAnswer: [String: Any]?

    // `tminus://answer?a=yes|missed&dep=<s>` (SceneDelegate): the `answer` event { answer, dep }.
    static func open(_ url: URL) {
        guard url.scheme == "tminus", url.host == "answer",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let a = items.first(where: { $0.name == "a" })?.value,
              let dep = items.first(where: { $0.name == "dep" })?.value.flatMap(Double.init) else { return }
        pendingAnswer = ["answer": a, "dep": dep]
        NotificationCenter.default.post(name: answerOpened, object: nil)
    }

    private func sendPendingAnswer() {
        guard let data = Self.pendingAnswer else { return }
        Self.pendingAnswer = nil
        notifyListeners("answer", data: data, retainUntilConsumed: true)
    }

    override public func load() {
        // iOS changed the push-to-start token (LiveActivityObserver): the `startToken` event { token }.
        startTokenObserver = NotificationCenter.default.addObserver(forName: LiveActivityObserver.startTokenChanged, object: nil, queue: .main) { [weak self] note in
            guard let token = note.object as? String else { return }
            self?.notifyListeners("startToken", data: ["token": token], retainUntilConsumed: true)
        }
        answerObserver = NotificationCenter.default.addObserver(forName: Self.answerOpened, object: nil, queue: .main) { [weak self] _ in
            self?.sendPendingAnswer()
        }
        sendPendingAnswer()
        // Boarding from location decided something (BoardingLocation): the page takes it with
        // boardingPending.
        boardingObserver = NotificationCenter.default.addObserver(forName: BoardingLocation.changed, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("boarding", data: [:], retainUntilConsumed: true)
        }
    }

    // ---------- boarding from location (BoardingLocation, DESIGN.md) ----------

    // locationStatus() → { status: 'notDetermined' | 'whenInUse' | 'always' | 'denied' }
    @objc func locationStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["status": BoardingLocation.shared.status]) }
    }

    // locationAuthorize() → { status }: asks for While Using, then Always.
    @objc func locationAuthorize(_ call: CAPPluginCall) {
        DispatchQueue.main.async { BoardingLocation.shared.authorize { call.resolve(["status": $0]) } }
    }

    // boardingSetting({ on, defaults }): the Settings toggle, and what an auto-bell needs to arm
    // with the page closed ({ trips, subscription, slack, alerts }). Off disarms.
    @objc func boardingSetting(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        let defaults = call.getObject("defaults").map { $0 as [String: Any] }
        DispatchQueue.main.async {
            BoardingLocation.shared.setOn(on, defaults: defaults)
            call.resolve()
        }
    }

    // boardingArm({ session, coreUrl }): the trip to follow (core.js boardingSession).
    @objc func boardingArm(_ call: CAPPluginCall) {
        guard let session = call.getObject("session"), let coreUrl = call.getString("coreUrl") else { return call.reject("session is missing") }
        let web = session as [String: Any]
        Task {
            await BoardingLocation.shared.arm(session: web, coreUrl: coreUrl)
            call.resolve()
        }
    }

    @objc func boardingDisarm(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            BoardingLocation.shared.disarm()
            call.resolve()
        }
    }

    // boardingPending() → { action: { undoId, toast, at, state, base, from } | null }, taken.
    @objc func boardingPending(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["action": BoardingLocation.shared.takePending() ?? NSNull()]) }
    }

    @objc func boardingUndo(_ call: CAPPluginCall) {
        guard let id = call.getString("undoId") else { return call.reject("undoId is missing") }
        DispatchQueue.main.async {
            BoardingLocation.shared.undo(id)
            call.resolve()
        }
    }

    // boardingLog() → { lines: [{ at, line }] }: the on-device log, oldest first.
    @objc func boardingLog(_ call: CAPPluginCall) {
        call.resolve(["lines": BoardingLog.shared.all()])
    }

    // keepAwake({ on }): keeps the screen on while a ride is tracked (the PWA's Wake Lock).
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }

    // widgetSave({ body }): the leave-times widget's request (JSON text; widgetRequest in core.js)
    // to the shared keychain, then a reload (the app is in the foreground: not counted against
    // iOS's widget budget).
    @objc func widgetSave(_ call: CAPPluginCall) {
        guard let body = call.getString("body") else { return call.reject("body is missing") }
        let status = WidgetStore.saveRequest(body)
        guard status == errSecSuccess else { return call.reject("keychain: \(status)") }
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetStore.kind)
        call.resolve()
    }

    // ---------- Live Activity (the tracked ride on the Lock Screen; IOS.md) ----------

    private func rideState(_ call: CAPPluginCall) -> RideState? {
        guard let obj = call.getObject("state"),
              let data = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        return try? JSONDecoder().decode(RideState.self, from: data)
    }

    private func activity(_ id: String?) -> Activity<RideAttributes>? {
        Activity<RideAttributes>.activities.first { $0.id == id }
    }

    // liveActivityStart({ tripName, state }) → { id }: one ride card at a time (other ride cards
    // end; leave cards stay until the web app ends them). Its
    // push token (hex) comes as the `activityToken` event { id, token }, again when iOS changes it.
    @objc func liveActivityStart(_ call: CAPPluginCall) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return call.reject("Live Activities are off for this app") }
        guard let state = rideState(call) else { return call.reject("state is invalid") }
        let attributes = RideAttributes(tripName: call.getString("tripName") ?? "")
        Task {
            for old in Activity<RideAttributes>.activities where old.attributes.reminderId == nil {
                LiveActivityObserver.shared.endedByApp(old.id)
                await old.end(nil, dismissalPolicy: .immediate)
            }
            do {
                let act = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: state.staleDate), pushType: .token)
                LiveActivityObserver.shared.observe(act)
                call.resolve(["id": act.id])
                Task {
                    for await data in act.pushTokenUpdates {
                        let token = data.map { String(format: "%02x", $0) }.joined()
                        self.notifyListeners("activityToken", data: ["id": act.id, "token": token], retainUntilConsumed: true)
                    }
                }
            } catch {
                Observability.addError(error, ["step": "liveActivityStart"])
                call.reject("start: \(error.localizedDescription)")
            }
        }
    }

    // liveActivityUpdate({ id, state })
    @objc func liveActivityUpdate(_ call: CAPPluginCall) {
        guard let state = rideState(call) else { return call.reject("state is invalid") }
        guard let act = activity(call.getString("id")) else { return call.reject("no such activity") }
        Task {
            await act.update(ActivityContent(state: state, staleDate: state.staleDate))
            call.resolve()
        }
    }

    // liveActivityStartToken() → { token }: the push-to-start token (hex) sent with reminders, or
    // null until iOS gives one.
    @objc func liveActivityStartToken(_ call: CAPPluginCall) {
        call.resolve(["token": UserDefaults.standard.string(forKey: LiveActivityObserver.startTokenKey) ?? NSNull()])
    }

    // liveActivityList() → { activities: [{ id, reminderId, tripName }] }: the cards on screen
    // (reminderId: a leave card the server started; null for a ride card).
    @objc func liveActivityList(_ call: CAPPluginCall) {
        let list: [[String: Any]] = Activity<RideAttributes>.activities.map {
            ["id": $0.id, "reminderId": $0.attributes.reminderId ?? NSNull(), "tripName": $0.attributes.tripName]
        }
        call.resolve(["activities": list])
    }

    // liveActivityDismissed() → { activities: [{ id, reminderId }] }: cards dismissed without the
    // app ending them (swiped away), oldest first; a leave card's goes once a new one starts.
    @objc func liveActivityDismissed(_ call: CAPPluginCall) {
        let list: [[String: Any]] = LiveActivityObserver.dismissed().map { e in
            let reminderId: Any = e["reminderId"].map { $0 as Any } ?? NSNull()
            return ["id": e["id"] ?? "", "reminderId": reminderId]
        }
        call.resolve(["activities": list])
    }

    // liveActivityEnd({ id }): removed at once (Done, Cancel, a replaced ride). A missing one is fine.
    @objc func liveActivityEnd(_ call: CAPPluginCall) {
        guard let act = activity(call.getString("id")) else { return call.resolve() }
        LiveActivityObserver.shared.endedByApp(act.id)
        Task {
            await act.end(nil, dismissalPolicy: .immediate)
            call.resolve()
        }
    }
}
