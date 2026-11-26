import { useSession } from "../../hooks/session";
import { NotificationsCard } from "../security/NotificationsCard";

export function NotificationsSection() {
  const { hasPerm } = useSession();
  return (
    <div className="tab-content">
      <NotificationsCard canEdit={hasPerm("manage_settings")} />
    </div>
  );
}
