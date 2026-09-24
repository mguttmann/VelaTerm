import { useEffect, useRef } from "react";
import { useTermStore } from "../store/termStore";

/** Bridge confirmed spawn results into mobile navigation without following desktop layout changes. */
export function useSpawnNavigation(open: (id: string) => void) {
  const openRequest = useTermStore(state => state.sessionOpenRequest);
  const receipts = useTermStore(state => state.spawnReceipts);
  const sessions = useTermStore(state => state.sessions);
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const targetId = openRequest?.sessionId;
    const receipt = targetId && Object.values(receipts).find(value => value.decision === "confirmed"
      && value.sessionId === targetId && value.session?.id === targetId);
    const key = receipt ? `${receipt.requestId}:${targetId}:${openRequest!.revision}` : null;
    if (!key) { handled.current = null; return; }
    if (handled.current === key || !sessions.some(session => session.id === targetId)) return;
    handled.current = key;
    // A restored link may already select this session's read-only history. Keep that explicit view.
    if (new URLSearchParams(location.search).get("session") !== targetId) open(targetId!);
  }, [openRequest, receipts, sessions, open]);
}
