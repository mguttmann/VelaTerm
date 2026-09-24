// Host-side tests for TrustPromptCoordinator, run by scripts/test-ios-native.sh with plain swiftc on macOS.
// Every case drives the real source file through a scripted presenter; no UIKit, device or simulator involved.
import Foundation

typealias Request = TrustPromptCoordinator.Request

/// Scripted presenter: records every presentation and holds it open until the test answers it.
@MainActor final class Gate {
    private(set) var presented: [Request] = []
    private var open: [(UUID, @MainActor (Bool) -> Void)] = []
    private(set) var maxOpen = 0
    var failure: Error?
    var lastAnswer: (@MainActor (Bool) -> Void)?
    struct Unavailable: Error {}
    func present(_ request: Request, finish: @escaping @MainActor (Bool) -> Void) throws -> (() -> Void) {
        presented.append(request)
        if let failure { throw failure }
        let id = UUID(); open.append((id, finish)); lastAnswer = finish
        maxOpen = max(maxOpen, open.count)
        return { self.open.removeAll { $0.0 == id } }
    }
    var openCount: Int { open.count }
    func answer(_ decision: Bool) { let next = open.removeFirst(); next.1(decision) }
}

var failures = 0
func check(_ condition: Bool, _ label: String) {
    if condition { print("ok   \(label)") } else { failures += 1; print("FAIL \(label)") }
}
/// Yields to the cooperative pool until `condition` holds or about two seconds passed.
@MainActor func settle(_ condition: @escaping () -> Bool) async {
    let deadline = Date().addingTimeInterval(2)
    while !condition(), Date() < deadline { await Task.yield(); try? await Task.sleep(nanoseconds: 1_000_000) }
}
@MainActor func make(timeout: TimeInterval = 90) -> (TrustPromptCoordinator, Gate) {
    let gate = Gate()
    return (TrustPromptCoordinator(timeout: timeout) { try gate.present($0, finish: $1) }, gate)
}
@MainActor final class TestClock {
    var now = ContinuousClock.now
    func advance(_ milliseconds: Int64) { now = now.advanced(by: .milliseconds(milliseconds)) }
    func make(timeout: TimeInterval = 0.1) -> (TrustPromptCoordinator, Gate) {
        let gate = Gate()
        return (TrustPromptCoordinator(timeout: timeout, now: { self.now }) { try gate.present($0, finish: $1) }, gate)
    }
}
let tls = Request(identity: "tls:https://127.0.0.1:23196", fingerprint: "SHA256:aaa", changed: false)
let ssh = Request(identity: "host:22", fingerprint: "SHA256:bbb", changed: false)
let rotated = Request(identity: tls.identity, fingerprint: "SHA256:ccc", changed: true)

// Case 1: N concurrent callers for one identity produce one presentation and N identical answers.
do {
    let (coordinator, gate) = make()
    let tasks = (0..<6).map { _ in Task { await coordinator.decide(tls) } }
    await settle { gate.openCount == 1 }
    check(gate.presented.count == 1, "case1: six concurrent callers, one presentation")
    gate.answer(true)
    var results: [Bool] = []
    for task in tasks { results.append(await task.value) }
    check(results == Array(repeating: true, count: 6), "case1: every caller received true")
    check(gate.presented.count == 1 && !coordinator.isPresenting, "case1: nothing presented afterwards")
    // The coordinator must not cache decisions: remembering trust is the vault's job, and a false is never stored.
    let again = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }
    check(gate.presented.count == 2, "case1: the same request after an answer prompts again (no decision cache)")
    gate.answer(false)
    check(await again.value == false, "case1: the repeated prompt delivers its own decision")
}

// Case 2: two identities produce two sequential presentations that never overlap; cancel is delivered as false.
do {
    let (coordinator, gate) = make()
    let first = Task { await coordinator.decide(tls) }
    let second = Task { await coordinator.decide(ssh) }
    await settle { gate.openCount == 1 }
    try? await Task.sleep(nanoseconds: 20_000_000)
    check(gate.presented == [tls] && gate.openCount == 1, "case2: only the first identity is on screen")
    gate.answer(true)
    await settle { gate.presented.count == 2 && gate.openCount == 1 }
    check(gate.presented == [tls, ssh], "case2: second identity presented after the first was answered")
    gate.answer(false)
    let results = (await first.value, await second.value)
    check(results == (true, false), "case2: decisions routed to their callers (true, false)")
    check(gate.maxOpen == 1, "case2: prompts never overlapped")
}

// Case 3: a presenter that throws (no presenter available) answers false to every caller.
do {
    let (coordinator, gate) = make()
    gate.failure = Gate.Unavailable()
    let tasks = (0..<3).map { _ in Task { await coordinator.decide(tls) } }
    let queued = Task { await coordinator.decide(ssh) }
    var results: [Bool] = []
    for task in tasks { results.append(await task.value) }
    check(results == [false, false, false], "case3: throwing presenter yields false to all callers")
    check(await queued.value == false, "case3: a request queued behind the failure is answered false, not dropped")
    check(gate.presented.count == 2 && Set(gate.presented) == [tls, ssh], "case3: each distinct request was attempted exactly once")
    gate.failure = nil
    let recovered = Task { await coordinator.decide(ssh) }
    await settle { gate.openCount == 1 }
    gate.answer(true)
    check(await recovered.value == true, "case3: the coordinator keeps working after a failure")
}

// Case 4: generation mismatch answers false, both on entry and when it moves on while the request waits.
do {
    let (coordinator, gate) = make()
    check(await coordinator.decide(tls, isCurrent: { false }) == false, "case4: stale on entry gives false")
    check(gate.presented.isEmpty, "case4: stale on entry presents nothing")
    var generation = 1
    let epoch = generation
    let blocker = Task { await coordinator.decide(ssh) }
    await settle { gate.openCount == 1 }
    let waiting = Task { await coordinator.decide(tls, isCurrent: { generation == epoch }) }
    try? await Task.sleep(nanoseconds: 20_000_000)
    generation += 1
    gate.answer(true)
    check(await waiting.value == false, "case4: generation moved on while queued gives false")
    check(await blocker.value == true && gate.presented == [ssh], "case4: the stale request was never presented")
}

// Case 5: a caller for a second identity arriving while the first prompt is open is presented after the answer.
do {
    let (coordinator, gate) = make()
    let first = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }
    let late = Task { await coordinator.decide(rotated) }
    try? await Task.sleep(nanoseconds: 20_000_000)
    check(gate.presented == [tls] && gate.openCount == 1, "case5: late request waits while the first prompt is open")
    gate.answer(false)
    await settle { gate.presented.count == 2 }
    check(gate.presented == [tls, rotated] && gate.openCount == 1, "case5: changed fingerprint presented after the first was answered")
    gate.answer(true)
    let results = (await first.value, await late.value)
    check(results == (false, true), "case5: each prompt answers its own callers")
}

// Case 6: a caller for the identity whose prompt is already open joins it instead of queueing a second prompt.
do {
    let (coordinator, gate) = make()
    let first = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }
    let joiner = Task { await coordinator.decide(tls) }
    try? await Task.sleep(nanoseconds: 20_000_000)
    gate.answer(true)
    let results = (await first.value, await joiner.value)
    check(results == (true, true) && gate.presented.count == 1, "case6: joiner shares the open prompt and its decision")
}

// Case 7: presentation metadata must not split identical identity/fingerprint requests.
do {
    let (coordinator, gate) = make()
    let first = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }
    let second = Task { await coordinator.decide(Request(identity: tls.identity, fingerprint: tls.fingerprint, changed: true)) }
    try? await Task.sleep(nanoseconds: 20_000_000)
    gate.answer(true)
    let results = (await first.value, await second.value)
    check(results.0 && results.1, "case7: changed metadata shares the decision")
    check(gate.presented.count == 1, "case7: identity and fingerprint are the coalescing key")
}

// Case 8: an active request invalidated after presentation must never authorize a stale connection.
do {
    let (coordinator, gate) = make()
    var current = true
    let waiting = Task { await coordinator.decide(tls, isCurrent: { current }) }
    await settle { gate.openCount == 1 }
    let lateAnswer = gate.lastAnswer
    current = false; coordinator.cancelInvalidRequests()
    check(await waiting.value == false, "case8: active invalidation completes false")
    check(gate.openCount == 0, "case8: active invalidation dismisses the alert")
    lateAnswer?(true); lateAnswer?(false)
    let next = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }; gate.answer(true)
    check(await next.value, "case8: late completion cannot affect a fresh request")
}

// Case 9: closing the page resolves every active and queued caller exactly once.
do {
    let (coordinator, gate) = make()
    let tasks = [tls, tls, ssh, rotated].map { request in Task { await coordinator.decide(request) } }
    await settle { gate.openCount == 1 }
    try? await Task.sleep(nanoseconds: 20_000_000)
    coordinator.cancelAll(); coordinator.cancelAll()
    var results: [Bool] = []
    for task in tasks { results.append(await task.value) }
    check(results == [false, false, false, false], "case9: close drains active and queued callers")
    check(gate.openCount == 0 && !coordinator.isPresenting, "case9: close leaves no presentation")
}

// Case 10: a cancelled waiter does not cancel a live waiter sharing its prompt.
do {
    let (coordinator, gate) = make()
    let cancelled = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }
    let live = Task { await coordinator.decide(tls) }
    try? await Task.sleep(nanoseconds: 20_000_000)
    cancelled.cancel()
    check(await cancelled.value == false, "case10: task cancellation resolves that waiter")
    check(gate.openCount == 1, "case10: live shared waiter retains its prompt")
    gate.answer(true); check(await live.value, "case10: shared live waiter still receives true")
}

// Case 11: simultaneous entries share their enqueue deadline, including those never shown.
do {
    let clock = TestClock(); let (coordinator, gate) = clock.make()
    var entered = 0
    let tasks = [tls, ssh, rotated].map { request in Task { entered += 1; return await coordinator.decide(request) } }
    await settle { entered == 3 && gate.openCount == 1 }
    clock.advance(100)
    var results: [Bool] = []
    for task in tasks { results.append(await task.value) }
    check(results == [false, false, false], "case11: all queued callers finish at their enqueue deadline")
    check(gate.presented == [tls] && gate.openCount == 0, "case11: expired queued entries are never presented")
    let next = Task { await coordinator.decide(ssh) }
    await settle { gate.openCount == 1 }; gate.answer(true)
    check(await next.value && gate.maxOpen == 1, "case11: a new request works after every old entry expires")
}

// Case 12: revalidate the result even if no invalidation notification was delivered.
do {
    let (coordinator, gate) = make()
    var current = true
    let waiting = Task { await coordinator.decide(tls, isCurrent: { current }) }
    await settle { gate.openCount == 1 }
    current = false; gate.answer(true)
    check(await waiting.value == false, "case12: stale final decision is rejected")
}

// Case 13: refusals belong to one load and late callbacks cannot poison a retry or a different fingerprint.
do {
    let load = TrustLoadState(); load.begin(); let old = load.generation
    load.record(false, identity: tls.identity, fingerprint: tls.fingerprint, epoch: old)
    check(load.decision(tls.identity, tls.fingerprint) == false, "case13: refusal cached for repeated challenges")
    check(load.decision(tls.identity, rotated.fingerprint) == nil, "case13: changed fingerprint requires its own decision")
    load.begin(); let next = load.generation
    load.record(false, identity: tls.identity, fingerprint: tls.fingerprint, epoch: old)
    check(load.decision(tls.identity, tls.fingerprint) == nil && load.isCurrent(next), "case13: retry clears refusal and ignores old callback")
    load.close()
    check(!load.isCurrent(next), "case13: leaving invalidates the active load")
}

// Case 14: a late caller joins the original deadline instead of renewing it.
do {
    let clock = TestClock(); let (coordinator, gate) = clock.make()
    let first = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }; clock.advance(80)
    var joined = false
    let second = Task { joined = true; return await coordinator.decide(tls) }
    await settle { joined }; clock.advance(20)
    let results = (await first.value, await second.value)
    check(results == (false, false), "case14: a late joiner expires with the original request")
    check(gate.presented == [tls] && gate.openCount == 0, "case14: a joiner does not cause another prompt")
}

// Case 15: a later distinct entry keeps only the remainder of its original budget when shown.
do {
    let clock = TestClock(); let (coordinator, gate) = clock.make()
    let first = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }; clock.advance(40)
    var entered = false, completed = false
    let next = Task { entered = true; let result = await coordinator.decide(ssh); completed = true; return result }
    await settle { entered }; clock.advance(60)
    check(await first.value == false, "case15: the head expires at its original deadline")
    await settle { gate.presented.count == 2 }
    check(!completed && gate.presented == [tls, ssh], "case15: the queued request starts with remaining time")
    clock.advance(40)
    check(await next.value == false && gate.openCount == 0, "case15: presentation never adds another timeout budget")
}

// Case 16: cancellation and generation changes before expiry cannot leave timers on a new request.
do {
    let clock = TestClock(); let (coordinator, gate) = clock.make()
    var current = true, entered = false
    let first = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }
    let next = Task { entered = true; return await coordinator.decide(ssh, isCurrent: { current }) }
    await settle { entered }; clock.advance(80)
    current = false; first.cancel(); coordinator.cancelInvalidRequests()
    let results = (await first.value, await next.value)
    check(results == (false, false), "case16: cancellation and invalidation complete before the deadline")
    let fresh = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }; clock.advance(20)
    coordinator.cancelInvalidRequests(); gate.answer(true)
    check(await fresh.value, "case16: old deadlines cannot terminate a fresh request")
}

// Case 17: a delayed timeout task cannot let an expired action reach the caller's trust write.
do {
    let clock = TestClock(); let (coordinator, gate) = clock.make()
    var commits = 0
    let pending = Task { let accepted = await coordinator.decide(tls); if accepted { commits += 1 }; return accepted }
    await settle { gate.openCount == 1 }; let late = gate.lastAnswer
    clock.advance(120); late?(true); late?(true)
    check(await pending.value == false && commits == 0, "case17: expired acceptance never reaches the trust commit")
    check(gate.openCount == 0, "case17: expired late acceptance dismisses exactly once")
}

// Case 18: joining an expired entry before its watchdog runs fails closed immediately.
do {
    let clock = TestClock(); let (coordinator, gate) = clock.make()
    let pending = Task { await coordinator.decide(tls) }
    await settle { gate.openCount == 1 }; clock.advance(120)
    let joined = await coordinator.decide(tls)
    let original = await pending.value
    check(!joined && !original, "case18: expired entry and joiner both complete false")
    check(gate.presented == [tls] && gate.openCount == 0, "case18: an expired joiner does not reopen the prompt")
}

print(failures == 0 ? "All TrustPromptCoordinator cases passed" : "\(failures) TrustPromptCoordinator case(s) failed")
exit(failures == 0 ? 0 : 1)
