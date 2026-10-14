import XCTest
@testable import QuantumWatcherMenubar

final class DataClientProcessTests: XCTestCase {
    /// Concurrency + timeout smoke test: launch more hung subprocesses than
    /// there are cooperative threads, all at once, with a short timeout, and
    /// assert every call returns once the timeout kills its sleep.
    ///
    /// NOTE: this does NOT reproduce the production permanent deadlock (16/16
    /// cooperative threads parked in waitUntilExit). In a short-lived unit-test
    /// process libdispatch spins up replacement threads for blocked workers, so
    /// even the old blocking-on-the-pool code completes here. The real deadlock
    /// built up over ~2 days under the @MainActor refresh loop and is confirmed
    /// by the live `sample`, not by this test. Kept as a guard that the
    /// off-pool wait + timeout path stays correct under concurrency.
    func testConcurrentTimedOutProcessesAllComplete() {
        let count = ProcessInfo.processInfo.activeProcessorCount * 2 + 4
        let done = DispatchSemaphore(value: 0)

        Task {
            await withTaskGroup(of: Void.self) { group in
                for _ in 0..<count {
                    group.addTask {
                        _ = try? await DataClient.runProcess(executable: "/bin/sleep", arguments: ["30"],
                                                             timeoutSeconds: 1, label: "sleep 30")
                    }
                }
            }
            done.signal()
        }

        // Wait on the XCTest thread (a real thread, not the cooperative pool) so
        // the deadlock is detectable even when the pool is fully starved.
        let outcome = done.wait(timeout: .now() + 15)
        XCTAssertEqual(outcome, .success,
                       "runProcess deadlocked: \(count) concurrent CLIs starved the cooperative pool")
    }

    /// A normally-exiting process returns its real output and exit code through
    /// the off-pool wait path.
    func testProcessReturnsOutputAndExitCode() async throws {
        let result = try await DataClient.runProcess(executable: "/bin/echo", arguments: ["hello"],
                                                     timeoutSeconds: 5, label: "echo hello")
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(String(data: result.stdout, encoding: .utf8), "hello\n")
    }

    /// Many NORMALLY-exiting processes, all at once, must every one complete
    /// through the terminationHandler wait path. Guards against the wait path
    /// leaking or wedging under concurrency (the production bug was the wait and
    /// its timeout sharing one queue that saturated under sustained load).
    func testManyNormalProcessesAllComplete() async {
        let count = 50
        let codes = await withTaskGroup(of: Int32?.self) { group -> [Int32?] in
            for _ in 0..<count {
                group.addTask {
                    return try? await DataClient.runProcess(executable: "/bin/echo", arguments: ["ok"],
                                                            timeoutSeconds: 5, label: "echo ok").exitCode
                }
            }
            var out: [Int32?] = []
            for await code in group { out.append(code) }
            return out
        }
        XCTAssertEqual(codes.count, count)
        XCTAssertTrue(codes.allSatisfy { $0 == 0 },
                      "every concurrent process should exit 0 via the terminationHandler wait path")
    }

    /// Round-1 finding 5: a launcher that exits at once but leaves a long-lived
    /// grandchild holding the inherited stdout/stderr must not hold the slot. The
    /// call returns within the post-exit bound (2 s grace + 1 s TERM + 1 s KILL)
    /// and the grandchild, in the CLI's process group, is killed.
    func testInheritedPipeGrandchildDoesNotHoldTheSlot() async throws {
        let marker = "qw-r3-grandchild-\(UUID().uuidString)"
        let started = Date()
        let result = try await DataClient.runProcess(
            executable: "/bin/sh",
            arguments: ["-c", "echo out; (exec -a \(marker) /bin/sleep 300) & exit 0"],
            timeoutSeconds: 600, label: "grandchild")
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertLessThan(elapsed, 6, "slot held \(elapsed)s by a grandchild holding the pipes")
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(String(data: result.stdout, encoding: .utf8), "out\n")
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(processExists(matching: marker), "grandchild survived")
    }

    /// Round-2 finding 6 (the reap race): the CLI exits, and a TERM-ignoring
    /// grandchild that redirected its output away (so the pipes reach EOF) is left
    /// in the CLI's group. The supervising loop reaps the leader on its own; the
    /// grandchild must not survive that reap, because nothing can address its
    /// group afterwards.
    func testReapKillsTheGroupLeftBehindByAnExitedCLI() async throws {
        let marker = "qw-r3-reap-\(UUID().uuidString)"
        let started = Date()
        let result = try await DataClient.runProcess(
            executable: "/bin/sh",
            arguments: ["-c", "(trap '' TERM; exec -a \(marker) /bin/sleep 300) >/dev/null 2>&1 & echo done; exit 0"],
            timeoutSeconds: 600, label: "reap race")
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(String(data: result.stdout, encoding: .utf8), "done\n")
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(processExists(matching: marker), "grandchild outlived the reap of its CLI")
    }

    /// A child that ignores SIGTERM and outlives its deadline is SIGKILLed with
    /// its whole group; the call returns within timeout + 1 s + 1 s (+ poll).
    func testTermIgnoringChildIsKilledWithinBound() async {
        let marker = "qw-r3-timeout-\(UUID().uuidString)"
        let started = Date()
        do {
            _ = try await DataClient.runProcess(
                executable: "/bin/sh",
                arguments: ["-c", "trap '' TERM; (trap '' TERM; exec -a \(marker) /bin/sleep 300) & /bin/sleep 300"],
                timeoutSeconds: 1, label: "ignores TERM")
            XCTFail("expected a timeout")
        } catch {
            guard case DataClientError.timeout = error else { return XCTFail("unexpected \(error)") }
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(processExists(matching: marker), "descendant survived the timeout kill")
    }

    /// Quit SIGKILLs every child group at once and synchronously (no SIGTERM
    /// grace), including a TERM-ignoring CLI and its TERM-ignoring descendant, and
    /// refuses new spawns afterwards.
    func testTerminateAllChildrenKillsTermIgnoringGroupSynchronously() async throws {
        let marker = "qw-r3-quit-\(UUID().uuidString)"
        let run = Task.detached {
            try await DataClient.runProcess(
                executable: "/bin/sh",
                arguments: ["-c", "trap '' TERM; (trap '' TERM; exec -a \(marker) /bin/sleep 300) & /bin/sleep 300"],
                timeoutSeconds: 600, label: "quit")
        }
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertTrue(processExists(matching: marker))
        let started = Date()
        DataClient.terminateAllChildren()
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.1)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(processExists(matching: marker), "descendant survived quit")
        _ = try? await run.value
        do {
            _ = try await DataClient.runProcess(executable: "/bin/echo", arguments: ["x"], timeoutSeconds: 5, label: "after quit")
            XCTFail("spawn after quit should be refused")
        } catch {}
        ChildRegistry.shared.resetShutdownForTests()
    }

    /// Round-3 finding 3: a CLI that exits just before its deadline while a
    /// TERM-ignoring descendant holds the pipes takes the longest path (post-exit
    /// grace, TERM, KILL, abandon). It still returns within timeout + 4 s, the
    /// stated hard bound, and the descendant is dead.
    func testExitJustBeforeDeadlineStaysWithinTheHardBound() async throws {
        let marker = "qw-r4-bound-\(UUID().uuidString)"
        let started = monotonicSeconds()
        let result = try await DataClient.runProcess(
            executable: "/bin/sh",
            arguments: ["-c", "(trap '' TERM; exec -a \(marker) /bin/sleep 300) & /bin/sleep 1.9; exit 0"],
            timeoutSeconds: 2, label: "late exit")
        let elapsed = monotonicSeconds() - started
        XCTAssertLessThanOrEqual(elapsed, 2 + 4 + 0.5, "returned after \(elapsed)s, bound is 6 s")
        XCTAssertGreaterThan(elapsed, 3.5, "should have taken the post-exit path")
        XCTAssertEqual(result.exitCode, 0)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(processExists(matching: marker), "descendant survived")
    }

    /// A queued run gives up on the permit after its wait bound, and a waiter that
    /// timed out never takes a permit away from later waiters.
    func testTimedAcquireGivesUpAndLosesNoPermit() async {
        let sem = AsyncSemaphore(1)
        await sem.acquire()
        let started = monotonicSeconds()
        let got = await sem.acquire(timeoutNanos: 300_000_000)
        XCTAssertFalse(got)
        let waited = monotonicSeconds() - started
        XCTAssertGreaterThanOrEqual(waited, 0.29)
        XCTAssertLessThan(waited, 1.0)
        await sem.release()
        let again = await sem.acquire(timeoutNanos: 100_000_000)
        XCTAssertTrue(again, "permit lost to a timed-out waiter")
    }

    /// Round-3 finding 3 (caller side): a cancelled caller stops waiting at once; the
    /// shared run goes on, a later caller on the same day joins it (one invocation),
    /// and the entry is gone once the run ends.
    func testCancelledCallerIsReleasedAndTheRunContinues() async throws {
        let runs = InFlightRuns()
        let counter = Counter()
        let work: @Sendable () async throws -> DataClient.ProcessResult = {
            await counter.increment()
            try await Task.sleep(nanoseconds: 1_500_000_000)
            return DataClient.ProcessResult(stdout: Data("ok".utf8), stderr: "", exitCode: 0)
        }
        let first = Task { try await DataClient.sharedRun(runs, key: "status today", day: "2026-10-14", work: work) }
        try await Task.sleep(nanoseconds: 200_000_000)
        let cancelledAt = monotonicSeconds()
        first.cancel()
        do {
            _ = try await first.value
            XCTFail("a cancelled caller should not get the result")
        } catch is CancellationError {
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertLessThan(monotonicSeconds() - cancelledAt, 0.3, "cancelled caller kept waiting")
        let second = try await DataClient.sharedRun(runs, key: "status today", day: "2026-10-14", work: work)
        XCTAssertEqual(second.stdout, Data("ok".utf8))
        let calls = await counter.value
        XCTAssertEqual(calls, 1, "the second caller should have joined the running invocation")
        try await Task.sleep(nanoseconds: 100_000_000)
        let left = await runs.count
        XCTAssertEqual(left, 0)
    }

    /// Round-3 finding 2: a request made on a new local day never joins a run that was
    /// requested the day before, even with the same argv; the same day does join.
    func testSingleFlightJoinsOnlyWithinTheSameLocalDay() async throws {
        let runs = InFlightRuns()
        let counter = Counter()
        let work: @Sendable () async throws -> DataClient.ProcessResult = {
            let n = await counter.increment()
            try await Task.sleep(nanoseconds: 500_000_000)
            return DataClient.ProcessResult(stdout: Data("run\(n)".utf8), stderr: "", exitCode: 0)
        }
        async let beforeMidnight = DataClient.sharedRun(runs, key: "status today", day: "2026-10-13", work: work)
        try await Task.sleep(nanoseconds: 100_000_000)
        async let afterMidnight = DataClient.sharedRun(runs, key: "status today", day: "2026-10-14", work: work)
        async let sameDay = DataClient.sharedRun(runs, key: "status today", day: "2026-10-14", work: work)
        let (a, b, c) = try await (beforeMidnight, afterMidnight, sameDay)
        XCTAssertNotEqual(a.stdout, b.stdout, "a new-day caller got the previous day's run")
        XCTAssertEqual(b.stdout, c.stdout, "same-day callers should share one run")
        let calls = await counter.value
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(DataClient.localDay(Date(timeIntervalSince1970: 0)).count, 10)
    }

    /// The async semaphore never lets more than its count run concurrently.
    func testAsyncSemaphoreCapsConcurrency() async {
        let sem = AsyncSemaphore(2)
        let peak = PeakCounter()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<12 {
                group.addTask {
                    await sem.acquire()
                    await peak.enter()
                    try? await Task.sleep(nanoseconds: 8_000_000)
                    await peak.leave()
                    await sem.release()
                }
            }
        }
        let observed = await peak.peak
        XCTAssertLessThanOrEqual(observed, 2, "semaphore should cap concurrency at 2, saw \(observed)")
        XCTAssertGreaterThan(observed, 0)
    }
}

private func processExists(matching marker: String) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    p.arguments = ["-f", marker]
    p.standardOutput = FileHandle.nullDevice
    try? p.run()
    p.waitUntilExit()
    return p.terminationStatus == 0
}

private actor PeakCounter {
    private var current = 0
    private(set) var peak = 0
    func enter() { current += 1; peak = max(peak, current) }
    func leave() { current -= 1 }
}

private actor Counter {
    private(set) var value = 0
    @discardableResult func increment() -> Int { value += 1; return value }
}
