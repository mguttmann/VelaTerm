import { useEffect, useState } from "react";
import type { Group, Project, Session } from "../../types";

export type AgentPlacement = "sibling" | "child";
export interface AgentPickerLocation {
  projectId: string;
  groupId: string | null;
  anchorId: string | null;
  placement: AgentPlacement;
}
export interface AgentPickerRoute extends AgentPickerLocation {
  requestId: string;
  search: string;
  choice: string;
}
const PARAMS = ["newAgent", "agentProject", "agentGroup", "agentAnchor", "agentPlacement", "agentSearch", "agentChoice"];

/** Resolve an initial UI target from the loaded tree; creation validates it again on the backend. */
export function activeAgentLocation(state: {
  projects: Project[]; groups: Group[]; sessions: Session[]; activeSessionId: string | null;
  inspectTarget: { kind: string; id: string } | null;
  selection: { kind: string; id: string }[];
}): AgentPickerLocation {
  const empty: AgentPickerLocation = { projectId: "", groupId: null, anchorId: null, placement: "sibling" };
  const projectExists = (id: string) => state.projects.some(p => p.id === id);
  const active = state.sessions.find(s => s.id === state.activeSessionId && !s.archivedAt && projectExists(s.projectId));
  if (active) return { ...empty, projectId: active.projectId, groupId: active.groupId ?? null, anchorId: active.id };
  for (const target of [state.inspectTarget, ...state.selection]) {
    if (!target) continue;
    if (target.kind === "project" && projectExists(target.id)) return { ...empty, projectId: target.id };
    const selected = target.kind === "session" && state.sessions.find(item => item.id === target.id && !item.archivedAt && projectExists(item.projectId));
    if (selected) return { ...empty, projectId: selected.projectId, groupId: selected.groupId ?? null };
    const group = target.kind === "group" && state.groups.find(g => g.id === target.id && projectExists(g.projectId));
    if (group) return { ...empty, projectId: group.projectId, groupId: group.id };
  }
  return empty;
}

export function agentPickerUrl(route: AgentPickerRoute | null): string {
  const url = new URL(window.location.href);
  PARAMS.forEach(key => url.searchParams.delete(key));
  if (route) {
    url.searchParams.set("newAgent", route.requestId);
    if (route.projectId) url.searchParams.set("agentProject", route.projectId);
    if (route.groupId) url.searchParams.set("agentGroup", route.groupId);
    if (route.anchorId) url.searchParams.set("agentAnchor", route.anchorId);
    url.searchParams.set("agentPlacement", route.placement);
    if (route.search) url.searchParams.set("agentSearch", route.search);
    if (route.choice) url.searchParams.set("agentChoice", route.choice);
  }
  return url.href;
}

export function newAgentPickerRoute(location: AgentPickerLocation): AgentPickerRoute {
  return { ...location, requestId: crypto.randomUUID(), search: "", choice: "" };
}
export function navigateAgentPicker(url: string, replace = false) {
  window.history[replace ? "replaceState" : "pushState"](null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function readAgentPickerRoute(): AgentPickerRoute | null {
  const params = new URLSearchParams(window.location.search);
  const requestId = params.get("newAgent");
  if (!requestId) return null;
  return {
    requestId, projectId: params.get("agentProject") ?? "", groupId: params.get("agentGroup"),
    anchorId: params.get("agentAnchor"), placement: params.get("agentPlacement") === "child" ? "child" : "sibling",
    search: params.get("agentSearch") ?? "", choice: params.get("agentChoice") ?? "",
  };
}
export function useAgentPickerRoute() {
  const [route, setRoute] = useState(readAgentPickerRoute);
  useEffect(() => {
    const update = () => setRoute(readAgentPickerRoute());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return route;
}
