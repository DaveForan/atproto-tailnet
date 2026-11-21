import { Card } from "../../components/Card";
import { useConfirm } from "../../components/ConfirmDialog";

export function DeviceAccessCard({
  mode,
  onChange,
  busy = false,
}: {
  mode: "open" | "member";
  onChange: (next: "open" | "member") => void;
  busy?: boolean;
}) {
  const confirm = useConfirm();
  return (
    <Card title="Device access">
      <p className="card-description">
        {mode === "member"
          ? "Members only: a device reaches its owner's other devices, plus services they connected to and shares between friends."
          : "Open: every device in this tailnet can reach every other device on every port."}
      </p>
      <button
        type="button"
        className="btn-sm"
        disabled={busy}
        onClick={async () => {
          const next = mode === "member" ? "open" : "member";
          if (next === "member" && !(await confirm({
            title: "Switch to members-only access?",
            message: "Devices of different members will stop reaching each other until they connect to a service or share.",
            confirmLabel: "Switch",
          }))) return;
          onChange(next);
        }}
      >
        {mode === "member" ? "Switch to open" : "Switch to members only"}
      </button>
    </Card>
  );
}
