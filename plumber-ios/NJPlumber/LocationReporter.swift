import CoreLocation
import Foundation
import UIKit

extension Notification.Name {
  static let njShiftClosed = Notification.Name("njShiftClosed")
}

final class LocationReporter: NSObject, CLLocationManagerDelegate {
  static let shared = LocationReporter()

  private let manager = CLLocationManager()
  private let pingURL = URL(string: "https://us-central1-nj-plumbing.cloudfunctions.net/ingestTimePing")!
  private var lastSentAt: Date = .distantPast
  private var lastSentCoord: CLLocationCoordinate2D?
  private var oneShot: CheckedContinuation<CLLocation, Error>?
  private var oneShotFailWork: DispatchWorkItem?
  private var oneShotConsumed = false

  private let defaults = UserDefaults.standard
  private let shiftKey = "njShiftId"
  private let plumberKey = "njPlumberId"
  private let deviceKey = "njDeviceId"

  enum LocationError: LocalizedError {
    case denied
    case timeout
    case unavailable

    var errorDescription: String? {
      switch self {
      case .denied:
        return "Turn on location for NJ Plumber (Always) in Settings."
      case .timeout:
        return "Could not get GPS. Step outside and try again."
      case .unavailable:
        return "Location is not available on this phone."
      }
    }
  }

  private override init() {
    super.init()
    manager.delegate = self
    manager.allowsBackgroundLocationUpdates = true
    manager.pausesLocationUpdatesAutomatically = false
    manager.showsBackgroundLocationIndicator = true
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    manager.distanceFilter = 150
    if defaults.string(forKey: deviceKey) == nil {
      defaults.set(UUID().uuidString, forKey: deviceKey)
    }
  }

  func deviceId() -> String {
    defaults.string(forKey: deviceKey) ?? UUID().uuidString
  }

  func savedPlumberId() -> String {
    defaults.string(forKey: plumberKey) ?? ""
  }

  func savePlumberId(_ id: String) {
    defaults.set(id, forKey: plumberKey)
  }

  func activeShiftId() -> String? {
    let value = defaults.string(forKey: shiftKey) ?? ""
    return value.isEmpty ? nil : value
  }

  func bootstrap() {
    if activeShiftId() != nil {
      start()
    }
  }

  func resumeIfClockedIn() {
    if activeShiftId() != nil {
      start()
    }
  }

  func requestPermission() {
    manager.requestAlwaysAuthorization()
  }

  func currentLocation() async throws -> CLLocation {
    if !CLLocationManager.locationServicesEnabled() {
      throw LocationError.unavailable
    }
    requestPermission()
    let status = manager.authorizationStatus
    if status == .denied || status == .restricted {
      throw LocationError.denied
    }
    if let cached = manager.location, cached.timestamp.timeIntervalSinceNow > -90 {
      return cached
    }
    return try await withCheckedThrowingContinuation { continuation in
      failOneShot(LocationError.timeout)
      oneShotConsumed = false
      oneShot = continuation
      let work = DispatchWorkItem { [weak self] in
        self?.failOneShot(LocationError.timeout)
      }
      oneShotFailWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
      manager.requestLocation()
    }
  }

  func clockIn(plumberId: String, shiftId: String, deviceId: String) {
    defaults.set(plumberId, forKey: plumberKey)
    defaults.set(shiftId, forKey: shiftKey)
    if !deviceId.isEmpty {
      defaults.set(deviceId, forKey: deviceKey)
    }
    requestPermission()
    start()
  }

  func clockOut() {
    let wasOpen = activeShiftId() != nil
    defaults.removeObject(forKey: shiftKey)
    manager.stopUpdatingLocation()
    manager.stopMonitoringSignificantLocationChanges()
    if wasOpen {
      NotificationCenter.default.post(name: .njShiftClosed, object: nil)
    }
  }

  private func start() {
    manager.startUpdatingLocation()
    manager.startMonitoringSignificantLocationChanges()
    if let location = manager.location {
      send(location, force: true)
    }
  }

  private func failOneShot(_ error: Error?) {
    oneShotFailWork?.cancel()
    oneShotFailWork = nil
    guard !oneShotConsumed, let pending = oneShot else { return }
    oneShotConsumed = true
    oneShot = nil
    pending.resume(throwing: error ?? LocationError.timeout)
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if manager.authorizationStatus == .authorizedAlways ||
        manager.authorizationStatus == .authorizedWhenInUse {
      if activeShiftId() != nil {
        start()
      }
    } else if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
      failOneShot(LocationError.denied)
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last else { return }
    if let pending = oneShot, !oneShotConsumed {
      oneShotFailWork?.cancel()
      oneShotFailWork = nil
      oneShotConsumed = true
      oneShot = nil
      pending.resume(returning: location)
    }
    send(location, force: false)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    NSLog("NJPlumber location error: %@", error.localizedDescription)
    if oneShot != nil {
      failOneShot(LocationError.unavailable)
    }
  }

  private func send(_ location: CLLocation, force: Bool) {
    guard let shiftId = activeShiftId() else { return }
    let now = Date()
    if !force, now.timeIntervalSince(lastSentAt) < 75 {
      if let previous = lastSentCoord {
        let from = CLLocation(latitude: previous.latitude, longitude: previous.longitude)
        if location.distance(from: from) < 120 {
          return
        }
      }
    }
    lastSentAt = now
    lastSentCoord = location.coordinate

    var request = URLRequest(url: pingURL)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let body: [String: Any] = [
      "shiftId": shiftId,
      "plumberId": defaults.string(forKey: plumberKey) ?? "",
      "deviceId": deviceId(),
      "lat": location.coordinate.latitude,
      "lng": location.coordinate.longitude,
      "accuracy": location.horizontalAccuracy,
      "at": ISO8601DateFormatter().string(from: location.timestamp),
      "source": "ios",
    ]
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    URLSession.shared.dataTask(with: request) { data, _, _ in
      guard let data,
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            (json["closed"] as? Bool) == true else { return }
      DispatchQueue.main.async {
        self.clockOut()
      }
    }.resume()
  }
}
