import Foundation
import HealthKit

@MainActor
final class HealthKitTools {
    private let store: HKHealthStore

    init(store: HKHealthStore) {
        self.store = store
    }

    enum HealthError: LocalizedError {
        case unavailable
        case unauthorized
        case query(String)
        var errorDescription: String? {
            switch self {
            case .unavailable: return "HealthKit is unavailable on this device"
            case .unauthorized: return "HealthKit permission not granted for this type"
            case .query(let s): return s
            }
        }
    }

    static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = []
        if let t = HKObjectType.quantityType(forIdentifier: .stepCount) { types.insert(t) }
        if let t = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { types.insert(t) }
        if let t = HKObjectType.quantityType(forIdentifier: .heartRate) { types.insert(t) }
        if let t = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { types.insert(t) }
        return types
    }

    /// Sum a quantity sample over a date range.
    private func sumQuantity(_ type: HKQuantityType, unit: HKUnit, from: Date, to: Date) async throws -> Double {
        guard HKHealthStore.isHealthDataAvailable() else { throw HealthError.unavailable }
        return try await withCheckedThrowingContinuation { cont in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: .strictStartDate)
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, stats, error in
                if let error {
                    cont.resume(throwing: HealthError.query(error.localizedDescription))
                    return
                }
                let value = stats?.sumQuantity()?.doubleValue(for: unit) ?? 0
                cont.resume(returning: value)
            }
            self.store.execute(query)
        }
    }

    func getStepsToday() async throws -> [String: Any] {
        guard let type = HKObjectType.quantityType(forIdentifier: .stepCount) else { throw HealthError.unavailable }
        let cal = Calendar.current
        let start = cal.startOfDay(for: Date())
        let total = try await sumQuantity(type, unit: HKUnit.count(), from: start, to: Date())
        return ["steps": Int(total), "windowStart": ISO8601DateFormatter().string(from: start)]
    }

    func getActiveEnergyToday() async throws -> [String: Any] {
        guard let type = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) else { throw HealthError.unavailable }
        let cal = Calendar.current
        let start = cal.startOfDay(for: Date())
        let total = try await sumQuantity(type, unit: .kilocalorie(), from: start, to: Date())
        return ["kcal": total, "windowStart": ISO8601DateFormatter().string(from: start)]
    }

    func getHeartRateRecent(minutes: Int) async throws -> [String: Any] {
        guard let type = HKObjectType.quantityType(forIdentifier: .heartRate) else { throw HealthError.unavailable }
        let end = Date()
        let start = end.addingTimeInterval(-Double(max(1, minutes)) * 60)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let samples: [HKQuantitySample] = try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: predicate, limit: 1000, sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]) { _, results, error in
                if let error {
                    cont.resume(throwing: HealthError.query(error.localizedDescription))
                    return
                }
                cont.resume(returning: (results as? [HKQuantitySample]) ?? [])
            }
            self.store.execute(q)
        }
        let bpmUnit = HKUnit.count().unitDivided(by: .minute())
        let values = samples.map { $0.quantity.doubleValue(for: bpmUnit) }
        let avg = values.isEmpty ? 0 : values.reduce(0, +) / Double(values.count)
        return [
            "samples": values.count,
            "averageBpm": avg.rounded(),
            "minBpm": values.min() ?? 0,
            "maxBpm": values.max() ?? 0,
            "windowStart": ISO8601DateFormatter().string(from: start),
        ]
    }

    func getSleepLastNight() async throws -> [String: Any] {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { throw HealthError.unavailable }
        let cal = Calendar.current
        // Last night = window from 6pm yesterday to noon today.
        let now = Date()
        let noonToday = cal.date(bySettingHour: 12, minute: 0, second: 0, of: now) ?? now
        let sixPmYesterday = cal.date(byAdding: .day, value: -1, to: cal.date(bySettingHour: 18, minute: 0, second: 0, of: now) ?? now) ?? now
        let predicate = HKQuery.predicateForSamples(withStart: sixPmYesterday, end: noonToday, options: .strictStartDate)
        let samples: [HKCategorySample] = try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, results, error in
                if let error {
                    cont.resume(throwing: HealthError.query(error.localizedDescription))
                    return
                }
                cont.resume(returning: (results as? [HKCategorySample]) ?? [])
            }
            self.store.execute(q)
        }
        let asleepValues: Set<Int> = [
            HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
            HKCategoryValueSleepAnalysis.asleepCore.rawValue,
            HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
            HKCategoryValueSleepAnalysis.asleepREM.rawValue,
        ]
        let totalSeconds = samples
            .filter { asleepValues.contains($0.value) }
            .reduce(0.0) { acc, s in acc + s.endDate.timeIntervalSince(s.startDate) }
        return [
            "windowStart": ISO8601DateFormatter().string(from: sixPmYesterday),
            "windowEnd": ISO8601DateFormatter().string(from: noonToday),
            "asleepSeconds": Int(totalSeconds),
            "asleepHours": (totalSeconds / 3600).rounded(toPlaces: 2),
            "samples": samples.count,
        ]
    }
}

private extension Double {
    func rounded(toPlaces n: Int) -> Double {
        let m = pow(10.0, Double(n))
        return (self * m).rounded() / m
    }
}
