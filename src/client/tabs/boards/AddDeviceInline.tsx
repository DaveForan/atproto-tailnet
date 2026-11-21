import { useEffect, useRef, useState } from "react";
import { useTenant } from "../../hooks/session";
import { useToast } from "../../components/Toast";
import { CodeBlock } from "../../components/CodeBlock";
import { deviceService } from "../../services/devices";
import { boardsService, type MyDevice } from "../../services/boards";
import { errorMessage } from "../../lib/utils";

const POLL_MS = 4000;
const WAIT_MS = 10 * 60 * 1000;

/**
 * Add a device without leaving the form: a single-use key for one hour, the command to run,
 * then a wait until the new device joins. `onJoined` gets the new device.
 */
export function AddDeviceInline({ known, onJoined }: { known: MyDevice[]; onJoined: (device: MyDevice) => void }) {
  const { currentTenant } = useTenant();
  const { toast } = useToast();
  const [state, setState] = useState<"idle" | "busy" | "waiting" | "pending" | "timeout">("idle");
  const [command, setCommand] = useState("");
  const [problem, setProblem] = useState("");
  const knownIds = useRef(new Set(known.map((d) => d.id)));
  const tid = currentTenant?.id;

  useEffect(() => {
    if (state !== "waiting" || !tid) return;
    const started = Date.now();
    let stopped = false;
    const timer = setInterval(() => {
      if (Date.now() - started > WAIT_MS) {
        setState("timeout");
        return;
      }
      boardsService
        .myDevices(tid)
        .then((r) => {
          const fresh = r?.devices.find((d) => !knownIds.current.has(d.id));
          if (stopped || !fresh) return;
          setState("idle");
          setCommand("");
          toast(`${fresh.name} joined`);
          onJoined(fresh);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [state, tid, onJoined, toast]);

  const start = async () => {
    if (!tid) return;
    setState("busy");
    setProblem("");
    knownIds.current = new Set(known.map((d) => d.id));
    try {
      const result = await deviceService.generateAuthKey(tid, { reusable: false, expiresInHours: 1 });
      if (!result) {
        setState("idle");
        return;
      }
      if ("approvalId" in result) {
        setState("pending");
        return;
      }
      setCommand(result.command || `tailscale up --login-server ${result.loginServer} --authkey ${result.key}`);
      setState("waiting");
    } catch (e) {
      setProblem(errorMessage(e, "Could not make a key for a new device"));
      setState("idle");
    }
  };

  if (state === "pending") {
    return <p className="help-text">This tailnet approves each new device. Your request was sent; add the device from the Add device tab after it is approved.</p>;
  }
  if (state === "waiting" || state === "timeout") {
    return (
      <div className="field">
        <span className="field-label">Run this on the new device (Tailscale must be installed)</span>
        <CodeBlock value={command} label="Connect command" />
        <p className="help-text" role="status" aria-live="polite">
          {state === "waiting"
            ? "Waiting for the device to join… The key works once and for one hour."
            : "No new device joined in ten minutes. The key still works until its hour is over; reload this page after you run the command."}
        </p>
      </div>
    );
  }
  return (
    <div>
      <button type="button" className="btn-sm btn-ghost" disabled={state === "busy"} onClick={() => { void start(); }}>
        {state === "busy" ? "Making a key…" : "Add a new device"}
      </button>
      {problem && <p className="help-text" role="alert">{problem}</p>}
    </div>
  );
}
