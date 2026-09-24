import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Backdrop } from "../../components/Backdrop";
import Icons from "../../components/Icons";
import Select from "../../components/Select";
import { useT } from "../../i18n";
import { createAgentSession, prepareAgentSession } from "../../ipc/launch";
import { setCollapsed } from "../../ipc/tree";
import { useTermStore } from "../../store/termStore";
import { PresetIcon } from "../agentPresetIcon";
import { kindIconEl } from "../sessionViewers/sessionMeta";
import { agentChoices, recentAgentChoices, rememberAgentChoice, type AgentChoice } from "./choices";
import { agentPickerUrl, navigateAgentPicker, readAgentPickerRoute, useAgentPickerRoute, type AgentPickerRoute } from "./navigation";
import "./new-agent-session.css";

export function NewAgentSessionRoute() {
  const route = useAgentPickerRoute();
  return route ? <NewAgentSessionPicker route={route} /> : null;
}

function NewAgentSessionPicker({ route }: { route: AgentPickerRoute }) {
  const t = useT();
  const id = useId();
  const dialog = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<AgentChoice[] | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [preparedFor, setPreparedFor] = useState("");
  const [locationNames, setLocationNames] = useState<string[]>([]);
  const context = useMemo(() => ({ projectId: route.projectId || null, activeSessionId: route.anchorId,
    placement: route.placement, groupId: route.groupId }), [route.projectId, route.anchorId, route.placement, route.groupId]);
  const contextKey = JSON.stringify(context);
  const projects = useTermStore(state => state.projects);
  const groups = useTermStore(state => state.groups);
  const sessions = useTermStore(state => state.sessions);
  const project = projects.find(item => item.id === route.projectId);
  const group = route.groupId ? groups.find(item => item.id === route.groupId && item.projectId === route.projectId) : null;
  const anchor = route.anchorId ? sessions.find(item => item.id === route.anchorId && !item.archivedAt && item.projectId === route.projectId) : null;
  const validTarget = !!project && (!route.groupId || !!group) && (!route.anchorId || !!anchor);
  const location = locationNames.join(" / ");
  const ready = validTarget && preparedFor === contextKey;
  const filtered = useMemo(() => {
    const query = route.search.trim().toLocaleLowerCase();
    return (choices ?? []).filter(choice => `${choice.label} ${choice.kind}`.toLocaleLowerCase().includes(query));
  }, [choices, route.search]);
  const selected = filtered.find(choice => choice.id === route.choice) ?? filtered[0];
  const activeIndex = selected ? filtered.indexOf(selected) : -1;

  useEffect(() => {
    const previous = document.activeElement;
    search.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let alive = true;
    setChoices(null); setLoadError(false); setPreparedFor("");
    if (!context.projectId) { setChoices([]); return; }
    prepareAgentSession(context).then(result => {
      if (alive) {
        setChoices(agentChoices(result.options, result.presets, recentAgentChoices()));
        setLocationNames(result.locationNames); setPreparedFor(contextKey);
      }
    }).catch(() => { if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, [revision, context, contextKey]);
  useEffect(() => {
    const container = list.current;
    const row = container?.children[activeIndex] as HTMLElement | undefined;
    if (!container || !row) return;
    if (row.offsetTop < container.scrollTop) container.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > container.scrollTop + container.clientHeight) {
      container.scrollTop = row.offsetTop + row.offsetHeight - container.clientHeight;
    }
  }, [activeIndex]);

  const update = (change: Partial<AgentPickerRoute>, replace = false) => {
    if (pending.current) return;
    setError("");
    navigateAgentPicker(agentPickerUrl({ ...route, ...change, requestId: crypto.randomUUID() }), replace);
  };
  const close = () => { if (!pending.current) navigateAgentPicker(agentPickerUrl(null)); };
  const create = async () => {
    if (!selected || !ready || !choices || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    const submitted = route.requestId;
    try {
      const session = await createAgentSession({
        requestId: submitted, context,
        ...(selected.preset ? { presetId: selected.preset.id } : { kind: selected.kind }),
      });
      // Only the backend response enters the display cache; the picker never supplies copied defaults.
      useTermStore.setState(state => ({
        sessions: state.sessions.some(item => item.id === session.id) ? state.sessions : [...state.sessions, session],
        runtimes: { ...state.runtimes, [session.id]: state.runtimes[session.id] ?? { status: "idle" } },
      }));
      rememberAgentChoice(selected.id);
      useTermStore.getState().openSession(session.id);
      if (readAgentPickerRoute()?.requestId === submitted) navigateAgentPicker(agentPickerUrl(null), true);
      void setCollapsed(session.parentSessionId ? "session" : session.groupId ? "group" : "project",
        session.parentSessionId ?? session.groupId ?? session.projectId, false)
        .catch(() => {}).then(() => useTermStore.getState().loadTree());
    } catch (reason) { setError(String(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  const placement = (value: "sibling" | "child") => update({ placement: value });
  const placementUrls = useMemo(() => Object.fromEntries((["sibling", "child"] as const).map(value => [value,
    agentPickerUrl({ ...route, placement: value, requestId: value === route.placement ? route.requestId : crypto.randomUUID() }),
  ])), [route]);
  const targetLabel = anchor
    ? t(route.placement === "child" ? "agentPicker.targetChild" : "agentPicker.targetSibling", anchor.name, location)
    : t("agentPicker.targetProject", location);

  return <Backdrop onClose={close}>
    <section className="new-agent-picker" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-target`} tabIndex={-1} onKeyDown={event => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key !== "Tab") return;
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), a[href]',
        ) ?? []);
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); dialog.current?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className="new-agent-picker-header">
        <h2 id={`${id}-title`}>{t("agentPicker.title")}</h2>
        <button className="vlx-btn" type="button" onClick={close} disabled={busy} aria-label={t("common.close")}><Icons.close size={16} /></button>
      </header>
      <div className="new-agent-picker-target">
        {!validTarget && <p id={`${id}-target`} role="status">{t(project ? "agentPicker.invalidTarget" : "agentPicker.noProject")}</p>}
        {validTarget && <p id={`${id}-target`}>{targetLabel}</p>}
        {projects.length > 0 && (!anchor || !validTarget || loadError) && <Select value={project?.id ?? ""} width="100%"
          ariaLabel={t("agentPicker.selectProject")} placeholder={t("agentPicker.selectProject")} disabled={busy}
          options={projects.map(item => ({ value: item.id, label: item.name }))}
          onChange={projectId => update({ projectId, groupId: null, anchorId: null, placement: "sibling" })} />}
        {!projects.length && <button className="vlx-btn" type="button" disabled={busy}
          onClick={() => { close(); void useTermStore.getState().importProject(); }}>{t("tree.openProject")}</button>}
        {anchor && validTarget && <div className="new-agent-picker-placement" role="group" aria-label={t("agentPicker.placementHint")}>
          <a className="vlx-btn" aria-current={route.placement === "sibling" ? "true" : undefined}
            href={placementUrls.sibling} onClick={event => {
              if (busy) { event.preventDefault(); return; }
              if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
              event.preventDefault(); setError(""); navigateAgentPicker(event.currentTarget.href);
            }}>{t("agentPicker.sibling")}</a>
          <a className="vlx-btn" aria-current={route.placement === "child" ? "true" : undefined}
            href={placementUrls.child} onClick={event => {
              if (busy) { event.preventDefault(); return; }
              if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
              event.preventDefault(); setError(""); navigateAgentPicker(event.currentTarget.href);
            }}>{t("agentPicker.child")}</a>
        </div>}
      </div>
      <div className="new-agent-picker-search">
        <input ref={search} className="vlx-input" role="combobox" type="search" value={route.search} disabled={busy}
          aria-label={t("agentPicker.search")} placeholder={t("agentPicker.search")} aria-autocomplete="list"
          aria-expanded={choices !== null} aria-controls={`${id}-list`} aria-activedescendant={selected ? `${id}-option-${activeIndex}` : undefined}
          onChange={event => update({ search: event.target.value }, true)} onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const index = Math.max(0, Math.min(filtered.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)));
              if (filtered[index]) update({ choice: filtered[index].id }, true);
            } else if (event.key === "Enter") { event.preventDefault(); void create(); }
            else if (event.key === "Tab" && !event.shiftKey && anchor && validTarget && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault(); placement(route.placement === "child" ? "sibling" : "child");
            }
          }} />
        {anchor && validTarget && <p className="new-agent-picker-hint">{t("agentPicker.placementHint")}</p>}
      </div>
      {loadError ? <div className="new-agent-picker-empty" role="alert">
        <p>{t("agentPicker.loadFailed")}</p><button className="vlx-btn" onClick={() => setRevision(value => value + 1)}>{t("common.retry")}</button>
      </div> : !choices ? <p role="status">{t("common.loading")}</p> : <>
        <div className="new-agent-picker-list" ref={list} id={`${id}-list`} role="listbox" aria-label={t("agentPicker.title")}>
          {filtered.map((choice, index) => <button type="button" role="option" id={`${id}-option-${index}`} key={choice.id}
            aria-selected={choice.id === selected?.id} className="new-agent-picker-choice" tabIndex={-1} disabled={busy}
            onClick={() => { update({ choice: choice.id }, true); search.current?.focus(); }}>
            {choice.preset ? <PresetIcon preset={choice.preset} size={20} /> : kindIconEl(choice.kind, 20)}
            <span className="new-agent-picker-label">{choice.label}</span>
            {choice.recent && <span className="new-agent-picker-recent">{t("agentPicker.recent")}</span>}
          </button>)}
        </div>
        {route.projectId && !filtered.length && <p className="new-agent-picker-empty" role="status">{t("agentPicker.noResults", route.search)}</p>}
      </>}
      {error && <p className="new-agent-picker-error" role="alert">{error}</p>}
      <footer className="new-agent-picker-footer">
        <button type="button" className="vlx-btn" disabled={busy} onClick={close}>{t("common.cancel")}</button>
        <button type="button" className="vlx-btn vlx-btn-primary" disabled={busy || !selected || !ready || loadError} onClick={() => void create()}>
          {t(busy ? "agentPicker.creating" : "common.create")}
        </button>
      </footer>
    </section>
  </Backdrop>;
}
