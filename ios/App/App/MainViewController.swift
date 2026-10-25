import UIKit
import Capacitor

// The app's bridge view controller: registers the plugins that live in this target.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(TMinusPlugin())
        Observability.shared.track(webView: webView)
    }
}
