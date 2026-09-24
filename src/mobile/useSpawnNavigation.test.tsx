import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Session } from "../types";
import type { SpawnReceipt } from "../ipc/commands";
import { useTermStore } from "../store/termStore";
import { useSpawnNavigation } from "./useSpawnNavigation";

vi.mock("../store/termStore", async () => {
  const { create } = await import("zustand");
  return { useTermStore: create(() => ({ activeSessionId: null, sessionOpenRequest: null, sessions: [], spawnReceipts: {} })) };
});
const session = { id: "child", kind: "kiro", engine: "tui" } as Session;
const receipt: SpawnReceipt = { requestId: "spawn-1", request: { requestId: "spawn-1", parentSessionId: "parent", prompt: "Task" }, decision: "confirmed", state: "ready", sessionId: "child", messageId: "msg-1", session, error: null };
beforeEach(() => {
  history.replaceState(null, "", "/?view=mobile");
  useTermStore.setState({ activeSessionId: null, sessionOpenRequest: null, sessions: [], spawnReceipts: {} });
});
afterEach(cleanup);

describe("mobile confirmed spawn navigation", () => {
  it.each(["receipt-first", "intent-first"])("waits for matching receipt and tree (%s)", order => {
    const open = vi.fn(); renderHook(() => useSpawnNavigation(open));
    act(() => useTermStore.setState(order === "receipt-first" ? { spawnReceipts: { "spawn-1": receipt } } : { sessionOpenRequest: { sessionId: "child", revision: 1 } }));
    expect(open).not.toHaveBeenCalled();
    act(() => useTermStore.setState(order === "receipt-first" ? { sessionOpenRequest: { sessionId: "child", revision: 1 } } : { spawnReceipts: { "spawn-1": receipt } }));
    expect(open).not.toHaveBeenCalled();
    act(() => useTermStore.setState({ sessions: [session] }));
    expect(open).toHaveBeenCalledExactlyOnceWith("child");
  });
  it("recovers an existing explicit open request on initial mount", () => {
    useTermStore.setState({ activeSessionId: "child", sessionOpenRequest: { sessionId: "child", revision: 1 }, sessions: [session], spawnReceipts: { "spawn-1": receipt } });
    const open = vi.fn(); renderHook(() => useSpawnNavigation(open));
    expect(open).toHaveBeenCalledExactlyOnceWith("child");
  });
  it("ignores unrelated activation, unconfirmed receipts and reserved-but-uncreated identities", () => {
    const open = vi.fn(); renderHook(() => useSpawnNavigation(open));
    act(() => useTermStore.setState({ activeSessionId: "child", sessions: [session] }));
    act(() => useTermStore.setState({ spawnReceipts: { "spawn-1": { ...receipt, decision: "pending" } } }));
    act(() => useTermStore.setState({ spawnReceipts: { "spawn-1": { ...receipt, session: null } } }));
    act(() => useTermStore.setState({ spawnReceipts: { "spawn-1": receipt } }));
    expect(open).not.toHaveBeenCalled();
  });
  it("does not reopen after unrelated refreshes but accepts a repeated explicit open of the same ID", () => {
    const open = vi.fn(); renderHook(() => useSpawnNavigation(open));
    act(() => useTermStore.setState({ sessions: [session], spawnReceipts: { "spawn-1": receipt }, sessionOpenRequest: { sessionId: "child", revision: 1 } }));
    act(() => useTermStore.setState({ sessions: [session], spawnReceipts: { "spawn-1": { ...receipt } } }));
    expect(open).toHaveBeenCalledTimes(1);
    act(() => useTermStore.setState({ sessionOpenRequest: { sessionId: "child", revision: 2 } }));
    expect(open).toHaveBeenCalledTimes(2);
  });
  it("keeps an explicit history link for an already selected session", () => {
    history.replaceState(null, "", "/?session=child&sessionView=history");
    useTermStore.setState({ activeSessionId: "child", sessionOpenRequest: { sessionId: "child", revision: 1 }, sessions: [session], spawnReceipts: { "spawn-1": receipt } });
    const open = vi.fn(); renderHook(() => useSpawnNavigation(open));
    expect(open).not.toHaveBeenCalled();
  });
});
