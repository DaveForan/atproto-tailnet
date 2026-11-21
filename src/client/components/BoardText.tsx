import { parseBoardText, type Inline } from "../../shared/board-text";

function InlineText({ inline }: { inline: Inline[] }) {
  return (
    <>
      {inline.map((i, n) => {
        if (i.kind === "bold") return <strong key={n}>{i.text}</strong>;
        if (i.kind === "italic") return <em key={n}>{i.text}</em>;
        if (i.kind === "link") {
          return (
            <a key={n} href={i.href} target="_blank" rel="noopener noreferrer nofollow">
              {i.text}
            </a>
          );
        }
        return <span key={n}>{i.text}</span>;
      })}
    </>
  );
}

/** Renders controller board text as plain elements. It never interprets the text as HTML. */
export function BoardText({ text }: { text: string }) {
  const blocks = parseBoardText(text);
  if (blocks.length === 0) return null;
  return (
    <div className="board-text">
      {blocks.map((b, n) => {
        if (b.kind === "heading") {
          const Tag = (["h2", "h3", "h4"] as const)[b.level - 1];
          return (
            <Tag key={n}>
              <InlineText inline={b.inline} />
            </Tag>
          );
        }
        if (b.kind === "paragraph") {
          return (
            <p key={n}>
              <InlineText inline={b.inline} />
            </p>
          );
        }
        const List = b.ordered ? "ol" : "ul";
        return (
          <List key={n}>
            {b.items.map((item, k) => (
              <li key={k}>
                <InlineText inline={item} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
