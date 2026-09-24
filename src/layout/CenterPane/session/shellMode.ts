//! Shell mode in the composer: a message starting with `!` is a command for the session's shell, not a
//! prompt. The pure parts live here so the routing can be tested without rendering the pane.

import type { I18nKey } from "../../../i18n";

/**
 * Read a composer submission as a shell command.
 *
 * `!` after optional leading whitespace, then optional spaces, then the command. `null` for anything
 * else; `{ command: "" }` for a bare `!`, so the caller can show the hint instead of sending nothing.
 */
export function parseShellSubmission(text: string): { command: string } | null {
  const match = /^\s*!\s*([\s\S]*)$/.exec(text);
  return match ? { command: match[1].trim() } : null;
}

/** The composer's wording for a stable backend refusal, or `null` for a message to show verbatim. */
export function shellErrorKey(error: unknown): I18nKey | null {
  const text = String(error);
  if (text.includes("chat_shell_running")) return "chat.shell.alreadyRunning";
  if (text.includes("chat_shell_empty")) return "chat.shell.emptyCommand";
  return null;
}

export interface ShellSubmission {
  sessionId: string;
  command: string;
  id: string;
  pending: boolean;
}

const shellSubmissions = new Map<string, ShellSubmission>();
const shellSubmissionKey = (session: string, command: string) =>
  `vlx-shell-submission:${JSON.stringify([session, command])}`;

/** Retain an unacknowledged identity across panes and page reloads. This never dispatches on its own;
 * only the backend receipt can confirm execution, and only an explicit send retries the same command. */
export function shellSubmissionFor(session: string, command: string): ShellSubmission {
  const key = shellSubmissionKey(session, command);
  const current = shellSubmissions.get(key);
  if (current) return current;
  let id: string | null = null;
  try { id = sessionStorage.getItem(key); } catch { /* Storage can be unavailable in private views. */ }
  if (!id || !/^sh-[0-9a-f-]{36}$/i.test(id)) id = `sh-${crypto.randomUUID()}`;
  const submission = { sessionId: session, command, id, pending: false };
  shellSubmissions.set(key, submission);
  try { sessionStorage.setItem(key, id); } catch { /* In-memory retries retain the same identity. */ }
  return submission;
}

export function acknowledgeShellSubmission(submission: ShellSubmission) {
  const key = shellSubmissionKey(submission.sessionId, submission.command);
  if (shellSubmissions.get(key)?.id === submission.id) shellSubmissions.delete(key);
  try { if (sessionStorage.getItem(key) === submission.id) sessionStorage.removeItem(key); } catch { /* No persisted receipt. */ }
}
