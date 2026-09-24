import { describe, expect, it } from "vitest";

import { parseShellSubmission, shellErrorKey, shellSubmissionFor, acknowledgeShellSubmission } from "./shellMode";

describe("parseShellSubmission", () => {
  it("takes everything after a leading ! as the command, trimmed", () => {
    expect(parseShellSubmission("!ls -la")).toEqual({ command: "ls -la" });
    expect(parseShellSubmission("  !  az login --tenant x ")).toEqual({ command: "az login --tenant x" });
    expect(parseShellSubmission("!echo 'a  b' | wc")).toEqual({ command: "echo 'a  b' | wc" });
  });

  it("reports a bare ! as an empty command rather than nothing", () => {
    expect(parseShellSubmission("!")).toEqual({ command: "" });
    expect(parseShellSubmission("!   ")).toEqual({ command: "" });
  });

  it("leaves prose alone, including a ! later in the text", () => {
    expect(parseShellSubmission("echo !x")).toBeNull();
    expect(parseShellSubmission("Hello! How are you")).toBeNull();
    expect(parseShellSubmission("")).toBeNull();
  });
});

describe("shellErrorKey", () => {
  it("maps the stable backend refusals and nothing else", () => {
    expect(shellErrorKey(new Error("chat_shell_running"))).toBe("chat.shell.alreadyRunning");
    expect(shellErrorKey("chat_shell_empty")).toBe("chat.shell.emptyCommand");
    expect(shellErrorKey("Failed to start the shell")).toBeNull();
  });
});


describe("shell submission identity", () => {
  it("retains unacknowledged commands independently and admits one pending send across panes", () => {
    const session = crypto.randomUUID();
    const first = shellSubmissionFor(session, "echo first");
    first.pending = true;
    expect(shellSubmissionFor(session, "echo first")).toBe(first);
    expect(shellSubmissionFor(session, "echo first").pending).toBe(true);
    const other = shellSubmissionFor(session, "echo second");
    expect(other.id).not.toBe(first.id);
    expect(shellSubmissionFor(session, "echo first").id).toBe(first.id);
    acknowledgeShellSubmission(first);
    expect(shellSubmissionFor(session, "echo first").id).not.toBe(first.id);
    acknowledgeShellSubmission(other);
  });

  it("uses the retained session-storage id after a page reload", () => {
    const session = crypto.randomUUID();
    const id = `sh-${crypto.randomUUID()}`;
    sessionStorage.setItem(`vlx-shell-submission:${JSON.stringify([session, "echo reload"])}`, id);
    const restored = shellSubmissionFor(session, "echo reload");
    expect(restored.id).toBe(id);
    expect(restored.pending).toBe(false);
    acknowledgeShellSubmission(restored);
  });
});
