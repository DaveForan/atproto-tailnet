import { useId, useState } from "react";

interface InlinePromptProps {
  label: string;
  placeholder?: string;
  submitLabel: string;
  /** Style the submit button as destructive */
  danger?: boolean;
  /** When false (the default) an empty value may be submitted */
  required?: boolean;
  maxLength?: number;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** One labelled text field that opens in the page, in place of a browser prompt. */
export function InlinePrompt({
  label, placeholder, submitLabel, danger, required = false, maxLength, busy, onSubmit, onCancel,
}: InlinePromptProps) {
  const id = useId();
  const [value, setValue] = useState("");
  return (
    <form
      className="inline-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit(value.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <label htmlFor={id}>{label}</label>
      <div className="inline-form">
        <input
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          required={required}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className={`btn-sm${danger ? " btn-danger" : ""}`} disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" className="btn-sm btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
