import DatadogCore
import DatadogCrashReporting
import DatadogRUM
import DatadogWebViewTracking
import Foundation
import WebKit

// Native Datadog RUM (DESIGN.md "Observability"): crash reporting, the web view's events (the
// page's browser SDK forwards them over the bridge), and native requests to the site with trace
// headers. The IDs come from /api/config's rum.ios, cached in UserDefaults: a cached pair starts
// RUM at launch; the first launch starts it after the fetch (the page already on screen stays
// web-only until it reloads); `ios` null clears the cache (off from the next launch); a failed
// fetch keeps it. Background launches send no RUM events (trackBackgroundEvents off).
final class Observability {
    static let shared = Observability()
    private static let idsKey = "datadogRumIOS"
    private struct IDs: Codable, Equatable { let applicationId: String; let clientToken: String }

    private weak var webView: WKWebView?
    private let host = URL(string: LiveActivityObserver.baseURL)?.host ?? "t-minus.lucasp.net"

    // At launch, on the main thread.
    func start() {
        if let ids = cachedIDs() { initialize(ids) }
        fetchIDs()
    }

    // From the bridge view controller, before the first page load.
    func track(webView: WKWebView?) {
        self.webView = webView
        enableWebViewTracking()
    }

    private func cachedIDs() -> IDs? {
        guard let data = UserDefaults.standard.data(forKey: Self.idsKey) else { return nil }
        return try? JSONDecoder().decode(IDs.self, from: data)
    }

    // Once per process: a changed pair applies from the next launch.
    private func initialize(_ ids: IDs) {
        guard !Datadog.isInitialized() else { return }
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        Datadog.initialize(
            with: Datadog.Configuration(clientToken: ids.clientToken, env: "prod", site: .us1,
                                        service: "t-minus-ios", version: "\(short)-\(build)"),
            trackingConsent: .granted
        )
        RUM.enable(with: RUM.Configuration(
            applicationID: ids.applicationId,
            sessionSampleRate: 100,
            uiKitViewsPredicate: nil,
            uiKitActionsPredicate: nil,
            urlSessionTracking: .init(firstPartyHostsTracing: .trace(hosts: [host])),
            trackBackgroundEvents: false
        ))
        CrashReporting.enable()
        enableWebViewTracking()
    }

    private func enableWebViewTracking() {
        guard Datadog.isInitialized(), let webView else { return }
        WebViewTracking.enable(webView: webView, hosts: [host])
    }

    private func fetchIDs() {
        guard let url = URL(string: "\(LiveActivityObserver.baseURL)/api/config") else { return }
        let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        URLSession.shared.dataTask(with: req) { data, res, _ in
            guard (res as? HTTPURLResponse)?.statusCode == 200, let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rum = json["rum"] as? [String: Any] else { return } // keep the cache
            let ios = rum["ios"] as? [String: Any]
            let ids: IDs? = {
                guard let id = ios?["applicationId"] as? String, !id.isEmpty,
                      let token = ios?["clientToken"] as? String, !token.isEmpty else { return nil }
                return IDs(applicationId: id, clientToken: token)
            }()
            DispatchQueue.main.async {
                guard let ids else { return UserDefaults.standard.removeObject(forKey: Self.idsKey) }
                UserDefaults.standard.set(try? JSONEncoder().encode(ids), forKey: Self.idsKey)
                self.initialize(ids)
            }
        }.resume()
    }

    // Errors the native code already catches; no-ops while RUM is off.
    static func addError(_ error: Error, _ attributes: [String: Encodable] = [:]) {
        guard Datadog.isInitialized() else { return }
        RUMMonitor.shared().addError(error: error, source: .source, attributes: attributes)
    }

    static func addError(message: String, type: String, attributes: [String: Encodable] = [:]) {
        guard Datadog.isInitialized() else { return }
        RUMMonitor.shared().addError(message: message, type: type, source: .network, attributes: attributes)
    }
}
