import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnRequest, SpawnResolved } from "./events";
import { startSpawnRecovery } from "./spawnRecovery";

const fixture = vi.hoisted(() => ({
  request: vi.fn(), resolved: vi.fn(), connection: vi.fn(),
  sync: vi.fn(), handleRequest: vi.fn(), handleResolved: vi.fn(),
  offRequest: vi.fn(), offResolved: vi.fn(), offConnection: vi.fn(),
  desktop: false,
}));
vi.mock("./events", () => ({ onSpawnRequest: fixture.request, onSpawnResolved: fixture.resolved }));
vi.mock("./transport", () => ({ get isTauri() { return fixture.desktop; } }));
vi.mock("./wsClient", () => ({ wsClient: { onConnState: fixture.connection } }));
vi.mock("../store/termStore", () => ({ useTermStore: { getState: () => ({
  syncSpawnRequests: fixture.sync, handleSpawnRequest: fixture.handleRequest,
  handleSpawnResolved: fixture.handleResolved,
}) } }));

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  vi.clearAllMocks(); fixture.desktop = false;
  fixture.request.mockResolvedValue(fixture.offRequest);
  fixture.resolved.mockResolvedValue(fixture.offResolved);
  fixture.connection.mockReturnValue(fixture.offConnection);
  fixture.sync.mockResolvedValue(undefined);
  fixture.handleRequest.mockResolvedValue(undefined);
});

describe("global spawn recovery", () => {
  it("waits for both event listeners before reading durable requests", async () => {
    let ready!: (off: () => void) => void;
    fixture.resolved.mockReturnValue(new Promise<() => void>((resolve) => { ready = resolve; }));
    const stop = startSpawnRecovery();
    fixture.connection.mock.calls[0][0]("online");
    await settle();
    expect(fixture.sync).not.toHaveBeenCalled();
    ready(fixture.offResolved);
    await settle();
    expect(fixture.sync).toHaveBeenCalledOnce();
    stop();
  });

  it("recovers on WebSocket reconnection but not intermediate connection states", async () => {
    const stop = startSpawnRecovery(); await settle(); fixture.sync.mockClear();
    const connection = fixture.connection.mock.calls[0][0];
    connection("offline"); connection("connecting");
    expect(fixture.sync).not.toHaveBeenCalled();
    connection("online");
    expect(fixture.sync).toHaveBeenCalledOnce();
    stop();
  });

  it("uses request identity even for the client's own resolved echo", async () => {
    const stop = startSpawnRecovery(); await settle();
    const request = { requestId: "request-1", parentSessionId: "parent", prompt: "Same text" } as SpawnRequest;
    fixture.request.mock.calls[0][0](request);
    fixture.resolved.mock.calls[0][0]({ ...request, source: "desktop", confirmed: true } as SpawnResolved);
    expect(fixture.handleRequest).toHaveBeenCalledWith(request);
    expect(fixture.handleResolved).toHaveBeenCalledExactlyOnceWith("request-1");
    stop();
  });

  it("queries on a legacy resolved hint without dismissing a prompt match", async () => {
    const stop = startSpawnRecovery(); await settle(); fixture.sync.mockClear();
    fixture.resolved.mock.calls[0][0]({ parentSessionId: "parent", prompt: "Same text", source: "desktop", confirmed: true });
    expect(fixture.handleResolved).not.toHaveBeenCalled();
    expect(fixture.sync).toHaveBeenCalledOnce();
    stop();
  });

  it("cleans up late listener registrations and does not recover after unmount", async () => {
    let ready!: (off: () => void) => void;
    fixture.request.mockReturnValue(new Promise<() => void>((resolve) => { ready = resolve; }));
    const stop = startSpawnRecovery(); stop();
    ready(fixture.offRequest); await settle();
    fixture.connection.mock.calls[0][0]("online");
    fixture.request.mock.calls[0][0]({ requestId: "late" });
    fixture.resolved.mock.calls[0][0]({ requestId: "late" });
    expect(fixture.sync).not.toHaveBeenCalled();
    expect(fixture.handleRequest).not.toHaveBeenCalled();
    expect(fixture.handleResolved).not.toHaveBeenCalled();
    expect(fixture.offRequest).toHaveBeenCalledOnce();
    expect(fixture.offResolved).toHaveBeenCalledOnce();
    expect(fixture.offConnection).toHaveBeenCalledOnce();
  });

  it("initially restores desktop requests without a WebSocket subscription", async () => {
    fixture.desktop = true;
    const stop = startSpawnRecovery(); await settle();
    expect(fixture.connection).not.toHaveBeenCalled();
    expect(fixture.sync).toHaveBeenCalledOnce();
    stop();
  });
});
