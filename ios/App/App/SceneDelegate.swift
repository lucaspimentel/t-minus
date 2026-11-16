import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        connectionOptions.urlContexts.forEach { TMinusPlugin.open($0.url) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
        URLContexts.forEach { TMinusPlugin.open($0.url) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // Back in the foreground: the server switch (ServerSwitch) may have changed in iOS Settings, or
    // staging's 2 h ended.
    func sceneWillEnterForeground(_ scene: UIScene) {
        reloadIfServerChanged()
    }

    // A new bridge on the wanted server (production or staging) when it isn't the loaded one.
    func reloadIfServerChanged() {
        guard let vc = window?.rootViewController as? MainViewController, vc.loadedStaging != ServerSwitch.staging else { return }
        window?.rootViewController = MainViewController()
    }

    static var current: SceneDelegate? {
        UIApplication.shared.connectedScenes.lazy.compactMap { $0.delegate as? SceneDelegate }.first
    }
}
