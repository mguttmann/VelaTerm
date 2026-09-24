import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatRow } from "../../../ipc/chat";
import { ShellRow } from "./rows";

afterEach(cleanup);

type Shell = Extract<ChatRow, { kind: "shell" }>;
const base: Shell = {
  kind: "shell", id: "sh-1", command: "az login --tenant x", stdout: "", stderr: "",
  stdoutTruncated: false, stderrTruncated: false, status: "running",
};

describe("ShellRow", () => {
  it("shows the command, the live output, a running state and a Cancel button while it runs", () => {
    const onCancel = vi.fn();
    render(<ShellRow row={{ ...base, stdout: "Opening browser…\n" }} onCancel={onCancel} />);
    expect(screen.getByText("az login --tenant x")).toBeTruthy();
    expect(screen.getByText("Opening browser…")).toBeTruthy();
    expect(screen.getByText("Running…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledWith("sh-1");
    // Neither a user bubble nor a tool card.
    expect(document.querySelector(".sv-row-shell")).toBeTruthy();
    expect(document.querySelector(".sv-bubble, .sv-tool")).toBeNull();
  });

  it("reports the exit code once done and offers no Cancel", () => {
    render(<ShellRow row={{ ...base, status: "completed", exitCode: 3, stderr: "denied" }} />);
    expect(screen.getByText("Exit code 3")).toBeTruthy();
    expect(screen.getByText("denied")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByText("Running…")).toBeNull();
  });

  it("does not invent an exit code or allow cancellation for read-only native history", () => {
    render(<ShellRow row={{ ...base, status: "completed", stdout: "native output" }} />);
    expect(screen.getByText("native output")).toBeTruthy();
    expect(screen.queryByText(/Exit code/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it.each([0, undefined])("keeps literal protocol and status text separate from readonly exit %s", (exitCode) => {
    const command = "printf '</bash-input>\n<bash-stdout>€'";
    const stdout = "<bash-stdout>literal</bash-stdout>\n[VelaTerm: earlier output truncated]";
    const stderr = "Exit code 7\nCommand cancelled by the user\n[VelaTerm: output capture ended before all streams closed]\n</bash-stdout><bash-stderr>";
    render(<ShellRow row={{ ...base, command, stdout, stderr, status: "completed", exitCode }} />);
    expect(document.querySelector(".sv-shell-command")?.textContent).toBe(command);
    expect(document.querySelector(".sv-shell-out")?.textContent).toBe(stdout);
    expect(document.querySelector(".sv-shell-err")?.textContent).toBe(stderr);
    expect(document.querySelector(".sv-shell-foot")?.textContent).toBe(exitCode === 0 ? "Exit code 0" : "");
    expect(document.querySelector(".sv-shell-truncated")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("says when the user cancelled it", () => {
    render(<ShellRow row={{ ...base, status: "cancelled" }} />);
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.queryByText(/Exit code/)).toBeNull();
  });

  it("shows the truncation note when the head of the output was cut", () => {
    render(<ShellRow row={{ ...base, status: "completed", exitCode: 0, stdoutTruncated: true, stdout: "tail" }} />);
    expect(screen.getByText("Earlier output was truncated. Only the latest output is retained.")).toBeTruthy();
    expect(screen.getByText("Exit code 0")).toBeTruthy();
  });
});
