//! A standalone read-only history surface. Resolving a URL never opens or starts its target session.
import { useEffect, useRef, useState } from "react";
import { Backdrop } from "../../components/Backdrop";
import Icons from "../../components/Icons";
import { useT } from "../../i18n";
import { onTreeChanged } from "../../ipc/events";
import { listTree } from "../../ipc/tree";
import type { Session } from "../../types";
import { SessionContentViewer } from "../sessionViewers/SessionContentViewer";
import { kiroHistoryUrl, navigateKiroHistory, useKiroHistoryLocation } from "./navigation";
import "./kiro-history.css";

export function KiroHistoryRoute() {
  const id = useKiroHistoryLocation();
  return id === null ? null : <KiroHistory key={id} id={id} />;
}

type Target = { state: "loading" } | { state: "missing" } | { state: "error"; error: string } | { state: "ready"; session: Session };

function KiroHistory({ id }: { id: string }) {
  const t = useT();
  const [target, setTarget] = useState<Target>({ state: "loading" });
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [previousFocus] = useState(() => document.activeElement);
  const close = () => navigateKiroHistory(kiroHistoryUrl(null));

  useEffect(() => {
    closeButton.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [previousFocus]);

  useEffect(() => {
    let active = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      setTarget({ state: "loading" });
      void listTree().then(tree => {
        if (!active || request !== generation) return;
        const session = tree.sessions.find(session => session.id === id && session.kind === "kiro");
        setTarget(session ? { state: "ready", session } : { state: "missing" });
      }).catch(error => {
        if (active && request === generation) setTarget({ state: "error", error: String(error) });
      });
    };
    load();
    const unlisten = onTreeChanged(load);
    // Revalidate after a background tab or interrupted connection; retry remains available for every state.
    window.addEventListener("focus", load);
    void unlisten.catch(error => { if (active) setTarget({ state: "error", error: String(error) }); });
    return () => {
      active = false;
      window.removeEventListener("focus", load);
      void unlisten.then(stop => stop()).catch(() => {});
    };
  }, [id, revision]);

  return <Backdrop onClose={close}>
    <section className="kiro-history" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="kiro-history-title"
      aria-describedby="kiro-history-mode" tabIndex={-1} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key !== "Tab") return;
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),a[href],textarea:not(:disabled),[tabindex="0"]',
        ) ?? []).filter(node => !node.closest('[hidden],[inert]') && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden");
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); dialog.current?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <header className="kiro-history-header">
        <div className="kiro-history-heading">
          <h2 id="kiro-history-title">{t("session.showConversation")}</h2>
          <span id="kiro-history-mode" className="kiro-history-mode">{t("chat.mode.readOnly")}</span>
          {target.state === "ready" && <p className="kiro-history-name">{target.session.name}</p>}
        </div>
        <div className="kiro-history-actions">
          <button className="vlx-btn" type="button" disabled={target.state === "loading"} onClick={() => setRevision(value => value + 1)}>
            {t("common.retry")}
          </button>
          <button ref={closeButton} className="vlx-btn" type="button" aria-label={t("common.close")} title={t("common.close")} onClick={close}>
            <Icons.close size={18} />
          </button>
        </div>
      </header>
      <div className="kiro-history-content" aria-busy={target.state === "loading"}>
        {target.state === "loading" && <p className="kiro-history-notice" role="status">{t("common.loading")}</p>}
        {target.state === "missing" && <p className="kiro-history-notice" role="status">{t("memory.notFound")}</p>}
        {target.state === "error" && <p className="kiro-history-notice" role="alert">{target.error}</p>}
        {target.state === "ready" && <SessionContentViewer key={`${target.session.id}:${revision}`} session={target.session} />}
      </div>
    </section>
  </Backdrop>;
}
