import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        Observability.shared.start() // Datadog RUM, before any native request
        LiveActivityObserver.shared.start() // also in a background launch after a leave card's start
        // The boarding question's actions (the server's `board` pushes): both open the app, which
        // gets the action from the PushNotifications plugin (`pushNotificationActionPerformed`).
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "board", actions: [
                UNNotificationAction(identifier: "yes", title: "Yes", options: [.foreground]),
                UNNotificationAction(identifier: "missed", title: "Missed it", options: [.foreground]),
            ], intentIdentifiers: [])
        ])
        return true
    }

    // APNs registration → the PushNotifications plugin (its `registration` / `registrationError` events).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
        Observability.addError(error, ["step": "apns registration"])
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
