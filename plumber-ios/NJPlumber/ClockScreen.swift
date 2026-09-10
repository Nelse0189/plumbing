import Combine
import SwiftUI

@MainActor
final class ClockStore: ObservableObject {
  @Published var plumbers: [TimePlumber] = []
  @Published var plumberId = ""
  @Published var shift: TimeShiftPayload?
  @Published var busy = false
  @Published var error = ""
  @Published var now = Date()

  private var timer: AnyCancellable?
  private var closedWatch: AnyCancellable?

  var selected: TimePlumber? {
    plumbers.first { $0.id == plumberId }
  }

  var onClock: Bool {
    shift?.status == "open"
  }

  func start() {
    if plumberId.isEmpty {
      plumberId = LocationReporter.shared.savedPlumberId()
    }
    closedWatch = NotificationCenter.default.publisher(for: .njShiftClosed)
      .receive(on: RunLoop.main)
      .sink { [weak self] _ in
        self?.shift = nil
      }
    timer = Timer.publish(every: 30, on: .main, in: .common)
      .autoconnect()
      .sink { [weak self] date in
        self?.now = date
      }
    Task { await refresh() }
  }

  func stop() {
    timer?.cancel()
    closedWatch?.cancel()
  }

  func pick(_ id: String) {
    plumberId = id
    LocationReporter.shared.savePlumberId(id)
    error = ""
    Task { await refresh() }
  }

  func refresh() async {
    do {
      let result = try await TimeClockAPI.roster(plumberId: plumberId)
      if let people = result.plumbers {
        plumbers = people
      }
      shift = result.shift
      if let open = result.shift, open.status == "open" {
        LocationReporter.shared.clockIn(
          plumberId: open.plumberId,
          shiftId: open.id,
          deviceId: LocationReporter.shared.deviceId()
        )
      }
      error = result.error ?? ""
    } catch {
      self.error = error.localizedDescription
    }
  }

  func clockIn() async {
    guard let person = selected else {
      error = "Pick your name first."
      return
    }
    busy = true
    error = ""
    defer { busy = false }
    do {
      LocationReporter.shared.requestPermission()
      let location = try await LocationReporter.shared.currentLocation()
      let result = try await TimeClockAPI.clock(
        action: "in",
        plumberId: person.id,
        shiftId: "",
        deviceId: LocationReporter.shared.deviceId(),
        lat: location.coordinate.latitude,
        lng: location.coordinate.longitude,
        accuracy: location.horizontalAccuracy
      )
      if let message = result.error, !message.isEmpty {
        error = message
        return
      }
      guard let open = result.shift else {
        error = "Clock in did not start a shift."
        return
      }
      shift = open
      LocationReporter.shared.clockIn(
        plumberId: person.id,
        shiftId: open.id,
        deviceId: LocationReporter.shared.deviceId()
      )
    } catch {
      self.error = error.localizedDescription
    }
  }

  func clockOut() async {
    guard let open = shift else { return }
    busy = true
    error = ""
    defer { busy = false }
    do {
      let location = try? await LocationReporter.shared.currentLocation()
      let result = try await TimeClockAPI.clock(
        action: "out",
        plumberId: plumberId,
        shiftId: open.id,
        deviceId: LocationReporter.shared.deviceId(),
        lat: location?.coordinate.latitude,
        lng: location?.coordinate.longitude,
        accuracy: location?.horizontalAccuracy
      )
      if let message = result.error, !message.isEmpty {
        error = message
        return
      }
      shift = nil
      LocationReporter.shared.clockOut()
    } catch {
      self.error = error.localizedDescription
    }
  }

  func hoursLabel() -> String {
    guard let open = shift, let start = TimeClockFormat.date(open.clockInAt) else {
      return selected == nil ? "Select your name, then clock in." : "Not clocked in."
    }
    let hours = max(0, now.timeIntervalSince(start) / 3600)
    let rounded = (hours * 10).rounded() / 10
    return "On the clock since \(TimeClockFormat.time(start)) · \(rounded) hr"
  }
}

enum TimeClockFormat {
  static let eastern: TimeZone = TimeZone(identifier: "America/New_York") ?? .current

  static func date(_ iso: String) -> Date? {
    let withFrac = ISO8601DateFormatter()
    withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFrac.date(from: iso) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: iso)
  }

  static func time(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.timeZone = eastern
    formatter.dateFormat = "h:mm a"
    return formatter.string(from: date)
  }
}

struct ClockBar: View {
  @ObservedObject var store: ClockStore

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .bottom, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Who are you")
            .font(.caption)
            .foregroundStyle(Color(white: 0.7))
          Picker("Who are you", selection: Binding(
            get: { store.plumberId },
            set: { store.pick($0) }
          )) {
            Text("Select your name").tag("")
            ForEach(store.plumbers) { person in
              Text(person.name).tag(person.id)
            }
          }
          .pickerStyle(.menu)
          .tint(.white)
        }
        Spacer(minLength: 8)
        if store.onClock {
          Button {
            Task { await store.clockOut() }
          } label: {
            Text(store.busy ? "Saving…" : "Clock out")
              .fontWeight(.semibold)
              .padding(.horizontal, 14)
              .padding(.vertical, 10)
          }
          .buttonStyle(.borderedProminent)
          .tint(Color(red: 0.79, green: 0.28, blue: 0.33))
          .disabled(store.busy)
        } else {
          Button {
            Task { await store.clockIn() }
          } label: {
            Text(store.busy ? "Starting…" : "Clock in")
              .fontWeight(.semibold)
              .padding(.horizontal, 14)
              .padding(.vertical, 10)
          }
          .buttonStyle(.borderedProminent)
          .tint(Color(red: 0.49, green: 0.67, blue: 0.57))
          .disabled(store.busy || store.selected == nil)
        }
      }
      Text(store.hoursLabel())
        .font(.subheadline)
      Text("Location stays on after you lock the phone. If you forget to clock out, the shop closes you when you get back to 216 Christian Lane.")
        .font(.caption)
        .foregroundStyle(Color(white: 0.65))
      if !store.error.isEmpty {
        Text(store.error)
          .font(.caption)
          .foregroundStyle(Color(red: 1, green: 0.71, blue: 0.71))
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(red: 0.16, green: 0.17, blue: 0.18))
    .onAppear { store.start() }
    .onDisappear { store.stop() }
  }
}

struct PlumberHomeView: View {
  @StateObject private var store = ClockStore()

  var body: some View {
    VStack(spacing: 0) {
      ClockBar(store: store)
      ScheduleWebView()
        .ignoresSafeArea(edges: .bottom)
    }
    .background(Color(red: 0.12, green: 0.13, blue: 0.14))
  }
}
