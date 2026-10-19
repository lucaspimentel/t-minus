import UIKit
import Capacitor

// window.Capacitor.Plugins.TMinus: native calls the web app makes (index.html, `native`).
@objc(TMinusPlugin)
public class TMinusPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TMinusPlugin"
    public let jsName = "TMinus"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise)
    ]

    // keepAwake({ on }): keeps the screen on while a ride is tracked (the PWA's Wake Lock).
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }
}
