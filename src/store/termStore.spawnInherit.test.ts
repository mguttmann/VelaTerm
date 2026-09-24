//! Business defaults are resolved on the backend; stale frontend caches cannot change a spawn.
import { beforeEach, expect, it, vi } from "vitest";
const resolveSpawn = vi.hoisted(() => vi.fn());
vi.mock("../ipc/commands", async original => ({ ...await original<typeof import("../ipc/commands")>(), resolveSpawn }));
import { useTermStore } from "./termStore";
import type { SpawnRequest } from "../ipc/events";
const req: SpawnRequest = { requestId: "stable", parentSessionId: "parent", prompt: "task", worktree: false };
beforeEach(() => {
  vi.clearAllMocks();
  resolveSpawn.mockResolvedValue({ requestId: "stable", request: req, decision: "confirmed", state: "complete", sessionId: "child", session: { id: "child" }, error: null });
  useTermStore.setState({ pendingSpawns: [req], spawnReceipts: {}, loadTree: vi.fn().mockResolvedValue(undefined), openSession: vi.fn(), addSession: vi.fn() });
});
it.each(["claude", "codex", "opencode", "pi", "omp", "cursor"] as const)("does not manufacture %s defaults from a stale client", async kind => {
  useTermStore.setState({ sessions: [], projects: [], agentDefaults: { [kind]: { permissionMode: "invalid-local-value", args: "--model stale", engine: "chat" } } });
  const request = { ...req, kind };
  await useTermStore.getState().executeSpawn(request);
  expect(resolveSpawn).toHaveBeenCalledExactlyOnceWith("stable", true, request);
  expect(useTermStore.getState().addSession).not.toHaveBeenCalled();
  expect(useTermStore.getState().pendingPrompts.child).toBeUndefined();
});
it("preserves backend defaults and the request identity across an explicit retry", async () => {
  const result = { requestId: "stable", request: req, decision: "confirmed", state: "failed", sessionId: "child", session: { id: "child" }, error: "start failed" };
  resolveSpawn.mockResolvedValueOnce(result).mockResolvedValueOnce({ ...result, state: "ready", error: null });
  await expect(useTermStore.getState().executeSpawn(req)).rejects.toThrow("start failed");
  useTermStore.setState({ agentDefaults: { claude: { args: "--model newly-changed" } } });
  await useTermStore.getState().executeSpawn(req);
  expect(resolveSpawn).toHaveBeenNthCalledWith(2, "stable", true, req);
  expect(useTermStore.getState().addSession).not.toHaveBeenCalled();
});
