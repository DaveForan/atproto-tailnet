import { useState } from "react";
import { tryCopy } from "../lib/utils";

/**
 * A value to copy (command, token, credential, JSON): wraps inside its box
 * instead of widening the page, with a real Copy button next to it.
 */
export function CodeBlock({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");

  const copy = async () => {
    setStatus((await tryCopy(value)) ? "copied" : "manual");
  };

  return (
    <div>
      <div className="code-row">
        <pre className="code-block" tabIndex={0} aria-label={label}>{value}</pre>
        <button type="button" className="btn-sm btn-ghost" onClick={() => { void copy(); }} aria-label={`Copy ${label.toLowerCase()}`}>
          {status === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <span className="text-dim text-xs" role="status" aria-live="polite">
        {status === "copied" && "Copied to clipboard."}
        {status === "manual" && "Couldn't access the clipboard. Select the text and copy it yourself."}
      </span>
    </div>
  );
}
