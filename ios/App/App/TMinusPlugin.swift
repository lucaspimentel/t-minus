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
        CAPPluginMethod(name: "widgetSave", returnType: CAPPluginReturnPromise),
    ]

    private var startTokenObserver: NSObjectProtocol?
    private var answerObserver: NSObjectProtocol?

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
            for old in Activity<RideAttributes>.activities where old.attributes.reminderId == nil { await old.end(nil, dismissalPolicy: .immediate) }
            do {
                let act = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: state.staleDate), pushType: .token)
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

    // liveActivityEnd({ id }): removed at once (Done, Cancel, a replaced ride). A missing one is fine.
    @objc func liveActivityEnd(_ call: CAPPluginCall) {
        guard let act = activity(call.getString("id")) else { return call.resolve() }
        Task {
            await act.end(nil, dismissalPolicy: .immediate)
            call.resolve()
        }
    }
}
