//! Exercise initial URL recovery against the real store, layout restore and mirror alignment gate.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBackgroundTask } from "../../../ipc/chat";
import type { MirrorStatus } from "../../../ipc/mirror";
import type { MirrorLayoutSource } from "../../../store/mirrorLayout";
import type { Session, Tree } from "../../../types";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("../../../ipc/transport", async (original) => ({
  ...await original<typeof import("../../../ipc/transport")>(),
  isTauri: false, invoke: ipc.invoke, listen: ipc.listen,
  getClientSource: () => "ws-test", diagnosticEvent: vi.fn(),
  onTransportReconnect: vi.fn(() => vi.fn()), onTransportDisconnect: vi.fn(() => vi.fn()),
}));
vi.mock("../../../platform", () => {
  const env = { kind: "browser", isBrowser: true, isTauri: false, isElectron: false,
    isRemoteWindow: false, hasNativeHost: false, isMac: false };
  return { env, platform: { env } };
});
vi.mock("../../../mobile/detect", () => ({ isMobileView: () => false }));
vi.mock("../../../notify", () => ({ notify: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const session = (id: string): Session => ({
  id, projectId: "p", groupId: null, name: id, kind: "claude", shell: null, cwd: "/tmp",
  envJson: null, initCmd: null, hotkey: null, parentSessionId: null, collapsed: false,
  worktreePath: null, sortOrder: 0, createdAt: 0,
});
const tree: Tree = {
  projects: [{ id: "p", name: "Project", rootPath: "/tmp", color: null, sortOrder: 0, collapsed: false, createdAt: 0 }],
  groups: [], sessions: [session("A"), session("B")],
};
const savedLayout = (normal: boolean): Pick<MirrorLayoutSource,
  "openTabs" | "liveTabs" | "pinnedTabs" | "activeTabId" | "activeSessionId" | "focusedPaneId" | "paneTrees"> => ({
  openTabs: normal ? ["A"] : [], liveTabs: [], pinnedTabs: [],
  activeTabId: normal ? "A" : null, activeSessionId: normal ? "B" : null,
  focusedPaneId: normal ? "right" : null,
  paneTrees: normal ? { A: { kind: "split" as const, paneId: "split", dir: "horizontal" as const,
    sizes: [50, 50] as [number, number], a: { kind: "leaf" as const, paneId: "left", sessionId: "A" },
    b: { kind: "leaf" as const, paneId: "right", sessionId: "B" } } } : {},
});
const url = (task = "job", sid = "B") => `/?taskSession=${sid}&taskId=${task}&keep=1`;
const mirrorOff: MirrorStatus = { enabled: false, clients: 0, rev: 0, source: "", state: null };
const backendTask: ChatBackgroundTask = {
  task_id: "job", task_type: "local_agent", description: "Backend task", status: "completed",
  finished: true, can_stop: false, elapsed_ms: 1200,
};
let stopMirror: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  ipc.invoke.mockReset();
  ipc.listen.mockReset().mockResolvedValue(() => {});
});
afterEach(() => {
  cleanup();
  stopMirror?.();
  stopMirror = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function boot(normal = false, href = url(), tasks: ChatBackgroundTask[] = [backendTask]) {
  localStorage.setItem("vlx-layout", JSON.stringify(savedLayout(normal)));
  window.history.replaceState(null, "", href);
  const treeReply = deferred<Tree>();
  const mirrorReply = deferred<MirrorStatus>();
  ipc.invoke.mockImplementation((command: string) => {
    if (command === "list_tree") return treeReply.promise;
    if (command === "mirror_get") return mirrorReply.promise;
    if (command === "mirror_push") return Promise.resolve({ rev: 2, source: "ws-test", state: null });
    if (command === "chat_snapshot") return Promise.resolve({ running: false, rows: [], backgroundTasks: tasks });
    return Promise.resolve(undefined);
  });
  const { useTermStore: store } = await import("../../../store/termStore");
  const { startMirrorSync } = await import("../../../store/mirrorSync");
  const { buildMirrorLayout } = await import("../../../store/mirrorLayout");
  const { TaskNavigation } = await import("./taskNavigation");
  const { TaskView } = await import("./TaskView");
  const { memoryNavigate } = await import("../../Memory/navigation");
  const { setLang } = await import("../../../i18n");
  setLang("en");
  const openTask = vi.spyOn(store.getState(), "openTaskTab");
  function Surface() {
    const active = store((s) => s.activeTabId ? s.taskTabs[s.activeTabId] : undefined);
    return <><TaskNavigation />{active && <TaskView key={active.id} tab={active} hidden={false} />}</>;
  }
  stopMirror = startMirrorSync();
  const view = render(<Surface />);
  const load = store.getState().loadTree();
  await act(async () => {});
  return { store, openTask, treeReply, mirrorReply, load, view, memoryNavigate, buildMirrorLayout };
}
type Boot = Awaited<ReturnType<typeof boot>>;
async function ready(b: Boot) {
  await act(async () => { b.treeReply.resolve(tree); b.mirrorReply.resolve(mirrorOff); await b.load; });
}
function activeTask(b: Boot) {
  const s = b.store.getState();
  return s.activeTabId ? s.taskTabs[s.activeTabId] : undefined;
}
function expectIdentity(b: Boot, task = "job", sid = "B") {
  expect(activeTask(b)).toMatchObject({ sessionId: sid, taskId: task });
  expect(new URLSearchParams(window.location.search).get("taskId")).toBe(task);
  expect(new URLSearchParams(window.location.search).get("taskSession")).toBe(sid);
  expect(new URLSearchParams(window.location.search).get("keep")).toBe("1");
}
function expectNoStarts() {
  expect(ipc.invoke.mock.calls.filter(([command]) => /^(pty_spawn|pty_write|chat_start|create_session|set_session_engine)$/.test(command))).toEqual([]);
}

it("waits for the real tree and mirror gates without opening or reading a task early", async () => {
  const b = await boot(true);
  expect(b.store.getState().treeLoaded).toBe(false);
  expect(b.openTask).not.toHaveBeenCalled();
  expect(ipc.invoke).not.toHaveBeenCalledWith("chat_snapshot", expect.anything());
  expect(window.location.search).toBe(url().slice(1));
  await act(async () => { b.treeReply.resolve(tree); });
  expect(b.store.getState().treeLoaded).toBe(false);
  expect(b.openTask).not.toHaveBeenCalled();
  await act(async () => { b.mirrorReply.resolve(mirrorOff); await b.load; });
  expectIdentity(b);
  expect(b.openTask).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Backend task", { selector: ".sv-task-title" })).toBeTruthy();
  expect(screen.getByText("Completed")).toBeTruthy();
  expectNoStarts();
});

it.each([false, true])("restores a direct/refresh URL after saved normal layout=%s", async (normal) => {
  const b = await boot(normal);
  await ready(b);
  expectIdentity(b);
  expect(b.store.getState().treeLoaded).toBe(true);
  expect(b.openTask).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Backend task", { selector: ".sv-task-title" })).toBeTruthy();
  expect(b.store.getState().openTabs.filter((id) => !b.store.getState().taskTabs[id])).toEqual(normal ? ["A"] : []);
  await act(async () => { await b.store.getState().loadTree(); });
  expectIdentity(b);
  expect(b.openTask).toHaveBeenCalledTimes(1);
  expectNoStarts();
});

it("keeps the task URL while a delayed mirror layout replaces the saved arrangement", async () => {
  const b = await boot(true);
  await act(async () => { b.treeReply.resolve(tree); });
  const peer = b.buildMirrorLayout({ ...b.store.getState(), ...savedLayout(true) });
  await act(async () => { b.mirrorReply.resolve({ enabled: true, clients: 1, rev: 1, source: "ws-peer", state: JSON.parse(JSON.stringify(peer)) }); await b.load; });
  expectIdentity(b);
  expect(b.openTask).toHaveBeenCalledTimes(1);
  expect(activeTask(b)).toMatchObject({ returnTabId: "A", returnPaneId: "right" });
  expect(b.store.getState().paneTrees.A).toEqual(savedLayout(true).paneTrees.A);
  expectNoStarts();
});

it("recovers through the existing mirror timeout without an early task or URL rewrite", async () => {
  const b = await boot(true);
  await act(async () => { b.treeReply.resolve(tree); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(b.store.getState().treeLoaded).toBe(false);
  expect(b.openTask).not.toHaveBeenCalled();
  expect(window.location.search).toBe(url().slice(1));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); await b.load; });
  expectIdentity(b);
  expect(b.openTask).toHaveBeenCalledTimes(1);
  expectNoStarts();
});

it.each(["/", url("latest", "A")])("uses the latest URL when startup navigation changes to %s", async (target) => {
  const b = await boot();
  act(() => b.memoryNavigate(target));
  await ready(b);
  expect(Object.values(b.store.getState().taskTabs).some((tab) => tab.taskId === "job")).toBe(false);
  if (target === "/") {
    expect(activeTask(b)).toBeUndefined();
    expect(b.openTask).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  } else {
    expectIdentity(b, "latest", "A");
    expect(b.openTask).toHaveBeenCalledTimes(1);
  }
  expectNoStarts();
});

it("preserves the URL and rejected load when the tree cannot be read", async () => {
  const b = await boot();
  const result = expect(b.load).rejects.toThrow("tree offline");
  await act(async () => { b.treeReply.reject(new Error("tree offline")); await result; });
  expect(b.store.getState().treeLoaded).toBe(false);
  expect(b.openTask).not.toHaveBeenCalled();
  expect(window.location.search).toBe(url().slice(1));
  expect(screen.queryByText("Backend task")).toBeNull();
  expectNoStarts();
});

it.each(["job", "removed-task"])("shows existing unavailable UI for task %s without clearing its URL", async (task) => {
  const b = await boot(false, url(task), []);
  await ready(b);
  expectIdentity(b, task);
  expect(screen.getByText("No longer reported by the agent")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expectNoStarts();
});

describe("navigation after initial recovery", () => {
  it.each(["close", "switch"] as const)("keeps ordinary task %s and URL Back/Forward working", async (action) => {
    const b = await boot(true);
    await ready(b);
    const id = b.store.getState().activeTabId!;
    act(() => {
      if (action === "close") b.store.getState().closeTab(id);
      else b.store.getState().setActiveTab("A");
    });
    expect(b.store.getState()).toMatchObject({ activeTabId: "A", activeSessionId: "B", focusedPaneId: "right" });
    expect(window.location.search).toBe("?keep=1");
    // jsdom traverses history through two nested timer tasks; drain both before checking the real popstate result.
    await act(async () => { window.history.back(); await vi.advanceTimersByTimeAsync(2); });
    expectIdentity(b);
    await act(async () => { window.history.forward(); await vi.advanceTimersByTimeAsync(2); });
    expect(activeTask(b)).toBeUndefined();
    expect(window.location.search).toBe("?keep=1");
    expectNoStarts();
  });

  it("opens a task from a new URL after a normal startup and stops responding on unmount", async () => {
    const b = await boot(true, "/?keep=1");
    await ready(b);
    expect(b.openTask).not.toHaveBeenCalled();
    act(() => b.memoryNavigate(url()));
    expectIdentity(b);
    b.view.unmount();
    act(() => b.store.getState().setActiveTab("A"));
    expect(window.location.search).toBe(url().slice(1));
    expectNoStarts();
  });
});
