import { useRef, useState } from "react";
import { tryCopy } from "../lib/utils";

export function CopyField({ value, label }: { value: string; label: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");

  const copy = async () => {
    if (await tryCopy(value)) {
      setStatus("copied");
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
    setStatus("manual");
  };

  return (
    <div className="copy-field">
      <div className="inline-form">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={value}
          aria-label={label}
          className="mono"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="btn-sm" onClick={() => { void copy(); }}>
          {status === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <span className="text-dim text-xs" role="status" aria-live="polite">
        {status === "copied" && "Copied to clipboard."}
        {status === "manual" && "Couldn't access the clipboard. The link is selected; press Ctrl+C (Cmd+C on Mac) to copy it."}
      </span>
    </div>
  );
}
