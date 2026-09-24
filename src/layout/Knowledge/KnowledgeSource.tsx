import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { KnowledgeLink } from "./navigation";

type Token = { from: number; to: number; classes: string };
export function KnowledgeSource({ source, file, start, projectId, line, callLines, onHover }: { source: string; file: string; start: number; projectId: string; line: number | null; callLines: number[]; onHover: (line: number | null) => void }) {
  const t = useT(); const ref = useRef<HTMLPreElement>(null); const [tokens, setTokens] = useState<Token[]>([]);
  useEffect(() => {
    let active = true; setTokens([]);
    // The grammar catalogue loads on demand so the symbol viewer keeps CodeMirror out of the entry chunk;
    // until it arrives the source renders unhighlighted, which is also the initial state.
    void (async () => {
      const [{ LanguageDescription }, { languages }, { classHighlighter, highlightTree }] = await Promise.all([
        import("@codemirror/language"),
        import("@codemirror/language-data"),
        import("@lezer/highlight"),
      ]);
      const language = LanguageDescription.matchFilename(languages, file);
      if (!active || !language) return;
      const support = await language.load();
      if (!active) return;
      const result: Token[] = [];
      highlightTree(support.language.parser.parse(source), classHighlighter, (from, to, classes) => result.push({ from, to, classes }));
      if (active) setTokens(result);
    })().catch(() => {});
    return () => { active = false; };
  }, [source, file]);
  useEffect(() => {
    if (line != null) ref.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [line]);
  let offset = 0;
  return <section className="knowledge-source knowledge-card"><div className="knowledge-section-heading"><h3>{t("knowledge.source")}</h3><small title={file}>{file.split(/[/\\]/).pop()}</small></div><pre ref={ref} aria-label={t("knowledge.source")}>{source.split("\n").map((text, i) => {
    const from = offset; offset += text.length + 1; let cursor = from;
    const parts = tokens.filter(token => token.to > from && token.from < from + text.length).flatMap((token, n) => {
      const begin = Math.max(from, token.from); const end = Math.min(from + text.length, token.to);
      const before = source.slice(cursor, begin); cursor = end;
      return [before, <span key={n} className={token.classes}>{source.slice(begin, end)}</span>];
    });
    parts.push(text.slice(cursor - from) || (!text ? " " : ""));
    const number = start + i;
    return <div data-line={number} className={line === number ? "active" : undefined} key={number} onMouseEnter={() => onHover(number)} onMouseLeave={() => onHover(null)}><KnowledgeLink projectId={projectId} values={{ knowledgeLine: number }} className={`knowledge-line${callLines.includes(number) ? " has-call" : ""}`} aria-label={`L${number}`}>{number}</KnowledgeLink><code>{parts}</code></div>;
  })}</pre></section>;
}
