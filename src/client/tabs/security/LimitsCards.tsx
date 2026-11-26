import { Card } from "../../components/Card";

export function HibernationCard({
  days,
  onChange,
  busy,
  onSave,
}: {
  days: number;
  onChange: (days: number) => void;
  busy: boolean;
  onSave: (e: React.FormEvent) => void;
}) {
  return (
    <Card title="Hibernation">
      <form className="field" onSubmit={onSave}>
        <label htmlFor="hibernate-days">Hibernate after this many idle days</label>
        <div className="inline-form">
          <input
            id="hibernate-days"
            type="number"
            min={0}
            value={days}
            onChange={(e) => onChange(Number(e.target.value))}
            aria-describedby="hibernate-days-help"
          />
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="help-text" id="hibernate-days-help">0 turns hibernation off.</p>
      </form>
    </Card>
  );
}
