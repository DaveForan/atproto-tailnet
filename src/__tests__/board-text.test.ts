/** Controller board text: lint, parse and render (ADR-0036). */
import { describe, it, expect } from "vitest";
import { lintBoardText, parseBoardText, renderBoardHtml, BOARD_TEXT_MAX_LENGTH, safeHttpsUrl } from "../shared/board-text.js";

const html = (t: string) => renderBoardHtml(parseBoardText(t));

describe("lintBoardText", () => {
  it("accepts ordinary text with formatting and https links", () => {
    expect(lintBoardText("# Welcome\n\nA **private** mesh. [Docs](https://example.com/docs)\n\n- one\n- two")).toEqual([]);
  });
  it("refuses non-strings and oversized text", () => {
    expect(lintBoardText(undefined)).toHaveLength(1);
    expect(lintBoardText("x".repeat(BOARD_TEXT_MAX_LENGTH + 1))[0]).toMatch(/longer/);
  });
  it.each(["a\u0000b", "a‮b", "a​b", "a﻿b", "a\u0007b"])("refuses hidden or control characters (%j)", (t) => {
    expect(lintBoardText(t)[0]).toMatch(/invisible|control/);
  });
  it.each(["[x](http://example.com)", "[x](javascript:alert(1))", "[x](//evil.example)", "[x](https://user:pw@evil.example)"])(
    "refuses the link %s",
    (t) => {
      expect(lintBoardText(t)[0]).toMatch(/https/);
    },
  );
  it("allows newlines and tabs", () => {
    expect(lintBoardText("a\n\tb")).toEqual([]);
  });
});

describe("rendering", () => {
  it("escapes HTML and script: it is shown as text, never interpreted", () => {
    const out = html('<script>alert(1)</script> <img src=x onerror="x()"> & "quotes"');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&amp;");
  });
  it("renders headings one level down, paragraphs and lists", () => {
    expect(html("# Title\n\nline one\nline two\n\n- a\n- b\n\n1. x\n2. y")).toBe(
      "<h2>Title</h2>\n<p>line one line two</p>\n<ul><li>a</li><li>b</li></ul>\n<ol><li>x</li><li>y</li></ol>",
    );
  });
  it("renders bold, italic and safe links", () => {
    expect(html("**b** and *i* and [site](https://example.com/a?b=1&c=2)")).toBe(
      '<p><strong>b</strong> and <em>i</em> and <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">site</a></p>',
    );
  });
  it("leaves a non-https link as literal text", () => {
    const out = html("[click](javascript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).toContain("[click](javascript:alert(1))");
  });
  it("cannot break out of an attribute through the link address or label", () => {
    const out = html('[a"b](https://example.com/"onmouseover="x)');
    expect(out).not.toMatch(/href="[^"]*" onmouseover/);
    expect(out).not.toContain('"onmouseover="');
  });
  it("only ever emits its own tags", () => {
    const out = html("# <b>x</b>\n\n- <i>y</i>\n\n**<u>z</u>** [<s>l</s>](https://example.com)");
    const tags = [...out.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(["h2", "ul", "li", "p", "strong", "a"]));
  });
});

describe("safeHttpsUrl", () => {
  it("accepts https only", () => {
    expect(safeHttpsUrl("https://example.com/x")).toBe("https://example.com/x");
    for (const bad of ["http://example.com", "ftp://x", "javascript:1", "data:text/html,x", "/relative", ""]) {
      expect(safeHttpsUrl(bad)).toBeNull();
    }
  });
});
