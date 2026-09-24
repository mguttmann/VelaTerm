//! Hides empty HTML anchors such as `<a id="intro"></a>` in WYSIWYG mode.
//!
//! Milkdown displays inline HTML as its literal source. An empty anchor renders nothing in a browser;
//! documents written for GitHub use it as a jump target for table-of-contents links, so showing its
//! tags only clutters the heading or paragraph around it. A node decoration hides the tags; the
//! document, its Markdown serialization, and source mode stay unchanged.
//!
//! CommonMark splits `<a id="x"></a>` into two inline html nodes, one per tag, so an opening tag is
//! hidden only when the node right after it is `</a>`. Self-closing `<a id="x"/>` and a single node
//! holding both tags are hidden on their own.
//!
//! Import every ProseMirror component through `@milkdown/kit/prose/*` to share Milkdown's instances;
//! otherwise decorations fail. This matches pmSearch.ts.

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";

export const pmHtmlAnchorKey = new PluginKey<DecorationSet>("vlxHtmlAnchor");

/** Tag attributes, with quoted values allowed to contain `>`. */
const ATTRS = `(?:\\s+[^\\s"'>/=]+(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\`]+))?)*\\s*`;
const OPEN_TAG = new RegExp(`^<a${ATTRS}>$`, "i");
const CLOSE_TAG = /^<\/a\s*>$/i;
const SELF_CLOSING = new RegExp(`^<a${ATTRS}/>$`, "i");
const EMPTY_PAIR = new RegExp(`^<a${ATTRS}>\\s*</a\\s*>$`, "i");

function htmlValue(node: PMNode | null | undefined): string | null {
  return node?.type.name === "html" ? String(node.attrs.value ?? "").trim() : null;
}

/** Return the document range of every html node that belongs to an empty anchor. */
export function emptyAnchorRanges(doc: PMNode): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  doc.descendants((block, blockPos) => {
    if (!block.inlineContent) return true;
    let pos = blockPos + 1;
    for (let i = 0; i < block.childCount; i++) {
      const child = block.child(i);
      const value = htmlValue(child);
      const end = pos + child.nodeSize;
      if (value !== null && (SELF_CLOSING.test(value) || EMPTY_PAIR.test(value))) {
        ranges.push({ from: pos, to: end });
      } else if (value !== null && OPEN_TAG.test(value) && i + 1 < block.childCount) {
        const next = block.child(i + 1);
        const nextValue = htmlValue(next);
        if (nextValue !== null && CLOSE_TAG.test(nextValue)) {
          ranges.push({ from: pos, to: end }, { from: end, to: end + next.nodeSize });
          pos = end + next.nodeSize;
          i++;
          continue;
        }
      }
      pos = end;
    }
    return false;
  });
  return ranges;
}

function build(doc: PMNode): DecorationSet {
  const decorations = emptyAnchorRanges(doc).map(({ from, to }) => Decoration.node(from, to, { class: "vlx-html-anchor" }));
  return DecorationSet.create(doc, decorations);
}

export function pmHtmlAnchorPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: pmHtmlAnchorKey,
    state: {
      init: (_config, state) => build(state.doc),
      apply: (tr, set) => (tr.docChanged ? build(tr.doc) : set),
    },
    props: {
      decorations: (state) => pmHtmlAnchorKey.getState(state),
    },
  });
}
