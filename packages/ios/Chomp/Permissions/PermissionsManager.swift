import Foundation
import CoreLocation
import EventKit
import Contacts
import Photos
import UserNotifications
import HealthKit

/// Status snapshot shown in the Permissions pane.
struct PermissionsStatus: Equatable {
    var location: String = "—"
    var calendar: String = "—"
    var reminders: String = "—"
    var contacts: String = "—"
    var photos: String = "—"
    var notifications: String = "—"
    var healthKit: String = "—"
}

@MainActor
final class PermissionsManager: NSObject, ObservableObject {
    @Published var status: PermissionsStatus = PermissionsStatus()

    private let locationManager = CLLocationManager()
    let eventStore = EKEventStore()
    let healthStore = HKHealthStore()

    override init() {
        super.init()
        locationManager.delegate = self
        refresh()
    }

    func refresh() {
        status.location = describe(authorizationStatus: locationManager.authorizationStatus)
        status.calendar = describe(eventStatus: EKEventStore.authorizationStatus(for: .event))
        status.reminders = describe(eventStatus: EKEventStore.authorizationStatus(for: .reminder))
        status.contacts = describe(contactStatus: CNContactStore.authorizationStatus(for: .contacts))
        status.photos = describe(photoStatus: PHPhotoLibrary.authorizationStatus(for: .readWrite))
        // Notification status is async — kick a refresh
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            status.notifications = describe(notificationStatus: settings.authorizationStatus)
        }
        // HealthKit doesn't expose per-type status without a query; we just say "available" if HK is supported.
        status.healthKit = HKHealthStore.isHealthDataAvailable() ? "Available" : "Unavailable"
    }

    func requestAll() async {
        await requestLocation()
        await requestEvents(.event)
        await requestEvents(.reminder)
        await requestContacts()
        await requestPhotos()
        await requestNotifications()
        await requestHealthKit()
        refresh()
    }

    func requestLocation() async {
        // CL's authorization request is async-flavored via the delegate; treat it fire-and-forget.
        // Always is only asked for when the user picks "When I move" in Settings.
        locationManager.requestWhenInUseAuthorization()
    }

    func requestEvents(_ type: EKEntityType) async {
        do {
            switch type {
            case .event:
                _ = try await eventStore.requestFullAccessToEvents()
            case .reminder:
                _ = try await eventStore.requestFullAccessToReminders()
            @unknown default:
                break
            }
        } catch {
            // Denied or restricted — refresh() picks up the state.
        }
        refresh()
    }

    func requestContacts() async {
        let store = CNContactStore()
        do {
            _ = try await store.requestAccess(for: .contacts)
        } catch {}
        refresh()
    }

    func requestPhotos() async {
        _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        refresh()
    }

    func requestNotifications() async {
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        } catch {}
        refresh()
    }

    func requestHealthKit() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let types = HealthKitTools.readTypes
        do {
            try await healthStore.requestAuthorization(toShare: [], read: types)
        } catch {}
        refresh()
    }

    // MARK: - Describe

    private func describe(authorizationStatus status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "Not asked"
        case .restricted: return "Restricted"
        case .denied: return "Denied"
        case .authorizedAlways: return "Always"
        case .authorizedWhenInUse: return "When in use"
        @unknown default: return "Unknown"
        }
    }

    private func describe(eventStatus status: EKAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "Not asked"
        case .restricted: return "Restricted"
        case .denied: return "Denied"
        case .fullAccess: return "Full access"
        case .writeOnly: return "Write only"
        case .authorized: return "Authorized"
        @unknown default: return "Unknown"
        }
    }

    private func describe(contactStatus status: CNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "Not asked"
        case .restricted: return "Restricted"
        case .denied: return "Denied"
        case .authorized: return "Authorized"
        case .limited: return "Limited"
        @unknown default: return "Unknown"
        }
    }

    private func describe(photoStatus status: PHAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "Not asked"
        case .restricted: return "Restricted"
        case .denied: return "Denied"
        case .authorized: return "Full access"
        case .limited: return "Limited"
        @unknown default: return "Unknown"
        }
    }

    private func describe(notificationStatus status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "Not asked"
        case .denied: return "Denied"
        case .authorized: return "Authorized"
        case .provisional: return "Provisional"
        case .ephemeral: return "Ephemeral"
        @unknown default: return "Unknown"
        }
    }
}

extension PermissionsManager: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor [weak self] in self?.refresh() }
    }
}
