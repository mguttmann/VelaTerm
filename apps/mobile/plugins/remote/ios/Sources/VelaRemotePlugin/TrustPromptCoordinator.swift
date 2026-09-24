import Foundation

/// Main-actor ownership keeps prompt completion, cancellation and invalidation atomic.
@MainActor final class TrustPromptCoordinator {
    struct Request: Hashable, Sendable {
        let identity: String
        let fingerprint: String
        let changed: Bool
    }
    /// The returned closure must dismiss this presentation and cancel any pending presentation work.
    typealias Presenter = @Sendable @MainActor (Request, @escaping @MainActor (Bool) -> Void) throws -> (() -> Void)
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Bool, Never>
        let isCurrent: () -> Bool
    }
    private final class Entry {
        let request: Request
        let deadline: ContinuousClock.Instant
        var waiters: [Waiter] = []
        var dismiss: (() -> Void)?
        var watchdog: Task<Void, Never>?
        var finished = false
        init(_ request: Request, deadline: ContinuousClock.Instant) { self.request = request; self.deadline = deadline }
    }
    private nonisolated let presenter: Presenter
    private nonisolated let timeout: TimeInterval
    private nonisolated let now: @MainActor @Sendable () -> ContinuousClock.Instant
    private var queue: [Entry] = []
    private var active: Entry?
    var isPresenting: Bool { active != nil }

    nonisolated init(timeout: TimeInterval = 90,
                     now: @escaping @MainActor @Sendable () -> ContinuousClock.Instant = { ContinuousClock.now },
                     presenter: @escaping Presenter) {
        self.timeout = timeout; self.now = now; self.presenter = presenter
    }

    func decide(_ request: Request, isCurrent: @escaping () -> Bool = { true }) async -> Bool {
        guard !Task.isCancelled, isCurrent() else { return false }
        let id = UUID()
        return await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { continuation in
                let matching = ([active].compactMap { $0 } + queue).first {
                    !$0.finished && $0.request.identity == request.identity && $0.request.fingerprint == request.fingerprint
                }
                let entry = matching ?? Entry(request, deadline: now().advanced(by: .seconds(timeout)))
                entry.waiters.append(Waiter(id: id, continuation: continuation, isCurrent: isCurrent))
                if matching == nil { queue.append(entry); watch(entry) }
                if now() >= entry.deadline { finish(entry, false); return }
                Task { self.startNext() }
            }
        }, onCancel: { Task { @MainActor in self.cancel(id) } })
    }

    /// Called before a connection or load can be replaced; the watchdog also handles external invalidation.
    func cancelInvalidRequests() {
        for entry in queue + [active].compactMap({ $0 }) {
            if now() >= entry.deadline { finish(entry, false); continue }
            let stale = entry.waiters.filter { !$0.isCurrent() }
            entry.waiters.removeAll { !$0.isCurrent() }
            stale.forEach { $0.continuation.resume(returning: false) }
            if entry.waiters.isEmpty { finish(entry, false) }
        }
    }
    func cancelAll() {
        let pending = queue; queue.removeAll()
        for entry in pending { finish(entry, false) }
        if let active { finish(active, false) }
    }
    private func cancel(_ id: UUID) {
        for entry in queue + [active].compactMap({ $0 }) {
            if let index = entry.waiters.firstIndex(where: { $0.id == id }) {
                entry.waiters.remove(at: index).continuation.resume(returning: false)
                if entry.waiters.isEmpty { finish(entry, false) }
                return
            }
        }
    }
    private func startNext() {
        guard active == nil else { return }
        while !queue.isEmpty {
            let entry = queue.removeFirst()
            guard !entry.finished else { continue }
            active = entry
            cancelInvalidRequests()
            guard !entry.finished else { continue }
            do {
                let dismiss = try presenter(entry.request) { [weak self, weak entry] decision in
                    guard let self, let entry else { return }; self.finish(entry, decision)
                }
                // A presenter may fail or answer synchronously before it returns its dismissal handle.
                if entry.finished { dismiss() } else { entry.dismiss = dismiss }
            } catch { finish(entry, false) }
            return
        }
    }
    // Queueing and presentation share the first caller's monotonic deadline; joining never renews it.
    private func watch(_ entry: Entry) {
        entry.watchdog = Task { [weak self, weak entry] in
            while let self, let entry, !entry.finished {
                self.cancelInvalidRequests()
                do { try await Task.sleep(nanoseconds: 20_000_000) } catch { return }
            }
        }
    }
    private func finish(_ entry: Entry, _ decision: Bool) {
        guard !entry.finished else { return }
        let accepted = decision && now() < entry.deadline
        entry.finished = true; entry.watchdog?.cancel(); entry.watchdog = nil
        entry.dismiss?(); entry.dismiss = nil
        let waiters = entry.waiters; entry.waiters.removeAll()
        queue.removeAll { $0 === entry }
        if active === entry { active = nil }
        for waiter in waiters { waiter.continuation.resume(returning: accepted && waiter.isCurrent()) }
        Task { self.startNext() }
    }
}

/// Decisions belong to an explicit connection load, never to a later retry or another browser.
@MainActor final class TrustLoadState {
    private(set) var generation = 0
    private(set) var closed = false
    private var decisions: [String: [String: Bool]] = [:]
    func begin() { generation += 1; closed = false; decisions.removeAll() }
    func close() { generation += 1; closed = true; decisions.removeAll() }
    func isCurrent(_ epoch: Int) -> Bool { !closed && epoch == generation }
    func decision(_ identity: String, _ fingerprint: String) -> Bool? { decisions[identity]?[fingerprint] }
    func record(_ decision: Bool, identity: String, fingerprint: String, epoch: Int) {
        guard isCurrent(epoch) else { return }
        decisions[identity, default: [:]][fingerprint] = decision
    }
}
