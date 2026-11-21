/** Multi-select as toggle chips. */
export function ChipPicker({
  label,
  options,
  selected,
  onChange,
  empty,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  empty: string;
}) {
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  return (
    <fieldset className="field">
      <legend>{label}</legend>
      {options.length === 0 ? (
        <p className="help-text">{empty}</p>
      ) : (
        <div className="chip-list">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="chip"
              aria-pressed={selected.includes(opt)}
              onClick={() => toggle(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </fieldset>
  );
}
