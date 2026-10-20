import ActivityKit
import Capacitor
import UIKit

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
    ]

    // keepAwake({ on }): keeps the screen on while a ride is tracked (the PWA's Wake Lock).
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
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

    // liveActivityStart({ tripName, state }) → { id }: one activity at a time (others end). Its
    // push token (hex) comes as the `activityToken` event { id, token }, again when iOS changes it.
    @objc func liveActivityStart(_ call: CAPPluginCall) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return call.reject("Live Activities are off for this app") }
        guard let state = rideState(call) else { return call.reject("state is invalid") }
        let attributes = RideAttributes(tripName: call.getString("tripName") ?? "")
        Task {
            for old in Activity<RideAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) }
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

    // liveActivityEnd({ id }): removed at once (Done, Cancel, a replaced ride). A missing one is fine.
    @objc func liveActivityEnd(_ call: CAPPluginCall) {
        guard let act = activity(call.getString("id")) else { return call.resolve() }
        Task {
            await act.end(nil, dismissalPolicy: .immediate)
            call.resolve()
        }
    }
}
