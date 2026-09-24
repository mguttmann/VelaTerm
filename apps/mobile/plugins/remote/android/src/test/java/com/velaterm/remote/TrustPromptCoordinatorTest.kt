package com.velaterm.remote

import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class TrustPromptCoordinatorTest {
    private class Fixture {
        data class Event(val at: Long, val action: () -> Unit, var cancelled: Boolean = false)
        var now = 0L
        val events = mutableListOf<Event>()
        val shown = mutableListOf<TrustPromptCoordinator.Request>()
        val open = mutableListOf<(Boolean) -> Unit>()
        var maxOpen = 0
        var throws = false
        var dismissalThrows = false
        val coordinator = TrustPromptCoordinator({ delay, action ->
            val event = Event(now + delay, action); events.add(event)
            val cancel: () -> Unit = { event.cancelled = true }; cancel
        }, { request, answer ->
            if (throws) throw IllegalStateException("presenter unavailable")
            shown.add(request); open.add(answer); maxOpen = maxOf(maxOpen, open.size)
            val dismiss: () -> Unit = {
                open.remove(answer)
                if (dismissalThrows) throw IllegalStateException("dismissal unavailable")
            }; dismiss
        }, 100, { now })
        fun tick(milliseconds: Long = 0) {
            val end = now + milliseconds
            var count = 0
            while (true) {
                val event = events.filter { !it.cancelled && it.at <= end }.minByOrNull { it.at } ?: break
                check(count++ < 1000)
                events.remove(event); now = event.at; event.action()
            }
            now = end
        }
        fun answer(value: Boolean) { open.first()(value); tick() }
    }
    private val tls = TrustPromptCoordinator.Request("tls:https://127.0.0.1:23196", "SHA256:aaa", false)
    private val ssh = TrustPromptCoordinator.Request("host:22", "SHA256:bbb", false)

    @Test fun concurrentIdenticalRequestsShareOnePromptIncludingMetadataChanges() {
        val f = Fixture(); val results = mutableListOf<Boolean>()
        repeat(6) { f.coordinator.decide(tls.copy(changed = it % 2 == 0), { true }) { results.add(it) } }
        f.tick(); assertEquals(1, f.shown.size)
        f.answer(true); assertEquals(List(6) { true }, results); assertTrue(f.open.isEmpty())
    }
    @Test fun differentFingerprintsAndIdentitiesAreSerialized() {
        val f = Fixture(); val results = mutableListOf<Boolean>()
        for (request in listOf(tls, ssh, tls.copy(fingerprint = "SHA256:new", changed = true))) {
            f.coordinator.decide(request, { true }) { results.add(it) }
        }
        f.tick(); assertEquals(listOf(tls), f.shown)
        f.answer(false); f.answer(true); f.answer(true)
        assertEquals(listOf(false, true, true), results); assertEquals(1, f.maxOpen)
    }
    @Test fun invalidationDrainsActiveAndQueuedWaitersAndIgnoresLateActions() {
        val f = Fixture(); val results = mutableListOf<Boolean>(); var current = true
        f.coordinator.decide(tls, { current }) { results.add(it) }
        f.coordinator.decide(ssh, { current }) { results.add(it) }
        f.tick(); val late = f.open.single()
        current = false; f.coordinator.invalidate(); f.tick(); late(true); late(false)
        assertEquals(listOf(false, false), results); assertTrue(f.open.isEmpty())
    }
    @Test fun finalValidityCheckRejectsAStaleApprovalWithoutAnInvalidationSignal() {
        val f = Fixture(); var current = true; var result: Boolean? = null
        f.coordinator.decide(tls, { current }) { result = it }; f.tick()
        current = false; f.answer(true); assertEquals(false, result)
    }
    @Test fun presenterFailureAnswersEveryWaiterAndTheQueueRecovers() {
        val f = Fixture(); f.throws = true; val results = mutableListOf<Boolean>()
        repeat(3) { f.coordinator.decide(tls, { true }) { results.add(it) } }
        f.tick(); assertEquals(List(3) { false }, results)
        f.throws = false; f.coordinator.decide(ssh, { true }) { results.add(it) }
        f.tick(); f.answer(true); assertEquals(true, results.last())
    }
    @Test fun simultaneousQueuedRequestsExpireWithoutAnotherFullPresentationTimeout() {
        val f = Fixture(); val results = mutableListOf<Boolean>()
        for (request in listOf(tls, ssh, tls.copy(fingerprint = "SHA256:new"))) {
            f.coordinator.decide(request, { true }) { results.add(it) }
        }
        f.tick(100)
        assertEquals(List(3) { false }, results); assertEquals(listOf(tls), f.shown)
        assertTrue(f.open.isEmpty())
        f.coordinator.decide(ssh, { true }) { results.add(it) }; f.tick(); f.answer(true)
        assertEquals(listOf(false, false, false, true), results); assertEquals(1, f.maxOpen)
    }
    @Test fun laterJoinersCannotRenewTheFirstWaitersDeadline() {
        val f = Fixture(); val results = mutableListOf<Boolean>()
        f.coordinator.decide(tls, { true }) { results.add(it) }; f.tick(80)
        f.coordinator.decide(tls.copy(changed = true), { true }) { results.add(it) }
        f.tick(19); assertTrue(results.isEmpty())
        f.tick(1); assertEquals(listOf(false, false), results); assertEquals(listOf(tls), f.shown)
    }
    @Test fun theNextPresentationGetsOnlyItsRemainingQueueBudget() {
        val f = Fixture(); val results = mutableListOf<Boolean>()
        f.coordinator.decide(tls, { true }) { results.add(it) }; f.tick(40)
        f.coordinator.decide(ssh, { true }) { results.add(it) }; f.tick(60)
        assertEquals(listOf(false), results); assertEquals(listOf(tls, ssh), f.shown)
        f.tick(39); assertEquals(listOf(false), results)
        f.tick(1); assertEquals(listOf(false, false), results); assertTrue(f.open.isEmpty())
    }
    @Test fun cancellingAndInvalidatingBeforeExpiryCannotLeaveTimersAffectingNewRequests() {
        val f = Fixture(); val results = mutableListOf<Boolean>(); val id = UUID.randomUUID(); var current = true
        f.coordinator.decide(tls, { true }, id) { results.add(it) }
        f.coordinator.decide(ssh, { current }) { results.add(it) }; f.tick(80)
        current = false; f.coordinator.cancel(id); f.coordinator.invalidate(); f.tick()
        assertEquals(listOf(false, false), results)
        f.coordinator.decide(tls, { true }) { results.add(it) }; f.tick(20)
        assertEquals(1, f.open.size); f.answer(true)
        assertEquals(listOf(false, false, true), results)
    }
    @Test fun expiredAcceptanceNeverReachesTheTrustCommitEvenWhenTheTimerIsDelayed() {
        val f = Fixture(); var commits = 0; val results = mutableListOf<Boolean>()
        f.coordinator.decide(tls, { true }) { if (it) commits++; results.add(it) }; f.tick()
        val late = f.open.single(); f.now = 120
        late(true); late(true)
        assertEquals(0, commits); assertEquals(listOf(false), results); assertTrue(f.open.isEmpty())
    }
    @Test fun aJoinerAfterExpiryCompletesTheExpiredEntryWithoutShowingItAgain() {
        val f = Fixture(); val results = mutableListOf<Boolean>()
        f.coordinator.decide(tls, { true }) { results.add(it) }; f.tick()
        f.now = 120
        f.coordinator.decide(tls, { true }) { results.add(it) }
        assertEquals(listOf(false, false), results); assertEquals(listOf(tls), f.shown)
    }
    @Test fun cancellationRemovesOnlyItsWaiterAndRepeatedCallbacksAreIgnored() {
        val f = Fixture(); val results = mutableListOf<Boolean>(); val id = UUID.randomUUID()
        f.coordinator.decide(tls, { true }, id) { results.add(it) }
        f.coordinator.decide(tls, { true }) { results.add(it) }
        f.tick(); val late = f.open.single()
        f.coordinator.cancel(id); f.coordinator.cancel(id)
        assertEquals(1, f.open.size); f.answer(true); late(false)
        assertEquals(listOf(false, true), results)
    }
    @Test fun closeIsIdempotentAndDismissalFailureDoesNotStrandWaiters() {
        val f = Fixture(); f.dismissalThrows = true; val results = mutableListOf<Boolean>()
        f.coordinator.decide(tls, { true }) { results.add(it) }
        f.coordinator.decide(ssh, { true }) { results.add(it) }
        f.tick(); f.coordinator.close(); f.coordinator.close(); f.tick()
        assertEquals(listOf(false, false), results); assertTrue(f.open.isEmpty())
    }
    @Test fun staleRequestNeverShowsAPrompt() {
        val f = Fixture(); var result: Boolean? = null
        f.coordinator.decide(tls, { false }) { result = it }; f.tick()
        assertEquals(false, result); assertTrue(f.shown.isEmpty())
    }
    @Test fun retryDropsDecisionsAndLateCallbacksCannotPoisonTheNewLoad() {
        val load = TrustLoadState(); val old = load.begin()
        load.record(old, tls.identity, tls.fingerprint, false)
        assertEquals(false, load.decision(tls.identity, tls.fingerprint))
        assertNull(load.decision(tls.identity, "SHA256:new"))
        val next = load.begin(); load.record(old, tls.identity, tls.fingerprint, false)
        assertNull(load.decision(tls.identity, tls.fingerprint)); assertTrue(load.isCurrent(next))
        load.close(); assertFalse(load.isCurrent(next))
    }
}
