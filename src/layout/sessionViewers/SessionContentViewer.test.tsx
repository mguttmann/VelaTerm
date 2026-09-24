import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Session } from "../../types";
import type { TranscriptMessage } from "../../ipc/commands";
import { SessionContentViewer } from "./SessionContentViewer";

const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../ipc/commands", () => ({ readAgentTranscript: api.read }));
vi.mock("../../i18n", () => ({ t: (key: string) => key }));
vi.mock("./RecordingViewer", () => ({ RecordingViewer: () => <div>Recording fallback</div> }));
vi.mock("./TranscriptViewer", () => ({ TranscriptViewer: ({ messages }: { messages: TranscriptMessage[] }) =>
  <div>{messages.length ? messages.map(message => message.text).join("\n") : "Empty transcript"}</div> }));

const session = { id: "kiro-history", kind: "kiro", engine: "tui" } as Session;
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("Kiro history errors", () => {
  it("prioritizes recording over a failed transcript and then renders the current preload", async () => {
    api.read.mockRejectedValue("Old failure");
    const view = render(<SessionContentViewer session={session} />);
    await screen.findByRole("alert");
    view.rerender(<SessionContentViewer session={session} source="recording" />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Recording fallback")).toBeTruthy();
    const messages = [{ role: "assistant", text: "Fresh preload", timestamp: null, tools: [] }] as TranscriptMessage[];
    view.rerender(<SessionContentViewer session={session} source="transcript" preloadedMessages={messages} />);
    expect(screen.getByText("Fresh preload")).toBeTruthy();
    expect(screen.queryByText("Recording fallback")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reflects changed preloaded content without keeping the first array", () => {
    const message = (text: string) => [{ role: "assistant", text, timestamp: null, tools: [] }] as TranscriptMessage[];
    const view = render(<SessionContentViewer session={session} preloadedMessages={message("First")} />);
    view.rerender(<SessionContentViewer session={session} preloadedMessages={message("Second")} />);
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.queryByText("First")).toBeNull();
    expect(api.read).not.toHaveBeenCalled();
  });

  it("ignores a late failure after selecting a recording hit", async () => {
    let reject!: (reason: string) => void;
    api.read.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const view = render(<SessionContentViewer session={session} />);
    view.rerender(<SessionContentViewer session={session} source="recording" />);
    await act(async () => { reject("Late failure"); });
    expect(screen.getByText("Recording fallback")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not let a late old session response replace another session", async () => {
    let resolve!: (value: TranscriptMessage[]) => void;
    api.read.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    api.read.mockResolvedValueOnce([{ role: "assistant", text: "Second session", tools: [] }]);
    const view = render(<SessionContentViewer session={session} />);
    view.rerender(<SessionContentViewer session={{ ...session, id: "other" }} />);
    await screen.findByText("Second session");
    await act(async () => { resolve([{ role: "assistant", text: "Late old session", timestamp: null, tools: [] }]); });
    expect(screen.queryByText("Late old session")).toBeNull();
    expect(screen.getByText("Second session")).toBeTruthy();
  });

  it("does not reread when moving between hits of the same session and source", async () => {
    api.read.mockResolvedValue([{ role: "assistant", text: "Matched transcript", tools: [] }]);
    const view = render(<SessionContentViewer session={session} source="transcript" scrollToMessageIndex={0} />);
    await screen.findByText("Matched transcript");
    view.rerender(<SessionContentViewer session={session} source="transcript" scrollToMessageIndex={1} highlightTerms={["Matched"]} />);
    expect(api.read).toHaveBeenCalledOnce();
  });

  it("clears old nonempty content when the next session is empty", async () => {
    api.read.mockResolvedValueOnce([{ role: "assistant", text: "Old contents", tools: [] }]).mockResolvedValueOnce([]);
    const view = render(<SessionContentViewer session={session} />);
    await screen.findByText("Old contents");
    view.rerender(<SessionContentViewer session={{ ...session, id: "empty" }} />);
    expect(screen.queryByText("Old contents")).toBeNull();
    expect(await screen.findByText("Empty transcript")).toBeTruthy();
  });
  it("keeps the backend reason visible beside recording fallback", async () => {
    api.read.mockRejectedValue("Kiro record contains unsupported non-text content");
    render(<SessionContentViewer session={session} />);
    expect((await screen.findByRole("alert")).textContent).toContain("unsupported non-text content");
    expect(screen.getByText("Recording fallback")).toBeTruthy();
  });

  it("shows a successfully read empty Kiro transcript without falling back", async () => {
    api.read.mockResolvedValue([]);
    render(<SessionContentViewer session={session} />);
    expect(await screen.findByText("Empty transcript")).toBeTruthy();
    expect(screen.queryByText("Recording fallback")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rechecks an empty search cache so a cached failure is not presented as an empty record", async () => {
    api.read.mockRejectedValue("Kiro record is corrupt");
    render(<SessionContentViewer session={session} source="transcript" preloadedMessages={[]} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Kiro record is corrupt");
    expect(api.read).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(screen.queryByText("Empty transcript")).toBeNull();
  });

  it("uses a nonempty Kiro transcript cache without another read", () => {
    const messages = [{ role: "assistant", text: "Cached Kiro message", timestamp: null, tools: [] }] as TranscriptMessage[];
    render(<SessionContentViewer session={session} preloadedMessages={messages} />);
    expect(screen.getByText("Cached Kiro message")).toBeTruthy();
    expect(api.read).not.toHaveBeenCalled();
  });

  it("preserves silent recording fallback for other providers' read errors", async () => {
    api.read.mockRejectedValue("Missing transcript");
    render(<SessionContentViewer session={{ ...session, kind: "claude" }} />);
    expect(await screen.findByText("Recording fallback")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves other providers' empty-cache fallback without another read", () => {
    render(<SessionContentViewer session={{ ...session, kind: "codex" }} preloadedMessages={[]} />);
    expect(screen.getByText("Recording fallback")).toBeTruthy();
    expect(api.read).not.toHaveBeenCalled();
  });
});
