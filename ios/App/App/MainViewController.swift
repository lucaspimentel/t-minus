import UIKit
import Capacitor

// The app's bridge view controller: registers the plugins that live in this target.
class MainViewController: CAPBridgeViewController {
    // The server this bridge loaded (ServerSwitch): SceneDelegate replaces the controller when
    // the setting no longer matches.
    private(set) var loadedStaging = false

    // Staging (ServerSwitch): the WebView loads the staging host as the app's own server, so the
    // bridge and its plugins work there as on production.
    override open func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        loadedStaging = ServerSwitch.staging
        if loadedStaging { descriptor.serverURL = ServerSwitch.stagingURL }
        return descriptor
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(TMinusPlugin())
        Observability.shared.track(webView: webView)
    }
}
