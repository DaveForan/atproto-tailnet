/**
 * Controller board text (ADR-0036): the originator's public page.
 *
 * Text only. A small subset of Markdown is parsed into blocks: headings
 * (`#`, `##`, `###`), paragraphs, unordered (`-`) and ordered (`1.`) lists,
 * with inline bold (`**x**`), italic (`*x*`) and links (`[label](https://…)`).
 * Everything else — including HTML — is literal text. Used by the server
 * (lint on save, HTML for the public page) and by the dashboard (preview).
 */

export const BOARD_TEXT_MAX_LENGTH = 4000;

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

/**
 * Characters refused on save: control characters (except newline and tab),
 * zero-width characters and direction overrides, which can hide or reorder
 * what a reader sees.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/;

const LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/;

/** An https URL with a host, or null. */
export function safeHttpsUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Reasons the text is refused, or an empty list when it may be saved. */
export function lintBoardText(text: unknown): string[] {
  if (typeof text !== "string") return ["Text is required"];
  const problems: string[] = [];
  if (text.length > BOARD_TEXT_MAX_LENGTH) {
    problems.push(`Text is longer than ${BOARD_TEXT_MAX_LENGTH} characters`);
  }
  if (FORBIDDEN.test(text)) {
    problems.push("Text contains control, invisible or direction-changing characters");
  }
  const links = text.matchAll(new RegExp(LINK, "g"));
  for (const m of links) {
    if (!safeHttpsUrl(m[2])) problems.push(`Link "${m[1]}" must be a full https:// address`);
  }
  return problems;
}

function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const push = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += text;
    else out.push({ kind: "text", text });
  };
  let rest = src;
  while (rest) {
    const link = LINK.exec(rest);
    const bold = /\*\*([^*\n]+)\*\*/.exec(rest);
    const italic = /(?<![*\w])\*([^*\n]+)\*(?![*\w])/.exec(rest);
    const next = [link, bold, italic]
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => a.index - b.index)[0];
    if (!next) {
      push(rest);
      break;
    }
    push(rest.slice(0, next.index));
    if (next === link) {
      const href = safeHttpsUrl(next[2]);
      // A link that is not https stays literal text
      if (href) out.push({ kind: "link", text: next[1], href });
      else push(next[0]);
    } else if (next === bold) {
      out.push({ kind: "bold", text: next[1] });
    } else {
      out.push({ kind: "italic", text: next[1] });
    }
    rest = rest.slice(next.index + next[0].length);
  }
  return out;
}

/** Parse board text into blocks. Never throws; unknown syntax is plain text. */
export function parseBoardText(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const raw of text.slice(0, BOARD_TEXT_MAX_LENGTH).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (!line) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, inline: parseInline(heading[2]) });
    } else if (bullet || numbered) {
      flush();
      const ordered = !bullet;
      const item = parseInline((bullet ?? numbered)![1]);
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineHtml(inline: Inline[]): string {
  return inline
    .map((i) => {
      switch (i.kind) {
        case "bold":
          return `<strong>${esc(i.text)}</strong>`;
        case "italic":
          return `<em>${esc(i.text)}</em>`;
        case "link":
          return `<a href="${esc(i.href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(i.text)}</a>`;
        default:
          return esc(i.text);
      }
    })
    .join("");
}

/** Render blocks as HTML. Every piece of text is escaped; only our own tags appear. */
export function renderBoardHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.kind === "heading") return `<h${b.level + 1}>${inlineHtml(b.inline)}</h${b.level + 1}>`;
      if (b.kind === "paragraph") return `<p>${inlineHtml(b.inline)}</p>`;
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</${tag}>`;
    })
    .join("\n");
}
