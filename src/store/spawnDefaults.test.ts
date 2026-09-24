//! Receipt projection follows the server's engine choice and never sends a second initial prompt.
import { beforeEach, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ resolveSpawn: vi.fn() }));
const chat = vi.hoisted(() => ({ chatStart: vi.fn(), chatSend: vi.fn() }));
vi.mock("../ipc/commands", async original => ({ ...await original<typeof import("../ipc/commands")>(), ...ipc }));
vi.mock("../ipc/chat", async original => ({ ...await original<typeof import("../ipc/chat")>(), ...chat }));
import { useTermStore } from "./termStore";
import type { SpawnReceipt } from "../ipc/commands";
const openSession = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); useTermStore.setState({ pendingSpawns: [], spawnReceipts: {}, pendingPrompts: {}, openSession, loadTree: vi.fn().mockResolvedValue(undefined), addSession: vi.fn() });
});
it.each(["chat", "tui"])("opens the authoritative %s session without sending or retaining a frontend prompt", async engine => {
  const receipt = { requestId: "r", request: { requestId: "r", parentSessionId: "parent", prompt: "task" }, decision: "confirmed", state: "ready", sessionId: "child", messageId: "msg-one", session: { id: "child", engine }, error: null } as SpawnReceipt;
  await useTermStore.getState().applySpawnReceipt(receipt, true);
  expect(openSession).toHaveBeenCalledWith("child", expect.any(Object));
  expect(chat.chatStart).not.toHaveBeenCalled(); expect(chat.chatSend).not.toHaveBeenCalled();
  expect(useTermStore.getState().pendingPrompts).toEqual({});
});
it("does not reopen historical completed sessions during receipt projection", async () => {
  const receipt = { requestId: "r", request: { requestId: "r", parentSessionId: "parent", prompt: "task" }, decision: "confirmed", state: "complete", sessionId: "child", messageId: "msg-one", session: { id: "child" }, error: null } as SpawnReceipt;
  await useTermStore.getState().applySpawnReceipt(receipt);
  expect(openSession).not.toHaveBeenCalled();
});
