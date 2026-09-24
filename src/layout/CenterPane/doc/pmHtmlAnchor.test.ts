import { describe, expect, it } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { emptyAnchorRanges } from "./pmHtmlAnchor";

// Mirrors Milkdown's inline, atomic `html` node, which stores the raw tag in `value`.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block" },
    blockquote: { content: "block+", group: "block" },
    text: { group: "inline" },
    html: { group: "inline", inline: true, atom: true, attrs: { value: { default: "" } } },
  },
});

type Part = string | { html: string };
const inline = (parts: Part[]) => parts.map(p => typeof p === "string" ? schema.text(p) : schema.node("html", { value: p.html }));
const heading = (...parts: Part[]) => schema.node("heading", null, inline(parts));
const paragraph = (...parts: Part[]) => schema.node("paragraph", null, inline(parts));

/** Return the raw tag of every hidden html node, in document order. */
function hiddenTags(doc: PMNode): string[] {
  return emptyAnchorRanges(doc).map(({ from, to }) => {
    const node = doc.nodeAt(from)!;
    expect(from + node.nodeSize).toBe(to);
    return String(node.attrs.value);
  });
}

describe("empty HTML anchors", () => {
  it("hides an opening tag together with the closing tag that follows it", () => {
    const doc = schema.node("doc", null, [heading("1. hello ", { html: '<a id="hello">' }, { html: "</a>" })]);
    expect(hiddenTags(doc)).toEqual(['<a id="hello">', "</a>"]);
  });

  it("hides self-closing anchors and anchors stored as a single node", () => {
    const doc = schema.node("doc", null, [
      paragraph("before ", { html: "<a name='x'/>" }, " after"),
      paragraph({ html: '<A ID="y"></A>' }),
    ]);
    expect(hiddenTags(doc)).toEqual(["<a name='x'/>", '<A ID="y"></A>']);
  });

  it("keeps anchors that wrap visible text and unrelated tags", () => {
    const doc = schema.node("doc", null, [
      paragraph({ html: '<a href="https://example.com">' }, "link", { html: "</a>" }),
      paragraph({ html: "<abbr>" }, { html: "</abbr>" }, { html: "<br>" }),
      paragraph({ html: '<a id="z">' }),
      paragraph({ html: "</a>" }),
    ]);
    expect(hiddenTags(doc)).toEqual([]);
  });

  it("allows `>` inside quoted attribute values", () => {
    const doc = schema.node("doc", null, [paragraph({ html: '<a title="a > b" id="q">' }, { html: "</a>" })]);
    expect(hiddenTags(doc)).toEqual(['<a title="a > b" id="q">', "</a>"]);
  });

  it("finds anchors inside nested blocks", () => {
    const quote = schema.node("blockquote", null, [paragraph("quoted ", { html: '<a id="n">' }, { html: "</a>" })]);
    const doc = schema.node("doc", null, [paragraph("plain"), quote]);
    expect(hiddenTags(doc)).toEqual(['<a id="n">', "</a>"]);
  });
});
