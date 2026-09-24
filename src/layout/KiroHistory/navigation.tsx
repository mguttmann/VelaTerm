//! Kiro history navigation changes only its own query parameter, never the active session or engine.
import { useEffect, useState, type AnchorHTMLAttributes } from "react";
import { useT } from "../../i18n";
import "./kiro-history.css";

export function kiroHistoryUrl(sessionId: string | null): string {
  const url = new URL(window.location.href);
  if (sessionId === null) url.searchParams.delete("kiroHistory");
  else url.searchParams.set("kiroHistory", sessionId);
  return url.href;
}

export function navigateKiroHistory(url: string) {
  window.history.pushState(window.history.state, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useKiroHistoryLocation(): string | null {
  const read = () => new URLSearchParams(window.location.search).get("kiroHistory");
  const [id, setId] = useState(read);
  useEffect(() => {
    const update = () => setId(read());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return id;
}

export function KiroHistoryLink({ sessionId, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children"> & { sessionId: string }) {
  const t = useT();
  return <a {...props} href={kiroHistoryUrl(sessionId)} className={props.className ?? "vlx-btn kiro-history-link"}
    onClick={event => {
      props.onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
        || (props.target && props.target !== "_self") || props.download !== undefined) return;
      event.preventDefault();
      navigateKiroHistory(kiroHistoryUrl(sessionId));
    }}>
    <span>{t("session.showConversation")}</span><span className="kiro-history-mode">{t("chat.mode.readOnly")}</span>
  </a>;
}
