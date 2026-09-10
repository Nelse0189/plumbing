import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    LocationReporter.shared.bootstrap()
    if launchOptions?[.location] != nil {
      LocationReporter.shared.resumeIfClockedIn()
    }
    return true
  }
}
