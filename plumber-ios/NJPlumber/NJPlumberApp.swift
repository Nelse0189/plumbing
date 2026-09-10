import SwiftUI

@main
struct NJPlumberApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

  var body: some Scene {
    WindowGroup {
      PlumberHomeView()
    }
  }
}
