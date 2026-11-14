import Foundation
import CoreLocation
import UIKit

/// One-shot location read. There is no continuous tracking, so no background location mode and no blue bar.
@MainActor
final class LocationTools: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation, Error>?
    private var timeoutWork: DispatchWorkItem?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    enum LocationError: LocalizedError, Equatable {
        case denied
        case needsAlways
        case turnedOff
        case onlyWhileOpen
        case busy
        case timeout
        case unknown(String)
        var errorDescription: String? {
            switch self {
            case .denied: return "Location permission denied"
            case .needsAlways: return "Location access is not Always, so the phone cannot read its position while locked. Change it in Settings, Chomp, Location."
            case .turnedOff: return "The user turned location off in Chomp's settings."
            case .onlyWhileOpen: return "The user shares location only while Chomp is open, and it is not open now."
            case .busy: return "A location request is already running"
            case .timeout: return "Location request timed out"
            case .unknown(let s): return s
            }
        }
    }

    /// Why a read cannot work right now. In the background iOS only allows it with Always, and it cannot show a prompt.
    nonisolated static func blocker(mode: LocationMode, status: CLAuthorizationStatus, appIsActive: Bool) -> LocationError? {
        if mode == .off { return .turnedOff }
        if !mode.allowsReading(appIsActive: appIsActive) { return .onlyWhileOpen }
        switch status {
        case .denied, .restricted: return .denied
        case .authorizedAlways: return nil
        default: return appIsActive ? nil : .needsAlways
        }
    }

    func getLocation(timeout: TimeInterval = 15) async throws -> CLLocation {
        if let blocker = Self.blocker(mode: LocationReporter.shared.mode, status: manager.authorizationStatus, appIsActive: UIApplication.shared.applicationState == .active) {
            throw blocker
        }
        guard continuation == nil else { throw LocationError.busy }
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }

        // A silent push only keeps the app awake for moments, and a position can take longer.
        let background = UIApplication.shared.beginBackgroundTask(withName: "chomp-get-location")
        defer { UIApplication.shared.endBackgroundTask(background) }

        return try await withCheckedThrowingContinuation { cont in
            self.continuation = cont
            let work = DispatchWorkItem { [weak self] in self?.finish(.failure(LocationError.timeout)) }
            self.timeoutWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: work)
            manager.requestLocation()
        }
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        timeoutWork?.cancel()
        timeoutWork = nil
        continuation?.resume(with: result)
        continuation = nil
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor [weak self] in
            guard let self, let loc = locations.last else { return }
            self.finish(.success(loc))
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor [weak self] in
            self?.finish(.failure(LocationError.unknown(error.localizedDescription)))
        }
    }
}
