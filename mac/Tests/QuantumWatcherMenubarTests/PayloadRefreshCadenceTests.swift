import Foundation
import Testing
@testable import QuantumWatcherMenubar

@Suite("Payload refresh cadence")
struct PayloadRefreshCadenceTests {
    let start = Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 30, hour: 10))!

    @Test("today expires at 120 seconds; every longer period at 15 minutes")
    func intervals() {
        for period in Period.allCases {
            let interval = period == .today ? 120.0 : 900.0
            #expect(PayloadRefreshCadence.isFresh(period: period, fetchedAt: start, now: start.addingTimeInterval(interval - 1)))
            #expect(!PayloadRefreshCadence.isFresh(period: period, fetchedAt: start, now: start.addingTimeInterval(interval)))
        }
    }

    @Test("background ticks force today only; explicit refresh forces every period")
    func forcePolicy() {
        for period in Period.allCases {
            #expect(PayloadRefreshCadence.forceOnTick(period: period, explicit: false) == (period == .today))
            #expect(PayloadRefreshCadence.forceOnTick(period: period, explicit: true))
        }
        #expect(!PayloadRefreshCadence.forceOnTick(period: .today, isDaySelection: true, explicit: false))
    }

    @Test("known Node launches use serial GC; custom launchers retain their argv")
    func backgroundNode() {
        #expect(QuantumWatcherCLI.backgroundArgv(["node", "/tmp/cli.js"]) == ["node", "--single-threaded-gc", "/tmp/cli.js"])
        #expect(QuantumWatcherCLI.backgroundArgv(["/Users/test/node/bin/node", "cli.js"]) == ["/Users/test/node/bin/node", "--single-threaded-gc", "cli.js"])
        #expect(QuantumWatcherCLI.backgroundArgv(["/tmp/cli.js"]) == ["node", "--single-threaded-gc", "/tmp/cli.js"])
        #expect(QuantumWatcherCLI.backgroundArgv(["/tmp/watcher-wrapper"]) == ["/tmp/watcher-wrapper"])
        #expect(QuantumWatcherCLI.backgroundArgv(["quantum-watcher"]) == ["quantum-watcher"])
    }

    @Test("midnight and backwards clock invalidate every period")
    func rollover() {
        let midnight = Calendar.current.startOfDay(for: start)
        for period in Period.allCases {
            #expect(!PayloadRefreshCadence.isFresh(period: period, fetchedAt: midnight.addingTimeInterval(-1), now: midnight))
            #expect(!PayloadRefreshCadence.isFresh(period: period, fetchedAt: start, now: start.addingTimeInterval(-1)))
        }
    }

    @Test("ten minutes of timer ticks run today five times and long periods once")
    func backgroundBudget() {
        var today: Date?, all: Date?
        var todayRuns = 0, allRuns = 0
        for seconds in stride(from: 0, to: 600, by: 120) {
            let now = start.addingTimeInterval(Double(seconds))
            if today == nil || !PayloadRefreshCadence.isFresh(period: .today, fetchedAt: today!, now: now) {
                todayRuns += 1; today = now
            }
            if all == nil || !PayloadRefreshCadence.isFresh(period: .all, fetchedAt: all!, now: now) {
                allRuns += 1; all = now
            }
        }
        #expect(todayRuns == 5)
        #expect(allRuns == 1)
    }
}
