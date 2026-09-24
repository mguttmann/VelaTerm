package com.velaterm.remote

import java.util.UUID

/** All methods and presenter callbacks run on the UI executor supplied by the owner. */
internal class TrustPromptCoordinator(
    private val schedule: (Long, () -> Unit) -> (() -> Unit),
    private val presenter: (Request, (Boolean) -> Unit) -> (() -> Unit),
    private val timeoutMillis: Long = 90_000,
    private val nowMillis: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    data class Request(val identity: String, val fingerprint: String, val changed: Boolean)
    private data class Waiter(val id: UUID, val current: () -> Boolean, val complete: (Boolean) -> Unit)
    private class Entry(val request: Request, val deadline: Long) {
        val waiters = mutableListOf<Waiter>()
        var dismiss: (() -> Unit)? = null
        var timeout: (() -> Unit)? = null
        var finished = false
    }
    private val queue = mutableListOf<Entry>()
    private var active: Entry? = null

    fun decide(request: Request, current: () -> Boolean, id: UUID = UUID.randomUUID(), complete: (Boolean) -> Unit) {
        if (!current()) { complete(false); return }
        val entry = (listOfNotNull(active) + queue).firstOrNull {
            !it.finished && it.request.identity == request.identity && it.request.fingerprint == request.fingerprint
        } ?: Entry(request, nowMillis() + timeoutMillis).also {
            queue.add(it)
            // Joining callers share this original deadline, including time spent waiting in the queue.
            it.timeout = schedule(timeoutMillis) { finish(it, false) }
        }
        entry.waiters.add(Waiter(id, current, complete))
        if (nowMillis() >= entry.deadline) { finish(entry, false); return }
        schedule(0) { startNext() }
    }
    fun invalidate() {
        for (entry in queue.toList() + listOfNotNull(active)) {
            if (nowMillis() >= entry.deadline) { finish(entry, false); continue }
            val stale = entry.waiters.filter { !it.current() }
            entry.waiters.removeAll(stale.toSet())
            stale.forEach { it.complete(false) }
            if (entry.waiters.isEmpty()) finish(entry, false)
        }
    }
    fun cancel(id: UUID) {
        for (entry in queue.toList() + listOfNotNull(active)) {
            val waiter = entry.waiters.firstOrNull { it.id == id } ?: continue
            entry.waiters.remove(waiter); waiter.complete(false)
            if (entry.waiters.isEmpty()) finish(entry, false)
            return
        }
    }
    fun close() {
        val pending = queue.toList(); queue.clear()
        for (entry in pending + listOfNotNull(active)) finish(entry, false)
    }
    private fun startNext() {
        if (active != null) return
        while (queue.isNotEmpty()) {
            val entry = queue.removeAt(0)
            if (entry.finished) continue
            active = entry; invalidate()
            if (entry.finished) continue
            try {
                val dismiss = presenter(entry.request) { finish(entry, it) }
                if (entry.finished) dismiss() else entry.dismiss = dismiss
            } catch (_: Exception) { finish(entry, false) }
            return
        }
    }
    private fun finish(entry: Entry, decision: Boolean) {
        if (entry.finished) return
        val accepted = decision && nowMillis() < entry.deadline
        entry.finished = true
        entry.timeout?.invoke(); entry.timeout = null
        try { entry.dismiss?.invoke() } catch (_: Exception) { } finally { entry.dismiss = null }
        val waiters = entry.waiters.toList(); entry.waiters.clear()
        queue.remove(entry)
        if (active === entry) active = null
        for (waiter in waiters) waiter.complete(accepted && waiter.current())
        schedule(0) { startNext() }
    }
}

/** Thread-safe load identity is checked again while holding the lock used for committing trust. */
internal class TrustLoadState {
    private var generation = 0
    private var closed = false
    private val decisions = mutableMapOf<Pair<String, String>, Boolean>()
    @Synchronized fun begin(): Int { generation++; closed = false; decisions.clear(); return generation }
    @Synchronized fun close() { generation++; closed = true; decisions.clear() }
    @Synchronized fun epoch(): Int = generation
    @Synchronized fun isCurrent(epoch: Int) = !closed && generation == epoch
    @Synchronized fun decision(identity: String, fingerprint: String): Boolean? = decisions[identity to fingerprint]
    @Synchronized fun record(epoch: Int, identity: String, fingerprint: String, decision: Boolean) {
        if (isCurrent(epoch)) decisions[identity to fingerprint] = decision
    }
}
