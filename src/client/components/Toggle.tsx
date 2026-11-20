interface ToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ label, description, checked, onChange, disabled }: ToggleProps) {
  return (
    <div className="toggle-row">
      <div className="toggle-label">
        <span>{label}</span>
        {description && <span>{description}</span>}
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
        />
        <span className="slider" />
      </label>
    </div>
  );
}
