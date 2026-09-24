//! Task URLs identify provider tasks, never processes to start. The store retains local tab presentation;
//! history restores it with an identity-only seed and the TaskView reads authoritative backend facts.
import { useEffect, useRef } from "react";
import { useTermStore } from "../../../store/termStore";
import { memoryNavigate, useMemoryLocation } from "../../Memory/navigation";

export function taskUrl(sessionId?: string, taskId?: string): string {
  const url = new URL(window.location.href);
  if (sessionId && taskId) {
    url.searchParams.set("taskSession", sessionId);
    url.searchParams.set("taskId", taskId);
  } else {
    url.searchParams.delete("taskSession");
    url.searchParams.delete("taskId");
  }
  return url.href;
}

export function TaskNavigation() {
  const search = useMemoryLocation();
  const treeLoaded = useTermStore((state) => state.treeLoaded);
  const restoring = useRef(false);
  useEffect(() => {
    // Initial layout restoration includes mirror alignment and must finish before creating a local task tab.
    if (!treeLoaded) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("taskSession");
    const taskId = params.get("taskId");
    const state = useTermStore.getState();
    const active = state.activeTabId ? state.taskTabs[state.activeTabId] : undefined;
    restoring.current = true;
    if (sessionId && taskId) {
      if (active?.sessionId !== sessionId || active.taskId !== taskId) {
        state.openTaskTab(sessionId, { task_id: taskId, task_type: "", description: taskId });
      }
    } else if (active) {
      const fallback = active.returnTabId && state.openTabs.includes(active.returnTabId)
        ? active.returnTabId : state.openTabs.find((id) => !state.taskTabs[id]);
      if (fallback) state.setActiveTab(fallback);
      else state.closeTab(active.id);
    }
    restoring.current = false;
  }, [search, treeLoaded]);
  useEffect(() => useTermStore.subscribe((state, before) => {
    // The readiness update can replace the saved layout; it is not a user leaving a task URL.
    if (!state.treeLoaded || !before.treeLoaded) return;
    if (restoring.current || state.activeTabId === before.activeTabId) return;
    const active = state.activeTabId ? state.taskTabs[state.activeTabId] : undefined;
    const hadTask = before.activeTabId ? before.taskTabs[before.activeTabId] : undefined;
    if (!active && !hadTask) return;
    const href = taskUrl(active?.sessionId, active?.taskId);
    if (href !== window.location.href) memoryNavigate(href);
  }), []);
  return null;
}
