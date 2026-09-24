//! A session's `vrun` commands: the brief each session record carries, and the actions offered on it.
//!
//! Neither command belongs in `DIRECT_DESKTOP_CMDS`: both read or signal on disk, so they travel through
//! `desktop_call` like every other data command, on the desktop and in a remote browser alike.
import { invoke } from "./transport";

/** One command a session started with `vrun` that is still running. */
export interface BackgroundRun {
  label: string;
  /** The command line as given to `vrun`. */
  command: string;
  /** Milliseconds since the epoch. */
  startedAt: number;
}

/** The end of a run's log, and whether the run is still going. */
export interface RunLog {
  text: string;
  running: boolean;
  /** Present once the run has ended and `vrun` recorded how. */
  exitCode: number | null;
}

export function runLogTail(label: string): Promise<RunLog> {
  return invoke<RunLog>("run_log_tail", { label });
}

/** Stop a run and every process it started. */
export function runStop(label: string): Promise<void> {
  return invoke<void>("run_stop", { label });
}
