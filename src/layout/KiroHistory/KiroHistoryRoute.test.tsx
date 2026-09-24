import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, Tree } from "../../types";
const mocks = vi.hoisted(() => ({ list: vi.fn(), watch: vi.fn(), stop: vi.fn(), viewer: vi.fn(), changed: null as null | (() => void) }));
vi.mock("../../ipc/tree", () => ({ listTree: mocks.list }));
vi.mock("../../ipc/events", () => ({ onTreeChanged: mocks.watch }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../sessionViewers/SessionContentViewer", () => ({ SessionContentViewer: (props: { session: Session }) => {
  mocks.viewer(props);
  return <div data-testid="viewer">{props.session.id}<button type="button">viewer-control</button></div>;
} }));
import { KiroHistoryRoute } from "./KiroHistoryRoute";
import { KiroHistoryLink, kiroHistoryUrl, navigateKiroHistory } from "./navigation";

const record = (id: string, kind: Session["kind"] = "kiro") => ({ id, kind, name: `Native ${id}`, engine: "tui" } as Session);
const tree = (...sessions: Session[]) => ({ projects: [], groups: [], sessions } as Tree);
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({ unrelated: 7 }, "", "/?keep=1#anchor");
  mocks.list.mockResolvedValue(tree(record("one"), record("two")));
  mocks.watch.mockImplementation((cb: () => void) => { mocks.changed = cb; return Promise.resolve(mocks.stop); });
});
afterEach(() => { cleanup(); mocks.changed = null; });

describe("Kiro read-only history route", () => {
  it("does no source or tree reads when its query is absent", () => {
    render(<KiroHistoryRoute />);
    expect(screen.queryByRole("dialog")).toBeNull(); expect(mocks.list).not.toHaveBeenCalled();
  });
  it("provides a real link, preserves unrelated URL/state and restores focus after Escape", async () => {
    render(<><KiroHistoryLink sessionId="one" /><KiroHistoryRoute /></>);
    const link = screen.getByRole("link"); link.focus();
    expect(new URL(link.getAttribute("href")!).searchParams.get("kiroHistory")).toBe("one");
    fireEvent.click(link);
    expect((await screen.findByTestId("viewer")).textContent).toContain("one");
    expect(mocks.viewer.mock.calls[0][0].session.kind).toBe("kiro");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "common.close" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("?keep=1"); expect(window.location.hash).toBe("#anchor");
    expect(window.history.state).toEqual({ unrelated: 7 }); expect(document.activeElement).toBe(link);
  });
  it("leaves modifier clicks and explicit new-tab targets to the browser", () => {
    render(<><KiroHistoryLink sessionId="one" /><KiroHistoryLink sessionId="two" target="_blank" /></>);
    fireEvent.click(screen.getAllByRole("link")[0], { ctrlKey: true });
    fireEvent.click(screen.getAllByRole("link")[1]);
    expect(window.location.search).toBe("?keep=1"); expect(mocks.list).not.toHaveBeenCalled();
  });
  it("resolves direct links and follows Back/Forward without selecting a session", async () => {
    navigateKiroHistory(kiroHistoryUrl("one"));
    render(<KiroHistoryRoute />); expect((await screen.findByTestId("viewer")).textContent).toContain("one");
    act(() => navigateKiroHistory(kiroHistoryUrl("two")));
    await waitFor(() => expect(screen.getByTestId("viewer").textContent).toContain("two"));
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(screen.getByTestId("viewer").textContent).toContain("one"));
    await act(async () => { window.history.forward(); });
    await waitFor(() => expect(screen.getByTestId("viewer").textContent).toContain("two"));
  });
  it.each(["missing", "other"]) ("rejects %s targets without reading their content", async id => {
    mocks.list.mockResolvedValue(tree(record("other", "claude")));
    navigateKiroHistory(kiroHistoryUrl(id)); render(<KiroHistoryRoute />);
    expect(await screen.findByText("memory.notFound")).toBeTruthy(); expect(mocks.viewer).not.toHaveBeenCalled();
  });
  it("shows transport failure separately and recovers by retrying the authoritative tree", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Connection unavailable"));
    navigateKiroHistory(kiroHistoryUrl("one")); render(<KiroHistoryRoute />);
    expect((await screen.findByRole("alert")).textContent).toContain("Connection unavailable");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect((await screen.findByTestId("viewer")).textContent).toContain("one"); expect(screen.queryByRole("alert")).toBeNull();
  });
  it("removes a deleted target on tree notification and can recover if it returns", async () => {
    navigateKiroHistory(kiroHistoryUrl("one")); render(<KiroHistoryRoute />);
    await screen.findByTestId("viewer"); mocks.list.mockResolvedValueOnce(tree());
    act(() => mocks.changed?.());
    await screen.findByText("memory.notFound"); expect(screen.queryByTestId("viewer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect((await screen.findByTestId("viewer")).textContent).toContain("one");
  });
  it("ignores stale requests and traps keyboard focus inside the dialog", async () => {
    let finish: (tree: Tree) => void = () => {};
    mocks.list.mockImplementationOnce(() => new Promise<Tree>(resolve => { finish = resolve; }));
    navigateKiroHistory(kiroHistoryUrl("one")); render(<KiroHistoryRoute />);
    expect(screen.getByRole("status").textContent).toContain("common.loading");
    mocks.list.mockResolvedValueOnce(tree()); act(() => mocks.changed?.());
    await screen.findByText("memory.notFound");
    await act(async () => finish(tree(record("one"))));
    expect(screen.queryByTestId("viewer")).toBeNull();
    const retry = screen.getByRole("button", { name: "common.retry" });
    const close = screen.getByRole("button", { name: "common.close" });
    close.focus(); fireEvent.keyDown(close, { key: "Tab" }); expect(document.activeElement).toBe(retry);
    fireEvent.keyDown(retry, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(close);
  });
});
