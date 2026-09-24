import { onSpawnRequest, onSpawnResolved } from "./events";
import { isTauri } from "./transport";
import { wsClient } from "./wsClient";
import { useTermStore } from "../store/termStore";

/** Restore backend-owned spawn receipts after listeners are ready and after reconnects. */
export function startSpawnRecovery(): () => void {
  let stopped = false;
  let listening = false;
  const recover = () => {
    if (!stopped && listening) void useTermStore.getState().syncSpawnRequests().catch(() => {});
  };
  const requestListener = onSpawnRequest((request) => {
    if (!stopped) void useTermStore.getState().handleSpawnRequest(request).catch(() => {});
  });
  const resolvedListener = onSpawnResolved((event) => {
    if (stopped) return;
    // A legacy event cannot identify a receipt. Re-read it instead of matching a prompt.
    if (!event.requestId) { recover(); return; }
    // Also read our own echo: the backend may have committed a response the client lost.
    useTermStore.getState().handleSpawnResolved(event.requestId);
  });
  void Promise.all([requestListener, resolvedListener]).then(() => {
    listening = true;
    recover();
  }).catch(() => {});
  const offConnection = isTauri ? undefined : wsClient.onConnState((state) => {
    if (state === "online") recover();
  });
  return () => {
    stopped = true;
    offConnection?.();
    void requestListener.then((off) => off()).catch(() => {});
    void resolvedListener.then((off) => off()).catch(() => {});
  };
}
