//! Shared `marked` instance for every Markdown surface in the app.
//!
//! Two deliberate departures from stock GFM live here.
//!
//! 1. GFM accepts one *or* two tildes as strikethrough, so a pasted shell prompt such as
//!    `vlinx@host:~/Projects` pairs its tilde with the next one on the line and strikes out
//!    everything in between. Terminal output carries tildes far more often than transcripts carry
//!    strikethrough, so only the doubled `~~` form is treated as markup here; a lone `~` stays a
//!    literal character.
//!
//! 2. CommonMark decides whether a run of `*` may open or close emphasis by looking at the
//!    character on either side of it, sorting every character into whitespace, punctuation, or
//!    neither. Han, kana and Hangul all fall into "neither", so `**小标题。**正文` leaves its closing
//!    run between a full-width period and a Han character — a position the spec reserves for an
//!    *opening* run, and the asterisks reach the page verbatim. Text written without spaces between
//!    words runs into this constantly, so the rules below count CJK as punctuation and let any run
//!    that follows a CJK character close. `_` keeps its stock behaviour; only `*` is relaxed.
//!
//! Every module that renders Markdown must import this instance instead of the default `marked`
//! export, otherwise the surface falls back to the stock rules.

import { Marked, Tokenizer } from "marked";
import type { Rules, Tokens } from "marked";

/**
 * Scripts that are written without spaces between words, spelled as character-class ranges so they
 * can be spliced into the delimiter patterns below.
 */
const CJK = [
  "\\u2E80-\\u303F", // CJK and Kangxi radicals, CJK symbols and punctuation
  "\\u3040-\\u33FF", // kana, Bopomofo, Hangul jamo, enclosed and squared CJK forms
  "\\u3400-\\u4DBF", // unified ideographs extension A
  "\\u4E00-\\u9FFF", // unified ideographs
  "\\uAC00-\\uD7AF", // Hangul syllables
  "\\uF900-\\uFAFF", // compatibility ideographs
  "\\uFE30-\\uFE4F", // compatibility forms
  "\\uFF00-\\uFFEF", // half-width and full-width forms
  "\\u{20000}-\\u{3FFFF}", // unified ideographs extension B onwards
].join("");

/**
 * Expands the placeholder names in one of marked's delimiter patterns, optionally folding CJK into
 * the punctuation class. The names and the order they are substituted in mirror marked's own
 * construction: the longer names have to go first, since each one ends with the name of the next.
 *
 * `gfm` selects the variants that exempt `~` from the punctuation classes, which marked uses for the
 * rules that have to coexist with GFM strikethrough.
 */
function expand(source: string, gfm: boolean, cjk: boolean): string {
  const extra = cjk ? CJK : "";
  const notTilde = gfm ? "(?!~)" : "";
  return source
    .replace(/notPunctSpace/g, gfm ? `(?:[^\\s\\p{P}\\p{S}${extra}]|~)` : `[^\\s\\p{P}\\p{S}${extra}]`)
    .replace(/punctSpace/g, `${notTilde}[\\s\\p{P}\\p{S}${extra}]`)
    .replace(/punct/g, `${notTilde}[\\p{P}\\p{S}${extra}]`);
}

/**
 * The inline rules `emStrong` consults, copied verbatim from marked and then adjusted in three
 * places. Which variant each one needs — tilde-exempt or not — follows marked's GFM rule set: only
 * the `*` rules coexist with strikethrough.
 *
 * The first adjustment is `expand(…, cjk = true)`, which folds CJK into the punctuation class.
 *
 * The other two live in the closing-delimiter pattern and together say: a `*` run preceded by a CJK
 * character always closes. The pattern sorts each run into opening or closing by looking at the
 * character on either side, and its fifth branch — punctuation before, a letter after — calls that
 * an opening run, which is what strands the asterisks in `**……不持久化。**macOS`. So the fifth branch
 * now declines runs preceded by CJK, and the seventh, which does treat such runs as closing,
 * accepts any non-space character after the run instead of punctuation alone. Latin text comes out
 * byte for byte as before, since the fifth branch still claims every run it used to.
 *
 * `_` is left exactly as CommonMark defines it, which is why `emStrongRDelimUnd` is absent and why
 * the two halves of `emStrongLDelim` are expanded differently. CommonMark refuses to open or close
 * `_` emphasis inside a word so that identifiers such as `snake_case_name` survive intact, and that
 * protection matters more in a terminal app than symmetry between the two markers does.
 */
const cjkInlineRules = {
  punctuation: new RegExp(expand("^((?![*_])punctSpace)", false, true), "u"),
  emStrongLDelim: new RegExp(
    expand("^(?:\\*+(?:((?!\\*)punct)|([^\\s*]))?)", true, true) +
      "|" +
      expand("^_+(?:((?!_)punct)|([^\\s_]))?", true, false),
    "u",
  ),
  emStrongRDelimAst: new RegExp(
    expand(
      "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)" +
        "|[^*]+(?=[^*])" +
        "|(?!\\*)punct(\\*+)(?=[\\s]|$)" +
        "|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)" +
        `|(?!\\*)(?![${CJK}])punctSpace(\\*+)(?=notPunctSpace)` +
        "|[\\s](\\*+)(?!\\*)(?=punct)" +
        "|(?!\\*)punct(\\*+)(?!\\*)(?=\\S)" +
        "|notPunctSpace(\\*+)(?=notPunctSpace)",
      true,
      true,
    ),
    "gu",
  ),
} as const;

const stockEmStrong = Tokenizer.prototype.emStrong;

/**
 * Runs marked's own emphasis tokenizer against the CJK-aware rules. Swapping `rules` for the call
 * rather than mutating it keeps the patch local to this instance: marked hands the same rule-set
 * object to every `Marked` in the process. Nested calls (emphasis inside emphasis) restore the
 * rules they found, so the outermost call still puts the originals back.
 */
function cjkEmStrong(
  this: Tokenizer,
  src: string,
  maskedSrc: string,
  prevChar?: string,
): Tokens.Em | Tokens.Strong | undefined {
  const stockRules: Rules = this.rules;
  this.rules = { ...stockRules, inline: { ...stockRules.inline, ...cjkInlineRules } };
  try {
    return stockEmStrong.call(this, src, maskedSrc, prevChar);
  } finally {
    this.rules = stockRules;
  }
}

export const md = new Marked({
  tokenizer: {
    del(src) {
      if (!src.startsWith("~~")) return undefined;
      // `false` (unlike `undefined`) hands the `~~` form back to marked's own tokenizer, keeping its
      // delimiter-run rules intact.
      return false;
    },
    emStrong: cjkEmStrong,
  },
});
