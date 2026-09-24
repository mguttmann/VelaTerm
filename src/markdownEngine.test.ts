import { describe, expect, it } from "vitest";
import { marked } from "marked";
import type { Token, Tokens } from "marked";

import { md } from "./markdownEngine";

/** Inline token types of the first (paragraph) block, in order. */
function inlineTypes(text: string): string[] {
  const first = md.lexer(text)[0] as Tokens.Paragraph;
  return (first.tokens as Token[]).map((tk) => tk.type);
}

describe("markdown engine", () => {
  it("keeps a lone tilde literal", () => {
    const prompt = "vlinx@host:~/Projects/vlx-term$ source '~/.local/share/integration.bash'";
    expect(inlineTypes(prompt)).not.toContain("del");
    expect(md.parse(prompt, { async: false })).toContain("~/Projects/vlx-term$");
  });

  it("still renders the doubled form as strikethrough", () => {
    const tokens = md.lexer("a ~~struck~~ b")[0] as Tokens.Paragraph;
    const del = (tokens.tokens as Token[]).find((tk) => tk.type === "del") as Tokens.Del | undefined;
    expect(del?.text).toBe("struck");
  });

  it("leaves a doubled run unmatched by a single closing tilde alone", () => {
    expect(inlineTypes("a ~~open~ close")).not.toContain("del");
  });
});

describe("CJK emphasis", () => {
  /** Rendered HTML of `text`, minus the paragraph wrapper. */
  function html(text: string): string {
    return md.parse(text, { async: false }).replace(/^<p>|<\/p>\n?$/g, "");
  }

  it("closes a bold run wedged between CJK punctuation and a CJK character", () => {
    expect(html("**一、拿不到可交付的包。**打包、签名仍然暂缓。")).toBe(
      "<strong>一、拿不到可交付的包。</strong>打包、签名仍然暂缓。",
    );
  });

  it("closes a bold run that ends on Latin text but butts against CJK", () => {
    expect(html("**二、Cookie 和密码不持久化。**macOS 上是假钥匙串。")).toBe(
      "<strong>二、Cookie 和密码不持久化。</strong>macOS 上是假钥匙串。",
    );
  });

  it("handles the single-asterisk form the same way", () => {
    expect(html("*强调。*后面")).toBe("<em>强调。</em>后面");
  });

  it("opens a run that follows a CJK character", () => {
    expect(html("前面**强调。**后面")).toBe("前面<strong>强调。</strong>后面");
  });

  it("keeps stock behaviour for Latin text", () => {
    expect(html("a**b**c and *x* and 2 * 3 * 4")).toBe(
      "a<strong>b</strong>c and <em>x</em> and 2 * 3 * 4",
    );
  });

  it("leaves an unpaired asterisk alone", () => {
    expect(html("乘号 3 * 4 在这里")).toBe("乘号 3 * 4 在这里");
  });

  it("still refuses intraword underscores so identifiers survive", () => {
    expect(html("变量 foo_bar_baz 的值")).toBe("变量 foo_bar_baz 的值");
    expect(html("变量_bar_的值")).toBe("变量_bar_的值");
  });

  it("nests emphasis inside a CJK bold run", () => {
    expect(html("**外层*内层。*外层。**结束")).toBe(
      "<strong>外层<em>内层。</em>外层。</strong>结束",
    );
  });

  it("keeps closing a run that already worked without punctuation", () => {
    expect(html("**加粗**macOS 上")).toBe("<strong>加粗</strong>macOS 上");
    expect(html("前面**强调**后面")).toBe("前面<strong>强调</strong>后面");
    expect(html("**A**、**B**、**C**")).toBe(
      "<strong>A</strong>、<strong>B</strong>、<strong>C</strong>",
    );
  });

  it("pairs several bold runs across one line", () => {
    expect(html("**第一。**第二。**第三。**第四。")).toBe(
      "<strong>第一。</strong>第二。<strong>第三。</strong>第四。",
    );
  });

  it("covers kana and Hangul as well as Han", () => {
    expect(html("日本語の**強調。**続き")).toBe("日本語の<strong>強調。</strong>続き");
    expect(html("한국어 **강조。**계속")).toBe("한국어 <strong>강조。</strong>계속");
  });

  it("nests emphasis with Latin text inside a CJK bold run", () => {
    expect(html("**外层。*inner*外层。**结束")).toBe(
      "<strong>外层。<em>inner</em>外层。</strong>结束",
    );
  });

  it("leaves code spans and unpaired markers untouched", () => {
    expect(html("路径 `a*b` 不变")).toBe("路径 <code>a*b</code> 不变");
    expect(html("结尾没有配对 **只有开头")).toBe("结尾没有配对 **只有开头");
  });

  it("does not leak the patched rules into the stock marked export", () => {
    expect(marked.parse("**标题。**正文", { async: false })).toContain("**标题。**正文");
  });
});
