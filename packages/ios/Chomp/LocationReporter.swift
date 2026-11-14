import CoreLocation
import UIKit

extension LocationMode {
    /// Someone who already granted Always keeps what they had. Nobody else is asked for it unprompted.
    static func standard(for status: CLAuthorizationStatus) -> LocationMode {
        status == .authorizedAlways ? .whenIMove : .whileOpen
    }

    func allowsReading(appIsActive: Bool) -> Bool {
        switch self {
        case .whenIMove: return true
        case .whileOpen: return appIsActive
        case .off: return false
        }
    }
}

/// Reports the phone's position to Chomp, as the user chose in Settings. "When I move" lets
/// an agent answer "where am I?" with the app closed and the phone locked. Significant changes
/// and visits use almost no battery, and iOS relaunches the app for them. That mode needs
/// Always location access.
@MainActor
final class LocationReporter: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = LocationReporter()

    /// iOS shows the Always prompt once at most, so Settings must show when it did not stick.
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined
    @Published private(set) var lastSent: Date?
    @Published private(set) var mode: LocationMode = .whileOpen

    private let manager = CLLocationManager()
    private var lastReported: CLLocation?

    override private init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        authorization = manager.authorizationStatus
        mode = AppConfig.shared.locationMode ?? .standard(for: authorization)
    }

    func choose(_ newMode: LocationMode) {
        mode = newMode
        AppConfig.shared.locationMode = newMode
        start()
    }

    /// Call at launch, also a background launch, because iOS only delivers the event
    /// that woke the app to a manager that exists. Does nothing until signed in.
    func start() {
        guard !AppConfig.shared.jwt.isEmpty else { return }
        applyMode()
    }

    /// A fresh position while the app is open, so one that has not moved still says "as of now".
    func refresh() {
        guard !AppConfig.shared.jwt.isEmpty, isAuthorized,
              mode.allowsReading(appIsActive: UIApplication.shared.applicationState == .active) else { return }
        manager.requestLocation()
    }

    private var isAuthorized: Bool {
        [.authorizedAlways, .authorizedWhenInUse].contains(manager.authorizationStatus)
    }

    private func applyMode() {
        let status = manager.authorizationStatus
        if mode == .whenIMove && status == .authorizedAlways {
            manager.startMonitoringSignificantLocationChanges()
            manager.startMonitoringVisits()
        } else {
            manager.stopMonitoringSignificantLocationChanges()
            manager.stopMonitoringVisits()
        }
        if mode != .off && status == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else if mode == .whenIMove && status == .authorizedWhenInUse {
            // iOS only allows asking for Always after When In Use, and shows it once.
            manager.requestAlwaysAuthorization()
        }
        refresh()
    }

    /// Worth sending when it moved, or to say it is still there. Old or invalid readings are not.
    nonisolated static func shouldReport(_ location: CLLocation, after last: CLLocation?) -> Bool {
        guard location.horizontalAccuracy >= 0 else { return false }
        guard let last else { return true }
        let age = location.timestamp.timeIntervalSince(last.timestamp)
        return age > 0 && (age >= 15 * 60 || location.distance(from: last) >= 100)
    }

    private func report(_ location: CLLocation) {
        guard !AppConfig.shared.jwt.isEmpty, mode != .off, Self.shouldReport(location, after: lastReported) else { return }
        // A background launch only lasts a few seconds without this.
        let task = UIApplication.shared.beginBackgroundTask(withName: "chomp-location")
        Task {
            defer { UIApplication.shared.endBackgroundTask(task) }
            let place = try? await CLGeocoder().reverseGeocodeLocation(location).first
            do {
                try await ChompAPI(config: AppConfig.shared).reportLocation(location, address: place.flatMap(Self.placeName))
                lastReported = location
                lastSent = Date()
            } catch {
                // Tailscale may be off. The next movement or app open tries again.
                print("[location] report failed: \(error.localizedDescription)")
            }
        }
    }

    private nonisolated static func placeName(_ place: CLPlacemark) -> String? {
        [place.name, place.locality].compactMap { $0 }.joined(separator: ", ").nilIfEmpty
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            authorization = self.manager.authorizationStatus
            start()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in report(location) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let time = visit.departureDate == .distantFuture ? visit.arrivalDate : visit.departureDate
        let location = CLLocation(
            coordinate: visit.coordinate,
            altitude: 0,
            horizontalAccuracy: visit.horizontalAccuracy,
            verticalAccuracy: -1,
            timestamp: time
        )
        Task { @MainActor in report(location) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("[location] update failed: \(error.localizedDescription)")
    }
}
