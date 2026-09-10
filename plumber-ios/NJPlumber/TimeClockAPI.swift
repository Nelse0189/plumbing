import Foundation

struct TimePlumber: Identifiable, Decodable, Hashable {
  let id: String
  let name: String
  let truckId: String?
}

struct TimeShiftPayload: Decodable {
  let id: String
  let plumberId: String
  let plumberName: String
  let date: String
  let status: String
  let clockInAt: String
  let clockOutAt: String?
  let lastPingAt: String?
}

struct TimeClockResponse: Decodable {
  let ok: Bool?
  let error: String?
  let plumbers: [TimePlumber]?
  let shift: TimeShiftPayload?
  let alreadyOpen: Bool?
}

enum TimeClockAPI {
  static let url = URL(string: "https://us-central1-nj-plumbing.cloudfunctions.net/timeClock")!

  static func roster(plumberId: String) async throws -> TimeClockResponse {
    var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    if !plumberId.isEmpty {
      parts.queryItems = [URLQueryItem(name: "plumberId", value: plumberId)]
    }
    guard let requestURL = parts.url else { throw URLError(.badURL) }
    let (data, response) = try await URLSession.shared.data(from: requestURL)
    try throwIfHTTPError(response, data: data)
    return try JSONDecoder().decode(TimeClockResponse.self, from: data)
  }

  static func clock(
    action: String,
    plumberId: String,
    shiftId: String,
    deviceId: String,
    lat: Double?,
    lng: Double?,
    accuracy: Double?
  ) async throws -> TimeClockResponse {
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    var payload: [String: Any] = [
      "action": action,
      "plumberId": plumberId,
      "shiftId": shiftId,
      "deviceId": deviceId,
    ]
    if let lat, let lng {
      payload["lat"] = lat
      payload["lng"] = lng
      payload["accuracy"] = accuracy ?? 0
    }
    request.httpBody = try JSONSerialization.data(withJSONObject: payload)
    let (data, response) = try await URLSession.shared.data(for: request)
    try throwIfHTTPError(response, data: data)
    return try JSONDecoder().decode(TimeClockResponse.self, from: data)
  }

  private static func throwIfHTTPError(_ response: URLResponse, data: Data) throws {
    guard let http = response as? HTTPURLResponse else { return }
    if (200...299).contains(http.statusCode) { return }
    if let parsed = try? JSONDecoder().decode(TimeClockResponse.self, from: data),
       let message = parsed.error, !message.isEmpty {
      throw TimeClockError.message(message)
    }
    throw TimeClockError.message("Clock request failed (\(http.statusCode)).")
  }
}

enum TimeClockError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    switch self {
    case .message(let text): return text
    }
  }
}
