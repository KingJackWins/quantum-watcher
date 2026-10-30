import Foundation

/// Upper bound on payload + stderr bytes read from the CLI. Real payloads top out near 500 KB
/// (365 days of history with dozens of models); anything larger is pathological and truncating
/// prevents unbounded memory growth.
private let maxPayloadBytes = 20 * 1024 * 1024
private let maxStderrBytes = 256 * 1024
/// Per-run kill. The old 45 s killed every cold run on a real corpus (a cold parse of
/// ~2,700 transcripts / 6.9 GB measured 41-66 s normally and ~140 s under load, with
/// outliers to ~450 s on a heavily loaded Mac), so the run never finished, the CLI's
/// cache was never saved, and every tick started the same doomed cold run again.
/// 600 s clears the worst measured run with margin while still bounding how long one
/// hung CLI can hold the single refresh slot (see `runProcess`'s release bound).
private let spawnTimeoutSeconds: UInt64 = 600
/// One CLI refresh at a time: concurrent runs parse the same transcripts and write the
/// same cache files, so a second one only multiplies the CPU cost of a cold run.
private let maxConcurrentSpawns = 1
/// How long a run may wait for the spawn permit before it gives up (throws `.timeout`
/// without spawning). One full run ahead of it fits: `runProcess` holds the permit at
/// most `spawnTimeoutSeconds` + `postDeadlineSeconds`.
private let queueWaitSeconds: UInt64 = spawnTimeoutSeconds + UInt64(postDeadlineSeconds)

/// END-TO-END BOUNDS (all on the monotonic uptime clock, `monotonicSeconds()`; a wall-
/// clock change cannot move any of them; time the Mac spends asleep is not counted,
/// and the CLI does not run then either):
///  - The spawn permit (the single refresh slot) is held by one `runProcess` for at
///    most spawnTimeoutSeconds + postDeadlineSeconds = 604 s, plus one poll iteration.
///    That includes the post-exit path: a CLI exiting just before 600 s whose
///    descendants hold the pipes is cut off by the same hard deadline.
///  - A single-flight run (entry in `InFlightRuns`) lives at most queueWaitSeconds +
///    604 s = 1,208 s from creation: at most 604 s waiting for the permit, then at most
///    604 s holding it.
///  - A caller waits at most for its run, so at most 1,208 s; a cancelled caller is
///    released as soon as it is cancelled (`awaitCancellable`), and the run goes on.

/// Monotonic seconds (mach uptime). Never wall clock.
func monotonicSeconds() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
}

enum DataClientError: Error {
    case spawn(String)
    case nonZeroExit(code: Int32, stderr: String)
    case decode(Error)
    case timeout
    case outputTooLarge
}

/// Runs the CLI via argv (no shell interpretation). See `QuantumWatcherCLI` for why we never route
/// commands through `/bin/zsh -c` anymore.
struct DataClient {
    static func fetch(period: Period, day: String? = nil, days: Set<String> = [], provider: ProviderFilter, includeOptimize: Bool) async throws -> MenubarPayload {
        var subcommand = [
            "status",
            "--format", "menubar-json",
            "--provider", provider.cliArg,
        ]
        if days.count > 1 {
            subcommand.append(contentsOf: ["--days", days.sorted().joined(separator: ",")])
        } else if let day {
            subcommand.append(contentsOf: ["--day", day])
        } else if let d = days.first {
            subcommand.append(contentsOf: ["--day", d])
        } else {
            subcommand.append(contentsOf: ["--period", period.cliArg])
        }
        if !includeOptimize {
            subcommand.append("--no-optimize")
        }

        let result = try await runCLI(subcommand: subcommand)
        guard result.exitCode == 0 else {
            throw DataClientError.nonZeroExit(code: result.exitCode, stderr: result.stderr)
        }
        do {
            return try JSONDecoder().decode(MenubarPayload.self, from: result.stdout)
        } catch {
            throw DataClientError.decode(error)
        }
    }

    /// Due periods share the validated session snapshot inside one CLI. The
    /// normal per-period payload schema is unchanged inside this envelope.
    static func fetchPeriods(_ periods: [Period]) async throws -> [Period: MenubarPayload] {
        if periods.count == 1, let period = periods.first {
            return [period: try await fetch(period: period, provider: .all, includeOptimize: false)]
        }
        let ordered = periods.sorted { a, b in
            if a == .today { return b != .today }
            if b == .today { return false }
            return a.cliArg < b.cliArg
        }
        let result = try await runCLI(subcommand: ["status", "--format", "menubar-json", "--provider", "all",
                                                  "--periods", ordered.map(\.cliArg).joined(separator: ","), "--no-optimize"])
        if result.exitCode != 0 {
            // Allow app/CLI updates in either order. A genuinely failed batch
            // is not retried; only an older CLI's unknown-option response is.
            if result.stderr.contains("unknown option '--periods") {
                var fallback: [Period: MenubarPayload] = [:]
                for period in ordered {
                    fallback[period] = try await fetch(period: period, provider: .all, includeOptimize: false)
                }
                return fallback
            }
            throw DataClientError.nonZeroExit(code: result.exitCode, stderr: result.stderr)
        }
        struct Batch: Decodable { let payloads: [String: MenubarPayload] }
        do {
            let batch = try JSONDecoder().decode(Batch.self, from: result.stdout)
            var payloads: [Period: MenubarPayload] = [:]
            for period in ordered {
                guard let payload = batch.payloads[period.cliArg] else {
                    throw NSError(domain: "QuantumWatcherBatch", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "Missing period in CLI response: \(period.cliArg)"])
                }
                payloads[period] = payload
            }
            return payloads
        } catch { throw DataClientError.decode(error) }
    }

    struct ProcessResult {
        let stdout: Data
        let stderr: String
        let exitCode: Int32
    }

    /// Caps concurrent CLI spawns so a wake-burst of refreshes can't fan out into
    /// several node processes at once.
    private static let spawnLimiter = AsyncSemaphore(maxConcurrentSpawns)

    /// Identical requests made on the same local calendar day share one in-flight run
    /// (single-flight). The run lives in a detached task, so a caller that is cancelled
    /// or abandoned by a UI watchdog stops waiting at once but never kills the CLI: the
    /// next tick joins the same run instead of starting another one, and the run still
    /// gets to finish and save the CLI's cache. A caller on a new day never joins a run
    /// requested the day before (its `--period today` means another day); it starts its
    /// own invocation, as base did for every caller.
    private static let inFlight = InFlightRuns()

    private static func runCLI(subcommand: [String]) async throws -> ProcessResult {
        let label = subcommand.joined(separator: " ")
        return try await sharedRun(inFlight,
                                   key: subcommand.joined(separator: "\u{1F}"),
                                   day: localDay(Date())) {
            guard await spawnLimiter.acquire(timeoutNanos: queueWaitSeconds * 1_000_000_000) else {
                NSLog("QuantumWatcher: %@ waited %llus for the refresh slot — giving up", label, queueWaitSeconds)
                throw DataClientError.timeout
            }
            do {
                let command = QuantumWatcherCLI.makeCommand(subcommand: subcommand)
                let result = try await runProcess(executable: command.executable,
                                                  arguments: command.arguments,
                                                  environment: command.environment,
                                                  timeoutSeconds: spawnTimeoutSeconds,
                                                  label: label)
                await spawnLimiter.release()
                return result
            } catch {
                await spawnLimiter.release()
                throw error
            }
        }
    }

    /// The local calendar day a request is made on, e.g. "2026-10-14". Part of the
    /// single-flight key (wall clock on purpose: it names the day the request means).
    static func localDay(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Joins the run for (`day`, `key`) if one is in flight, else starts `work` as a
    /// new detached run, and waits for it cancellably.
    static func sharedRun(_ runs: InFlightRuns,
                          key: String,
                          day: String,
                          work: @escaping @Sendable () async throws -> ProcessResult) async throws -> ProcessResult {
        let task = await runs.task(for: day + "\u{1E}" + key, work: work)
        return try await awaitCancellable(task)
    }

    /// Waits for `task`'s value, but returns (throwing CancellationError) as soon as the
    /// calling task is cancelled. Cancelling the caller never cancels the shared run.
    static func awaitCancellable<T: Sendable>(_ task: Task<T, Error>) async throws -> T {
        let once = ResumeOnce<T>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
                once.install(cont)
                Task { once.resume(await task.result) }
            }
        } onCancel: {
            once.resume(.failure(CancellationError()))
        }
    }

    /// Quit path, called from applicationWillTerminate. Refuses new spawns, then
    /// SIGKILLs the whole process group of every CLI child not yet reaped. No SIGTERM
    /// grace and nothing asynchronous: it returns after the signals are sent, before
    /// the app exits. Every child already reaped had its group SIGKILLed before the
    /// reap (`ChildRegistry.reap`), so no group of ours can outlive this call.
    static func terminateAllChildren() {
        ChildRegistry.shared.killAllForQuit()
    }

    /// Spawns `executable` in a NEW PROCESS GROUP (posix_spawn + POSIX_SPAWN_SETPGROUP)
    /// with stdin = /dev/null and stdout/stderr on pipes, and supervises it from one
    /// non-blocking polling loop: drain the pipes, watch for the CLI's exit (waitid
    /// with WNOWAIT, so the pid and its group id stay reserved until we reap), and
    /// enforce the deadlines.
    ///
    /// RELEASE BOUND (monotonic clock): this function returns (and so the spawn permit
    /// is released) no later than `timeoutSeconds` + `postDeadlineSeconds` (604 s in
    /// production) after the spawn, plus one poll iteration, on every path: a hard
    /// deadline SIGKILLs the group and abandons the pipes then, whatever phase the
    /// supervision is in. Before that, it returns no later than `exitPipeGraceSeconds`
    /// + `killGraceSeconds` + `abandonAfterKillSeconds` (4 s) after the CLI itself
    /// exits, whatever its descendants do with the inherited pipes, and no later than
    /// 2 s after a timeout or output overflow. It never waits for pipe EOF beyond those
    /// windows: on expiry it SIGTERMs then SIGKILLs the process group and closes
    /// (abandons) its pipe read ends.
    ///
    /// On return, whatever is left of the CLI's process group has been SIGKILLed
    /// (`ChildRegistry.reap` kills the group before it reaps the leader).
    ///
    /// CRITICAL: nothing here may block a worker thread waiting for the process (an
    /// earlier version parked cooperative threads in waitUntilExit and wedged the
    /// menubar). Every call in the loop is non-blocking; waits are Task.sleep.
    static func runProcess(executable: String,
                           arguments: [String],
                           environment: [String: String]? = nil,
                           timeoutSeconds: UInt64,
                           label: String) async throws -> ProcessResult {
        let registry = ChildRegistry.shared
        let child: SpawnedChild
        let outFD: Int32
        let errFD: Int32
        do {
            (child, outFD, errFD) = try registry.spawn(executable: executable,
                                                       arguments: [executable] + arguments,
                                                       environment: environment ?? ProcessInfo.processInfo.environment)
        } catch let e as DataClientError {
            throw e
        } catch {
            throw DataClientError.spawn(error.localizedDescription)
        }

        let startedAt = monotonicSeconds()
        let hardDeadline = startedAt + Double(timeoutSeconds) + postDeadlineSeconds
        var out = PipeReader(fd: outFD, limit: maxPayloadBytes)
        var err = PipeReader(fd: errFD, limit: maxStderrBytes)

        /// Each phase carries the monotonic time it began.
        enum Phase { case running, exited(Double), terminating(Double), killed(Double) }
        var phase = Phase.running
        var reason: DataClientError?

        loop: while true {
            let gotOut = out.drain()
            let gotErr = err.drain()
            let gotData = gotOut || gotErr
            let now = monotonicSeconds()
            let exited = registry.hasExited(child)

            if now >= hardDeadline {
                NSLog("QuantumWatcher: %@ reached its %.0fs hard deadline — killing the group and abandoning its pipes",
                      label, Double(timeoutSeconds) + postDeadlineSeconds)
                if !exited && reason == nil { reason = .timeout }
                registry.signal(child, SIGKILL)
                break loop
            }

            switch phase {
            case .running:
                if out.overflowed {
                    NSLog("QuantumWatcher: CLI output exceeded %d bytes for %@ — terminating", maxPayloadBytes, label)
                    reason = .outputTooLarge
                    registry.signal(child, SIGTERM)
                    phase = .terminating(now)
                } else if exited {
                    phase = .exited(now)
                } else if now - startedAt >= Double(timeoutSeconds) {
                    NSLog("QuantumWatcher: CLI subprocess timed out after %llus for %@ — terminating",
                          timeoutSeconds, label)
                    reason = .timeout
                    registry.signal(child, SIGTERM)
                    phase = .terminating(now)
                }
            case .exited(let at):
                if out.eof && err.eof { break loop }
                if now - at >= exitPipeGraceSeconds {
                    // The CLI is gone but something it started still holds our pipes.
                    NSLog("QuantumWatcher: descendants of %@ kept its output open after exit — terminating the group", label)
                    registry.signal(child, SIGTERM)
                    phase = .terminating(now)
                }
            case .terminating(let at):
                if exited && out.eof && err.eof { break loop }
                if now - at >= killGraceSeconds {
                    registry.signal(child, SIGKILL)
                    phase = .killed(now)
                }
            case .killed(let at):
                if exited && out.eof && err.eof { break loop }
                if now - at >= abandonAfterKillSeconds {
                    NSLog("QuantumWatcher: abandoning the pipes of %@ after SIGKILL", label)
                    break loop
                }
            }
            if !gotData { try? await Task.sleep(nanoseconds: pollIntervalNanos) }
        }

        // Abandon the read ends whether or not EOF arrived: a writer that is still
        // alive gets EPIPE/SIGPIPE, never our slot.
        out.close()
        err.close()
        let status = registry.reapOrHandOff(child)

        if let reason { throw reason }
        if out.overflowed { throw DataClientError.outputTooLarge }
        return ProcessResult(stdout: out.buffer,
                             stderr: String(data: err.buffer, encoding: .utf8) ?? "",
                             exitCode: status ?? -1)
    }
}

/// Supervision timings (see `DataClient.runProcess`).
private let pollIntervalNanos: UInt64 = 10_000_000
private let exitPipeGraceSeconds: TimeInterval = 2
private let killGraceSeconds: TimeInterval = 1
private let abandonAfterKillSeconds: TimeInterval = 1
/// Longest supervision path after the run deadline: exit just before it, then the
/// post-exit grace, TERM and KILL windows. The hard deadline is timeout + this.
private let postDeadlineSeconds: TimeInterval = exitPipeGraceSeconds + killGraceSeconds + abandonAfterKillSeconds

/// Non-blocking reader for one pipe read end.
struct PipeReader {
    let fd: Int32
    let limit: Int
    var buffer = Data()
    var eof = false
    var overflowed = false
    private var closed = false

    init(fd: Int32, limit: Int) {
        self.fd = fd
        self.limit = limit
        let flags = Darwin.fcntl(fd, F_GETFL)
        if flags >= 0 { _ = Darwin.fcntl(fd, F_SETFL, flags | O_NONBLOCK) }
    }

    /// Reads whatever is available right now. Returns true if any bytes arrived.
    mutating func drain() -> Bool {
        guard !eof, !closed, !overflowed else { return false }
        var got = false
        var chunk = [UInt8](repeating: 0, count: 65_536)
        while true {
            let n = chunk.withUnsafeMutableBufferPointer { Darwin.read(fd, $0.baseAddress!, $0.count) }
            if n > 0 {
                got = true
                if buffer.count + n > limit {
                    buffer.append(contentsOf: chunk.prefix(max(0, limit - buffer.count)))
                    overflowed = true
                    return true
                }
                buffer.append(contentsOf: chunk.prefix(n))
            } else if n == 0 {
                eof = true
                return got
            } else if errno == EINTR {
                continue
            } else {
                if errno != EAGAIN && errno != EWOULDBLOCK {
                    NSLog("QuantumWatcher: pipe read() failed on fd %d: errno %d", fd, errno)
                    eof = true
                }
                return got
            }
        }
    }

    mutating func close() {
        guard !closed else { return }
        closed = true
        Darwin.close(fd)
    }
}

/// One CLI child, leader of its own process group (pgid == pid). All state is
/// guarded by `ChildRegistry`'s lock.
final class SpawnedChild: @unchecked Sendable {
    let pid: pid_t
    fileprivate var status: Int32?

    init(pid: pid_t) { self.pid = pid }
}

/// Every CLI child not yet reaped. One lock serialises spawning, signalling,
/// reaping and quit, which gives two invariants:
///  1. A child is in `children` exactly until it is reaped, so its pid, and with
///     it its process-group id, cannot have been reused by anything else while it
///     is there. Signalling a registered child's group is always safe.
///  2. A child is reaped only after its whole group was SIGKILLed (`reap`). So when
///     the leader is gone from the table, nothing of its group is left running,
///     and quit only has to SIGKILL the groups still in the table, unconditionally.
/// No spawn can start after (or slip past) quit: the shutdown flag is checked under
/// the same lock.
final class ChildRegistry: @unchecked Sendable {
    static let shared = ChildRegistry()
    private let lock = NSLock()
    private var children: [pid_t: SpawnedChild] = [:]
    private var shuttingDown = false

    func spawn(executable: String, arguments: [String], environment: [String: String]) throws -> (SpawnedChild, Int32, Int32) {
        lock.lock(); defer { lock.unlock() }
        if shuttingDown { throw DataClientError.spawn("app is terminating") }
        let (pid, outFD, errFD) = try posixSpawnInOwnGroup(executable: executable, arguments: arguments, environment: environment)
        let child = SpawnedChild(pid: pid)
        children[pid] = child
        return (child, outFD, errFD)
    }

    /// Signals the child's whole process group, and the child itself, while it is
    /// still registered (invariant 1).
    func signal(_ child: SpawnedChild, _ sig: Int32) {
        lock.lock(); defer { lock.unlock() }
        guard children[child.pid] === child else { return }
        _ = killpg(child.pid, sig)
        _ = kill(child.pid, sig)
    }

    /// True once the child has exited. Does NOT reap it (WNOWAIT).
    func hasExited(_ child: SpawnedChild) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if child.status != nil { return true }
        var info = siginfo_t()
        let rc = waitid(P_PID, id_t(child.pid), &info, WEXITED | WNOHANG | WNOWAIT)
        if rc == 0 { return info.si_pid == child.pid }
        return errno == ECHILD
    }

    /// If the leader has exited: SIGKILL whatever is left of its process group
    /// (its pid is still reserved, so the group id is still ours), then reap it and
    /// drop it from the table. Returns its exit code (the signal number if it was
    /// killed by a signal, matching Process.terminationStatus), or nil if the
    /// leader is still running.
    func reap(_ child: SpawnedChild) -> Int32? {
        lock.lock(); defer { lock.unlock() }
        if let s = child.status { return s }
        var info = siginfo_t()
        let rc = waitid(P_PID, id_t(child.pid), &info, WEXITED | WNOHANG | WNOWAIT)
        if rc == 0 && info.si_pid != child.pid { return nil }
        if rc == 0 {
            _ = killpg(child.pid, SIGKILL)
            var raw: Int32 = 0
            guard waitpid(child.pid, &raw, WNOHANG) == child.pid else { return nil }
            let sig = raw & 0x7f
            child.status = sig == 0 ? (raw >> 8) & 0xff : sig
        } else if errno == ECHILD {
            child.status = -1
        } else {
            return nil
        }
        children[child.pid] = nil
        return child.status
    }

    /// Reap now if possible; otherwise (a leader that survived SIGKILL, e.g. stuck in
    /// uninterruptible I/O) keep it registered, so quit can still SIGKILL its group,
    /// and reap it in the background without holding any caller.
    func reapOrHandOff(_ child: SpawnedChild) -> Int32? {
        if let s = reap(child) { return s }
        Task.detached(priority: .background) { [self] in
            while reap(child) == nil {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        return nil
    }

    /// Refuses all further spawns, then SIGKILLs the process group (and the leader)
    /// of every child not yet reaped. Synchronous; returns once the signals are sent.
    func killAllForQuit() {
        lock.lock(); defer { lock.unlock() }
        shuttingDown = true
        for child in children.values {
            _ = killpg(child.pid, SIGKILL)
            _ = kill(child.pid, SIGKILL)
        }
    }

    /// Test hook: re-allow spawns after a simulated quit.
    func resetShutdownForTests() { lock.lock(); shuttingDown = false; lock.unlock() }
}

private func setCloexec(_ fd: Int32) {
    let flags = Darwin.fcntl(fd, F_GETFD)
    if flags >= 0 { _ = Darwin.fcntl(fd, F_SETFD, flags | FD_CLOEXEC) }
}

/// posix_spawn `arguments` (argv, including argv[0]) as the leader of a new
/// process group, stdin from /dev/null, stdout/stderr to fresh pipes, every other
/// descriptor closed (POSIX_SPAWN_CLOEXEC_DEFAULT), default signal dispositions
/// and an empty signal mask, at user-initiated QoS. Returns the pid and the
/// parent's read ends.
private func posixSpawnInOwnGroup(executable: String, arguments: [String], environment: [String: String]) throws -> (pid_t, Int32, Int32) {
    var outPipe: [Int32] = [-1, -1]
    var errPipe: [Int32] = [-1, -1]
    guard pipe(&outPipe) == 0 else { throw DataClientError.spawn("pipe: errno \(errno)") }
    guard pipe(&errPipe) == 0 else {
        close(outPipe[0]); close(outPipe[1])
        throw DataClientError.spawn("pipe: errno \(errno)")
    }
    // Other spawns in this app (Foundation Process elsewhere) must not inherit
    // our ends, or they would keep these pipes open.
    for fd in outPipe + errPipe { setCloexec(fd) }

    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1)
    posix_spawn_file_actions_adddup2(&actions, errPipe[1], 2)

    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    let flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
    posix_spawnattr_setflags(&attr, Int16(flags))
    posix_spawnattr_setpgroup(&attr, 0)
    var allSignals = sigset_t()
    sigfillset(&allSignals)
    posix_spawnattr_setsigdefault(&attr, &allSignals)
    var noSignals = sigset_t()
    sigemptyset(&noSignals)
    posix_spawnattr_setsigmask(&attr, &noSignals)
    // Replaces `process.qualityOfService = .userInitiated`: an accessory app's
    // children are otherwise background-throttled and parse 5-10x slower.
    posix_spawnattr_set_qos_class_np(&attr, QOS_CLASS_USER_INITIATED)

    let argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) } + [nil]
    let envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer {
        for p in argv { free(p) }
        for p in envp { free(p) }
    }

    var pid: pid_t = 0
    let rc = argv.withUnsafeBufferPointer { a in
        envp.withUnsafeBufferPointer { e in
            posix_spawn(&pid, executable, &actions, &attr, a.baseAddress, e.baseAddress)
        }
    }
    close(outPipe[1])
    close(errPipe[1])
    guard rc == 0 else {
        close(outPipe[0]); close(errPipe[0])
        throw DataClientError.spawn("posix_spawn \(executable): \(String(cString: strerror(rc)))")
    }
    return (pid, outPipe[0], errPipe[0])
}

/// Single-flight table: one shared run per key (local request day + CLI argv). An
/// entry lives exactly as long as its run: the run removes it when it finishes, so
/// callers that stop waiting (cancelled) never cause a duplicate run of the same key.
actor InFlightRuns {
    private var tasks: [String: (token: UInt64, task: Task<DataClient.ProcessResult, Error>)] = [:]
    private var nextToken: UInt64 = 0

    func task(for key: String,
              work: @escaping @Sendable () async throws -> DataClient.ProcessResult) -> Task<DataClient.ProcessResult, Error> {
        if let existing = tasks[key] { return existing.task }
        nextToken += 1
        let token = nextToken
        // Removal hops back onto this actor, so it always runs after the insert below.
        let task = Task.detached(priority: .utility) { [self] () async throws -> DataClient.ProcessResult in
            do {
                let result = try await work()
                await self.remove(key: key, token: token)
                return result
            } catch {
                await self.remove(key: key, token: token)
                throw error
            }
        }
        tasks[key] = (token, task)
        return task
    }

    private func remove(key: String, token: UInt64) {
        if tasks[key]?.token == token { tasks[key] = nil }
    }

    /// Test hook.
    var count: Int { tasks.count }
}

/// Resumes a checked continuation exactly once, with whichever result arrives first;
/// a result that arrives before the continuation is installed is kept for it.
final class ResumeOnce<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<T, Error>?
    private var pending: Result<T, Error>?
    private var done = false

    func install(_ c: CheckedContinuation<T, Error>) {
        lock.lock()
        if let p = pending, !done {
            done = true
            pending = nil
            lock.unlock()
            c.resume(with: p)
            return
        }
        cont = c
        lock.unlock()
    }

    func resume(_ r: Result<T, Error>) {
        lock.lock()
        if done || pending != nil { lock.unlock(); return }
        if let c = cont {
            done = true
            cont = nil
            lock.unlock()
            c.resume(with: r)
        } else {
            pending = r
            lock.unlock()
        }
    }
}

/// Minimal actor-based async semaphore. Caps concurrency without blocking a
/// thread (unlike DispatchSemaphore.wait()). Waiters are served in FIFO order.
actor AsyncSemaphore {
    private var available: Int
    private var waiters: [(id: UInt64, cont: CheckedContinuation<Bool, Never>)] = []
    private var nextId: UInt64 = 0

    init(_ count: Int) { available = count }

    func acquire() async {
        _ = await acquire(timeoutNanos: nil)
    }

    /// Returns true once a permit is held, or false if `timeoutNanos` (monotonic,
    /// Task.sleep) passed first; a waiter that timed out never holds a permit.
    func acquire(timeoutNanos: UInt64?) async -> Bool {
        if available > 0 {
            available -= 1
            return true
        }
        nextId += 1
        let id = nextId
        if let timeoutNanos {
            Task { [self] in
                try? await Task.sleep(nanoseconds: timeoutNanos)
                self.expire(id)
            }
        }
        // The append runs before this actor can run anything else (expire included).
        return await withCheckedContinuation { waiters.append((id, $0)) }
    }

    private func expire(_ id: UInt64) {
        guard let i = waiters.firstIndex(where: { $0.id == id }) else { return }
        waiters.remove(at: i).cont.resume(returning: false)
    }

    func release() {
        if waiters.isEmpty {
            available += 1
        } else {
            waiters.removeFirst().cont.resume(returning: true)
        }
    }
}
