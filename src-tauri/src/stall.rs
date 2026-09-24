//! Main-thread stall detection.
//!
//! Everything a user reports as "the window froze" ends in the same place: the platform event loop stopped
//! running. Synchronous commands, native window calls and every WebView script evaluation execute there, so
//! a single slow call blocks drawing and input for every window at once. Nothing else in the log says
//! whether that happened, because the threads that keep writing are precisely the ones that are fine.
//!
//! A background thread posts a closure to the main thread once per second and measures the round trip.
//! `diagnostics::record` hands its line to a dedicated writer thread and never blocks the caller, so a
//! report still reaches the log file while the main thread is stuck.
//!
//! The mechanism is identical on macOS, Linux and Windows; only the cost of the work that blocks the loop
//! differs between them. It reports that the loop stopped, never what stopped it — pair a stall with the
//! `ui_thread_slow`, `pty_lock`, `pty_resize_slow` and `pty_fanout_slow` lines carrying the same timestamp
//! to name the operation.
//!
//! Two situations look like stalls without being defects. macOS runs a nested event loop while a menu is
//! held open and while a window is being dragged or live-resized, and queued work waits for that loop to
//! finish. The threshold below is set high enough that ordinary interaction stays quiet, but a menu held
//! open for several seconds still produces a line.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::AppHandle;

/// Interval between probes. One trivial closure per second is invisible next to the event loop's own load.
const PROBE_INTERVAL: Duration = Duration::from_secs(1);
/// Delay at which a probe counts as a stall. One second is already plainly perceptible and well clear of
/// both ordinary scheduling and the nested loops described above, while Windows waits a further four
/// seconds before greying the window out — that interval is the part that needs to become visible.
const STALL_THRESHOLD_MS: u64 = 1_000;
/// Repeat interval while one stall is still unfinished, so an indefinite hang leaves a trail instead of a
/// single line whose end never arrives.
const STALL_REPEAT_MS: u64 = 5_000;

/// Starts the watchdog. It runs for the process lifetime and stops when the event loop refuses further work.
pub fn start(app: AppHandle) {
    let origin = Instant::now();
    // Milliseconds since `origin` at which the outstanding probe was queued; zero means none is in flight.
    let queued_at = Arc::new(AtomicU64::new(0));
    // Stall duration already reported for the outstanding probe, so repeats are spaced rather than continuous.
    let reported = Arc::new(AtomicU64::new(0));
    let spawned = std::thread::Builder::new()
        .name("main-thread-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(PROBE_INTERVAL);
            let now = origin.elapsed().as_millis() as u64;
            let outstanding = queued_at.load(Ordering::SeqCst);
            if outstanding != 0 {
                // The previous probe has not run yet, so the main thread is blocked right now. Report while
                // it is still happening: the recovery line alone would be lost if the process is killed.
                let blocked = now.saturating_sub(outstanding);
                let last = reported.load(Ordering::SeqCst);
                if blocked >= STALL_THRESHOLD_MS
                    && (last == 0 || blocked.saturating_sub(last) >= STALL_REPEAT_MS)
                {
                    reported.store(blocked, Ordering::SeqCst);
                    crate::diagnostics::record(
                        "WARN",
                        "main_thread_stall",
                        json!({"status":"blocked","blockedMs":blocked}),
                    );
                }
                continue;
            }
            // Zero marks "no probe in flight", so a queue time of zero is nudged to one millisecond.
            queued_at.store(now.max(1), Ordering::SeqCst);
            reported.store(0, Ordering::SeqCst);
            let queued = Arc::clone(&queued_at);
            let cleared = Arc::clone(&reported);
            let posted = app.run_on_main_thread(move || {
                let delay = (origin.elapsed().as_millis() as u64)
                    .saturating_sub(queued.swap(0, Ordering::SeqCst));
                cleared.store(0, Ordering::SeqCst);
                // Recovery carries the full duration, which the periodic lines above cannot know yet.
                if delay >= STALL_THRESHOLD_MS {
                    crate::diagnostics::record(
                        "WARN",
                        "main_thread_stall",
                        json!({"status":"recovered","blockedMs":delay}),
                    );
                }
            });
            if posted.is_err() {
                break; // The event loop is gone; the application is shutting down.
            }
        });
    if spawned.is_err() {
        crate::diagnostic_warn!("main-thread watchdog failed to start");
    }
}
