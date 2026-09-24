//! One of a Claude conversation's background tasks, opened as a tab of its own.
//!
//! The view subscribes independently of its conversation pane. Reconnection registers the new socket
//! with a snapshot without starting an agent; backend facts own lifecycle and elapsed time.

import { useEffect, useRef, useState } from "react";

import Icons from "../../../components/Icons";
import { fmtTokens } from "../../../format";
import { dateLocale, useT, type I18nKey } from "../../../i18n";
import {
  chatSnapshot,
  chatStopTask,
  extrasOf,
  isTaskFinished,
  onChatEvent,
  type ChatBackgroundTask,
  type ChatWorkflowAgent,
  type ChatWorkflowPhase,
} from "../../../ipc/chat";
import { onTransportReconnect, onTransportDisconnect } from "../../../ipc/transport";
import { useTermStore, type TaskTab } from "../../../store/termStore";

/** The icon a task kind is drawn with, here and on its tab. */
export function taskIcon(taskType: string) {
  if (taskType === "local_workflow") return Icons.layers;
  if (taskType === "local_agent") return Icons.bot;
  return Icons.terminal;
}

/** The label key for a task status; unknown values are shown as the agent wrote them. */
export function taskStatusKey(status: string | undefined): I18nKey | null {
  switch (status) {
    case "running":
    case "pending":
    case "paused":
      return "chat.tasks.status.running";
    case "completed":
      return "chat.tasks.status.completed";
    case "failed":
    case "error":
      return "chat.tasks.status.failed";
    case "killed":
    case "stopped":
    case "canceled":
    case "cancelled":
      return "chat.tasks.status.canceled";
    case "ended":
      return "chat.tasks.status.ended";
    default:
      return null;
  }
}

/** "1:05" or "1:02:03": the duration format the phase list and the elapsed figure share. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}

/** Advance a backend duration using only the time since this client received it. */
function elapsedOf(task: ChatBackgroundTask | undefined, ticking: boolean, delta: number): number | undefined {
  const elapsed = task?.elapsed_ms ?? task?.usage?.duration_ms;
  return elapsed == null ? undefined : elapsed + (ticking ? delta : 0);
}

/** Human-readable task type: "local_workflow" reads as "local workflow". */
const typeLabel = (taskType: string) => taskType.replace(/_/g, " ");

export function TaskView({ tab, hidden }: { tab: TaskTab; hidden: boolean }) {
  const t = useT();
  const [task, setTask] = useState<ChatBackgroundTask | undefined>(tab.seed);
  /** The last list did not carry this task, and no terminal frame explained why. */
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [sampledAt, setSampledAt] = useState(() => performance.now());
  const [now, setNow] = useState(() => performance.now());
  const frozenDelta = useRef(0);

  useEffect(() => {
    let disposed = false;
    let eventVersion = 0;
    let requestVersion = 0;
    let unlisten: (() => void) | undefined;
    const apply = (tasks: ChatBackgroundTask[] | undefined) => {
      const mine = tasks?.find((candidate) => candidate.task_id === tab.taskId);
      if (mine) {
        setTask(mine);
        useTermStore.getState().hydrateTaskTab(tab.sessionId, mine);
        setStale(false);
        const at = performance.now();
        setSampledAt(at);
        setNow(at);
        frozenDelta.current = 0;
      } else {
        setStale(true);
      }
      setOffline(false);
      setSyncFailed(false);
    };
    const synchronize = async () => {
      const request = ++requestVersion;
      const version = eventVersion;
      try {
        const snapshot = await chatSnapshot(tab.sessionId, {});
        if (!disposed && request === requestVersion && version === eventVersion) {
          apply(extrasOf(snapshot).backgroundTasks);
        }
      } catch {
        if (!disposed && request === requestVersion && version === eventVersion) setSyncFailed(true);
      }
    };
    const offReconnect = onTransportReconnect(() => { void synchronize(); });
    const offDisconnect = onTransportDisconnect(() => {
      requestVersion++;
      setOffline(true);
    });
    void onChatEvent(tab.sessionId, (event) => {
      if (disposed) return;
      if (event.type === "extras") {
        eventVersion++;
        apply(event.extras.backgroundTasks);
      } else if (event.type === "exited" || event.type === "reset") {
        eventVersion++;
        // Retain any final backend facts; absence is unavailable, never an invented task outcome.
        setStale(true);
      }
    }).then((fn) => {
      if (disposed) fn();
      else { unlisten = fn; void synchronize(); }
    }).catch(() => { if (!disposed) setSyncFailed(true); });
    return () => {
      disposed = true;
      requestVersion++;
      unlisten?.();
      offReconnect();
      offDisconnect();
    };
  }, [tab.sessionId, tab.taskId, retry]);

  const finished = !!task && isTaskFinished(task);
  const ticking = !!task && !finished && !stale && !offline && !syncFailed;
  useEffect(() => {
    if (!ticking || hidden) return;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, hidden]);

  const delta = Math.max(0, now - sampledAt);
  if (ticking) frozenDelta.current = delta;
  const statusKey = taskStatusKey(task?.status);
  const statusLabel = statusKey ? t(statusKey) : (task?.status ?? "");
  const elapsedMs = elapsedOf(task, !finished, ticking ? delta : frozenDelta.current);
  const TaskIcon = taskIcon(task?.task_type || tab.taskType);
  const progress = task?.workflow_progress ?? [];
  const phases = progress
    .filter((entry): entry is ChatWorkflowPhase => entry?.type === "workflow_phase")
    .sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
  const agents = progress.filter((entry): entry is ChatWorkflowAgent => entry?.type === "workflow_agent");
  const unphased = agents.filter((agent) => !phases.some((phase) => phase.index != null && phase.index === agent.phaseIndex));
  const isWorkflow = (task?.task_type || tab.taskType) === "local_workflow";
  const when = (ms: number) => new Date(ms).toLocaleString(dateLocale());

  return (
    <div className={"sv-task-view" + (finished ? " sv-task-finished" : "")} style={hidden ? { display: "none" } : undefined}>
      <div className="sv-task-head">
        <span className="sv-task-icon"><TaskIcon size={16} /></span>
        <div className="sv-task-heading">
          <div className="sv-task-title">{tab.title}</div>
          <div className="sv-task-sub">
            <span>{typeLabel(task?.task_type || tab.taskType)}</span>
            <span className={"sv-task-badge sv-task-badge-" + (statusKey ? statusKey.split(".").pop() : "other")}>{statusLabel}</span>
            {stale && !(task && isTaskFinished(task)) ? <span className="sv-task-stale">{t("chat.tasks.stale")}</span> : null}
          </div>
        </div>
        {task?.can_stop && !finished && !stale && !offline && !syncFailed ? (
          <button
            className="sv-popover-action"
            onClick={() => void chatStopTask(tab.sessionId, tab.taskId).catch((err) => setError(String(err)))}
          >
            {t("chat.tasks.stop")}
          </button>
        ) : null}
      </div>
      {error ? <div className="sv-task-error" role="alert">{error}</div> : null}
      {offline || syncFailed ? <div className="sv-task-error" role="alert">
        {t("chat.sync.failed")}
        <button className="sv-popover-action" onClick={() => setRetry((value) => value + 1)}>{t("common.retry")}</button>
      </div> : null}

      {task?.description ? <div className="sv-task-description">{task.description}</div> : null}

      <dl className="sv-task-stats">
        {elapsedMs != null ? <Stat label={t("chat.tasks.elapsed")} value={fmtElapsed(elapsedMs)} /> : null}
        {task?.usage?.total_tokens != null ? <Stat label={t("chat.tasks.tokens")} value={fmtTokens(task.usage.total_tokens)} /> : null}
        {task?.usage?.tool_uses != null ? <Stat label={t("chat.tasks.toolUses")} value={String(task.usage.tool_uses)} /> : null}
        {task?.last_tool_name && ["local_agent", "local_workflow"].includes(task.task_type) ? <Stat
          label={t(task.task_type === "local_workflow" ? "chat.tasks.lastUpdatedAgent" : "chat.tasks.lastTool")}
          value={task.last_tool_name}
        /> : null}
        {task?.started_at != null ? <Stat label={t("chat.tasks.started")} value={when(task.started_at)} /> : null}
        {task?.ended_at != null ? <Stat label={t("chat.tasks.finished")} value={when(task.ended_at)} /> : null}
      </dl>

      {finished && task?.summary ? (
        <section className="sv-task-section">
          <h3>{t("chat.tasks.summary")}</h3>
          <div className="sv-task-preview">{task.summary}</div>
        </section>
      ) : null}
      {finished && task?.output_file ? (
        <section className="sv-task-section">
          <h3>{t("chat.tasks.outputFile")}</h3>
          <div className="sv-task-preview">{task.output_file}</div>
        </section>
      ) : null}

      {isWorkflow ? (
        <section className="sv-task-section">
          <h3>{t("chat.tasks.phases")}</h3>
          {agents.length === 0 && phases.length === 0 ? (
            <div className="sv-task-empty">{t("chat.tasks.noProgress")}</div>
          ) : (
            <>
              {phases.map((phase) => (
                <div className="sv-task-phase" key={phase.id ?? `phase:${phase.index}:${phase.title}`}>
                  <div className="sv-task-phase-title">{phase.title}</div>
                  {agents
                    .filter((agent) => phase.index != null && agent.phaseIndex === phase.index && phases.find((candidate) => candidate.index === agent.phaseIndex) === phase)
                    .map((agent) => <AgentRow key={agent.id ?? `agent:${agent.index}:${agent.label}`} agent={agent} delta={ticking ? delta : frozenDelta.current} />)}
                </div>
              ))}
              {unphased.length ? (
                <div className="sv-task-phase">
                  {unphased.map((agent) => <AgentRow key={agent.id ?? `agent:${agent.index}:${agent.label}`} agent={agent} delta={ticking ? delta : frozenDelta.current} />)}
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="sv-task-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** One agent of a workflow: who, on what model, in which state, and what it was asked and answered. */
function AgentRow({ agent, delta }: { agent: ChatWorkflowAgent; delta: number }) {
  const t = useT();
  const done = agent.state === "done";
  const baseDuration = agent.elapsedMs ?? agent.durationMs;
  const durationMs = baseDuration == null ? undefined : baseDuration + (agent.elapsedRunning ? delta : 0);
  const stateLabel =
    agent.state === "start" ? t("chat.tasks.agentState.start") : done ? t("chat.tasks.agentState.done") : (agent.state ?? "");
  return (
    <div className={"sv-task-agent" + (done ? " sv-task-agent-done" : agent.state === "start" ? " sv-task-agent-start" : "")}>
      <div className="sv-task-agent-head">
        <span className="sv-task-agent-label">{agent.label}</span>
        {agent.model ? <span className="sv-task-agent-meta">{agent.model}</span> : null}
        {stateLabel ? <span className="sv-task-agent-state">{stateLabel}</span> : null}
        {agent.attempt != null && agent.attempt > 1 ? <span className="sv-task-agent-meta">{t("chat.tasks.attempt", agent.attempt)}</span> : null}
        <span className="sv-task-agent-spacer" />
        {durationMs != null ? <span className="sv-task-agent-meta">{fmtElapsed(durationMs)}</span> : null}
        {agent.tokens != null ? <span className="sv-task-agent-meta">{t("chat.subagent.tokens", fmtTokens(agent.tokens))}</span> : null}
        {agent.toolCalls != null ? <span className="sv-task-agent-meta">{t("chat.subagent.steps", agent.toolCalls)}</span> : null}
      </div>
      {agent.promptPreview ? (
        <div className="sv-task-agent-text">
          <span className="sv-task-agent-key">{t("chat.tasks.prompt")}</span>
          <span className="sv-task-preview">{agent.promptPreview}</span>
        </div>
      ) : null}
      {done && agent.resultPreview ? (
        <div className="sv-task-agent-text">
          <span className="sv-task-agent-key">{t("chat.tasks.result")}</span>
          <span className="sv-task-preview">{agent.resultPreview}</span>
        </div>
      ) : null}
    </div>
  );
}
