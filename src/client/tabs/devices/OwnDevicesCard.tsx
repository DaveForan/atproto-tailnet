import { useSession } from "../../hooks/session";
import { deviceService } from "../../services/devices";
import { useTenantData } from "../../hooks/useTenantData";
import { useTenantMutation } from "../../hooks/useMutation";
import { Card } from "../../components/Card";
import { Toggle } from "../../components/Toggle";
import { useConfirm } from "../../components/ConfirmDialog";
import type { OwnDeviceApproval } from "../../lib/types";

/** The member's own protection: approval of each new device, and the way to cut all devices and keys off. */
export function OwnDevicesCard() {
  const { user, reloadTenants } = useSession();
  const { data, reload } = useTenantData<OwnDeviceApproval | null>((tid) => deviceService.ownApproval(tid), null);
  const { mutate, busy } = useTenantMutation({ onError: "That did not work", reload });
  const confirm = useConfirm();
  if (!data || data.supported === false || !user) return null;

  const setApproval = async (on: boolean) => {
    if (!on && !(await confirm({
      title: "Stop approving your new devices?",
      message: "Then anyone who has one of your keys adds a device with full access to your devices, and you get no question first.",
      confirmLabel: "Turn off",
      danger: true,
    }))) return;
    await mutate((tid) => deviceService.setOwnApproval(tid, on), { successMsg: on ? "You approve each new device" : "Your keys add devices without approval" });
  };

  const invalidate = async () => {
    if (!(await confirm({
      title: "Invalidate all your devices and keys?",
      message: "Every device of yours in this tailnet loses access now and every key of yours stops working. You add each device again afterwards. This cannot be undone.",
      confirmLabel: "Invalidate all",
      danger: true,
    }))) return;
    await mutate((tid) => deviceService.invalidateDevices(tid, user.id), {
      successMsg: "Your devices are removed and your keys are revoked",
      reload: async () => { await reload(); void reloadTenants(); },
    });
  };

  return (
    <Card title="Protection of my devices">
      <Toggle
        label="Approve each new device"
        description={
          data.locked
            ? "This tailnet requires it for every member, so you cannot turn it off."
            : "A new device of yours has no access until you admit that exact machine on Overview. Applies to your devices only."
        }
        checked={data.on}
        disabled={busy || data.locked}
        onChange={(on) => { void setApproval(on); }}
      />
      <p className="help-text mt-12">
        If a device or a key is lost or stolen, remove that device in the list or revoke that key. To cut everything
        off at once:
      </p>
      <button type="button" className="btn-danger mt-12" disabled={busy} onClick={() => { void invalidate(); }}>
        Invalidate all my devices and keys
      </button>
    </Card>
  );
}
