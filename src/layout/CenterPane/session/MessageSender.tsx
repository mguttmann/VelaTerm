import { useT } from "../../../i18n";
import type { MessageOrigin } from "../../../ipc/chat";
import { kindIconEl } from "../../sessionViewers/sessionMeta";

/** Keep sender names and workflow roles consistent before and after delivery. */
export function messageSenderName(origin: MessageOrigin, t: ReturnType<typeof useT>): string {
  const role = origin.role === "plan" ? t("chat.origin.plan")
    : origin.role === "exec" ? t("chat.origin.exec") : null;
  return role ? `${origin.name} · ${role}` : origin.name;
}

export function MessageSender({ origin }: { origin: MessageOrigin }) {
  const t = useT();
  const name = messageSenderName(origin, t);
  return (
    <span className="sv-message-sender" title={name}>
      <span className="sv-message-sender-icon" aria-hidden>{kindIconEl(origin.agent, 14)}</span>
      <span className="sv-message-sender-name">{name}</span>
    </span>
  );
}
