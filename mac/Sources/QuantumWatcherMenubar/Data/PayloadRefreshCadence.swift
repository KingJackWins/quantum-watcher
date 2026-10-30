import Foundation

/// Background payload cadence. Explicit refresh and popover recovery bypass it.
/// DataClient's existing single spawn permit serializes every period/provider.
enum PayloadRefreshCadence {
    static let todaySeconds: TimeInterval = 120
    static let longPeriodSeconds: TimeInterval = 15 * 60

    /// A scheduled tick always fetches the live day. Long periods honor their
    /// own cache TTL; interaction can force any period regardless of its age.
    static func forceOnTick(period: Period, isDaySelection: Bool = false, explicit: Bool) -> Bool {
        explicit || (period == .today && !isDaySelection)
    }

    static func isFresh(period: Period, fetchedAt: Date, now: Date = Date()) -> Bool {
        // A payload requested yesterday must never satisfy today's request.
        guard Calendar.current.isDate(fetchedAt, inSameDayAs: now) else { return false }
        let age = now.timeIntervalSince(fetchedAt)
        let interval = period == .today ? todaySeconds : longPeriodSeconds
        return age >= 0 && age < interval
    }
}
