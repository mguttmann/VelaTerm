import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Group, Project, Session } from "../../types";
import { NewAgentSessionRoute } from "./NewAgentSessionRoute";
import { activeAgentLocation, agentPickerUrl, navigateAgentPicker, newAgentPickerRoute, readAgentPickerRoute } from "./navigation";

const fixture = vi.hoisted(() => ({
  prepare: vi.fn(), create: vi.fn(), open: vi.fn(), load: vi.fn(), importProject: vi.fn(), collapse: vi.fn(),
  state: { projects: [] as Project[], groups: [] as Group[], sessions: [] as Session[], runtimes: {},
    activeSessionId: null as string | null, inspectTarget: null as { kind: string; id: string } | null,
    selection: [] as { kind: string; id: string }[] },
}));
vi.mock("../../ipc/launch", () => ({ prepareAgentSession: fixture.prepare, createAgentSession: fixture.create }));
vi.mock("../../ipc/tree", () => ({ setCollapsed: fixture.collapse }));
vi.mock("../../hooks/nativeViewSuspend", () => ({ useSuspendNativeViews() {} }));
vi.mock("../../i18n", () => ({ useT: () => (key: string, args?: object) => args ? `${key} ${JSON.stringify(args)}` : key }));
vi.mock("../sessionViewers/sessionMeta", () => ({ kindIconEl: () => <svg /> }));
vi.mock("../../store/termStore", () => ({ useTermStore: Object.assign(
  (selector: (state: unknown) => unknown) => selector(fixture.state), {
    getState: () => ({ ...fixture.state, openSession: fixture.open, loadTree: fixture.load, importProject: fixture.importProject }),
    setState: (update: (state: unknown) => object) => Object.assign(fixture.state, update(fixture.state)),
  },
) }));
const project = { id: "p1", name: "Workspace", rootPath: "/tmp/project" } as Project;
const session = { id: "s1", projectId: "p1", groupId: "g1", parentSessionId: "parent", name: "Active", kind: "codex" } as Session;
const preparation = {
  options: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }, { id: "terminal", label: "Terminal" }],
  presets: [{ id: "custom", name: "Custom Codex", baseKind: "codex", execPath: "/tmp/custom", permissionMode: "default", agentArgs: "--model custom" }],
  locationNames: ["Workspace", "Group", "Parent"],
};
function open(anchorId: string | null = "s1", projectId = "p1") {
  window.history.replaceState(null, "", agentPickerUrl(newAgentPickerRoute({ projectId, groupId: anchorId ? "g1" : null, anchorId, placement: "sibling" })));
  return render(<NewAgentSessionRoute />);
}
async function loaded() { return await screen.findByRole("option", { name: "Codex" }); }
function input() { return screen.getByRole("combobox", { name: "agentPicker.search" }); }

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); window.history.replaceState(null, "", "/?unrelated=keep");
  Object.assign(fixture.state, { projects: [project], groups: [{ id: "g1", projectId: "p1", name: "Group" }],
    sessions: [session], runtimes: {}, activeSessionId: "s1", inspectTarget: null, selection: [] });
  fixture.prepare.mockImplementation(async context => ({ ...preparation, context }));
  fixture.create.mockResolvedValue({ ...session, id: "created", name: "Created" });
  fixture.collapse.mockResolvedValue(undefined); fixture.load.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("new agent picker", () => {
  it("uses backend choices, searches presets and submits only their ID and location", async () => {
    open(); await loaded();
    expect(screen.queryByRole("option", { name: "Terminal" })).toBeNull();
    fireEvent.change(input(), { target: { value: "Custom" } });
    expect(readAgentPickerRoute()?.search).toBe("Custom");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(fixture.create).toHaveBeenCalledOnce());
    expect(fixture.create.mock.calls[0][0]).toEqual({ requestId: expect.any(String),
      context: { projectId: "p1", activeSessionId: "s1", placement: "sibling", groupId: "g1" }, presetId: "custom" });
    await waitFor(() => expect(fixture.open).toHaveBeenCalledWith("created"));
    expect(fixture.state.sessions.some(item => item.id === "created")).toBe(true);
    expect(readAgentPickerRoute()).toBeNull();
    expect(new URLSearchParams(window.location.search).get("unrelated")).toBe("keep");
  });

  it("switches placement with Tab, keeps Shift+Tab available and restores linked state on popstate", async () => {
    open(); await loaded();
    const sibling = window.location.href;
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: "Tab" });
    await loaded();
    expect(readAgentPickerRoute()?.placement).toBe("child");
    expect(document.activeElement).toBe(input());
    const child = screen.getByRole("link", { name: "agentPicker.child" });
    expect(new URL((child as HTMLAnchorElement).href).searchParams.get("agentPlacement")).toBe("child");
    const shiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    input().dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(false);
    act(() => navigateAgentPicker(sibling));
    await loaded();
    expect(readAgentPickerRoute()?.placement).toBe("sibling");
    expect(screen.getByRole("link", { name: "agentPicker.sibling" }).getAttribute("aria-current")).toBe("true");
    fireEvent.change(input(), { target: { value: "Claude" } });
    const url = window.location.href;
    cleanup(); window.history.replaceState(null, "", url); render(<NewAgentSessionRoute />);
    await screen.findByRole("option", { name: "Claude" });
    expect((input() as HTMLInputElement).value).toBe("Claude");
  });

  it("ignores IME and repeat Enter, prevents duplicate creation and retries a fixed request ID", async () => {
    open(); await loaded();
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input(), { key: "Enter", repeat: true });
    expect(fixture.create).not.toHaveBeenCalled();
    fixture.create.mockRejectedValueOnce(new Error("Creation rejected"));
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByRole("alert");
    expect(fixture.create).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "common.create" }));
    await waitFor(() => expect(fixture.create).toHaveBeenCalledTimes(2));
    expect(fixture.create.mock.calls[1][0]).toEqual(fixture.create.mock.calls[0][0]);
  });

  it("requires an explicitly valid project and offers the shared project selector", async () => {
    open(null, "");
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("agentPicker.noProject");
    expect((screen.getByRole("button", { name: "common.create" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("combobox", { name: "agentPicker.selectProject" }));
    fireEvent.click(screen.getByRole("option", { name: "Workspace" }));
    await loaded();
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(fixture.create).toHaveBeenCalledOnce());
    expect(fixture.create.mock.calls[0][0].context).toEqual({ projectId: "p1", activeSessionId: null, placement: "sibling", groupId: null });
  });

  it("guides an empty workspace to open a project and restores prior focus on closing", () => {
    fixture.state.projects = []; fixture.state.sessions = [];
    const origin = document.createElement("button"); document.body.append(origin); origin.focus();
    open(null, "");
    fireEvent.click(screen.getByRole("button", { name: "tree.openProject" }));
    expect(fixture.importProject).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(origin);
    origin.remove();
  });

  it("blocks stale targets and requires a fresh authoritative preparation after load failure", async () => {
    fixture.prepare.mockRejectedValueOnce(new Error("Offline"));
    open();
    await screen.findByRole("alert");
    expect(screen.queryByRole("option")).toBeNull();
    expect((screen.getByRole("button", { name: "common.create" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await loaded();
    cleanup();
    fixture.state.sessions = [];
    open("missing"); await loaded();
    expect(screen.getByRole("status").textContent).toContain("agentPicker.invalidTarget");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("recovers from a missing linked group without inheriting the old group or parent", async () => {
    fixture.state.groups = [];
    open(); await loaded();
    expect(screen.getByRole("status").textContent).toContain("agentPicker.invalidTarget");
    expect((screen.getByRole("button", { name: "common.create" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("combobox", { name: "agentPicker.selectProject" }));
    fireEvent.click(screen.getByRole("option", { name: "Workspace" }));
    await loaded();
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(fixture.create).toHaveBeenCalledOnce());
    expect(fixture.create.mock.calls[0][0].context).toEqual({ projectId: "p1", activeSessionId: null, placement: "sibling", groupId: null });
  });

  it("gives copied sibling and child links independent creation IDs and follows the actual href", async () => {
    open(); await loaded();
    const initial = readAgentPickerRoute()!;
    const child = screen.getByRole("link", { name: "agentPicker.child" }) as HTMLAnchorElement;
    const href = child.href;
    expect(new URL(href).searchParams.get("newAgent")).not.toBe(initial.requestId);
    fireEvent.click(child);
    expect(window.location.href).toBe(href);
    expect(readAgentPickerRoute()?.placement).toBe("child");
    const sibling = screen.getByRole("link", { name: "agentPicker.sibling" }) as HTMLAnchorElement;
    expect(new URL(sibling.href).searchParams.get("newAgent")).not.toBe(readAgentPickerRoute()?.requestId);
  });

  it("puts only confirmed recent choices first and keeps unknown saved IDs out of the catalogue", async () => {
    localStorage.setItem("vlx-agent-picker-recent", JSON.stringify(["preset:missing", "preset:custom", "kind:claude"]));
    open(); await loaded();
    expect(screen.getAllByRole("option").map(row => row.textContent)).toEqual([
      "Custom CodexagentPicker.recent", "ClaudeagentPicker.recent", "Codex",
    ]);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(readAgentPickerRoute()?.choice).toBe("kind:claude");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(fixture.open).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem("vlx-agent-picker-recent")!)[0]).toBe("kind:claude");
  });
});

describe("initial active location", () => {
  it("retains the active session, then uses an inspected project or group without guessing the first project", () => {
    expect(activeAgentLocation(fixture.state)).toEqual({ projectId: "p1", groupId: "g1", anchorId: "s1", placement: "sibling" });
    fixture.state.activeSessionId = null;
    expect(activeAgentLocation(fixture.state).projectId).toBe("");
    fixture.state.inspectTarget = { kind: "project", id: "missing" };
    fixture.state.selection = [{ kind: "group", id: "g1" }];
    expect(activeAgentLocation(fixture.state)).toEqual({ projectId: "p1", groupId: "g1", anchorId: null, placement: "sibling" });
    fixture.state.inspectTarget = { kind: "project", id: "p1" };
    expect(activeAgentLocation(fixture.state).groupId).toBeNull();
  });
  it("uses a valid selected session's project and group after the active pane closes", () => {
    fixture.state.activeSessionId = null;
    fixture.state.inspectTarget = { kind: "session", id: "s1" };
    expect(activeAgentLocation(fixture.state)).toEqual({ projectId: "p1", groupId: "g1", anchorId: null, placement: "sibling" });
    fixture.state.sessions = [{ ...fixture.state.sessions[0], archivedAt: 1 }];
    expect(activeAgentLocation(fixture.state).projectId).toBe("");
  });

});
