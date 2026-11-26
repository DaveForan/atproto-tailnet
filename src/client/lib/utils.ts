import { ApiError } from "../services/api";

export function safeUrl(url?: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") return url;
  } catch { /* not a valid URL */ }
  return "";
}

/**
 * A redirect that stays on this site. It mirrors the server's `/auth/login` rule (`^\/[a-z0-9]`).
 * It refuses `//host`, `/\host` and any backslash. It allows "/" and "/#tab".
 */
export function localRedirect(redirect: string | null | undefined): string {
  if (!redirect || redirect.includes("\\")) return "/";
  if (redirect === "/" || /^\/#[a-z0-9-]*$/.test(redirect)) return redirect;
  return /^\/[a-z0-9]/.test(redirect) ? redirect : "/";
}

export async function tryCopy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

const LIMIT_HINTS: Record<string, string> = {
  device_limit: "Device limit reached for this tailnet. Ask the primary admin to raise the device cap or remove unused devices.",
  member_limit: "This tailnet has reached its member limit. Ask the primary admin to raise the member cap.",
  tenant_suspended: "This tailnet has been suspended by the instance operator.",
  single_tailnet: "This instance is in single-tailnet mode, so no additional tailnets or sub-collectives can be created.",
};

export function errorCode(e: unknown): string | undefined {
  return e instanceof ApiError ? e.code : undefined;
}

export function errorMessage(e: unknown, fallback: string): string {
  const code = errorCode(e);
  if (code && LIMIT_HINTS[code]) return LIMIT_HINTS[code];
  return e instanceof Error ? e.message : fallback;
}

/** Error text for a change that needs a trusted device (device lock, machine lock). */
export function trustedDeviceError(e: unknown): string {
  return errorCode(e) === "device_not_trusted"
    ? "This browser is not one of your trusted devices, so it cannot change the lock."
    : errorMessage(e, "That did not work");
}

export function formatExpiry(dateStr: string | null): string {
  if (!dateStr) return "never";
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `in ${Math.max(1, Math.floor(diff / 60000))}m`;
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

export const auditActionLabels: Record<string, string> = {
  device_admitted_by_owner: "Owner admitted device",
  device_admitted: "Admitted device",
  device_refused: "Refused device",
  device_expired: "Waiting device expired",
  devices_invalidated: "Invalidated devices and keys",
  own_device_approval_changed: "Changed own device approval",
  tenant_created: "Created tailnet",
  tenant_deleted: "Deleted tailnet",
  tenant_started: "Started tailnet",
  tenant_stopped: "Stopped tailnet",
  invitation_created: "Sent invitation",
  invitation_accepted: "Accepted invitation",
  invitation_declined: "Declined invitation",
  invitation_revoked: "Revoked invitation",
  member_removed: "Removed member",
  device_added: "Added device",
  device_removed: "Removed device",
  device_renamed: "Renamed device",
  auth_key_generated: "Generated auth key",
  role_created: "Created role",
  role_deleted: "Deleted role",
  role_updated: "Updated role",
  role_assigned: "Assigned role",
  default_role_changed: "Changed default role",
  setting_updated: "Updated setting",
  lockdown_enabled: "Enabled lockdown",
  lockdown_disabled: "Disabled lockdown",
  acl_updated: "Updated ACL policy",
  derp_updated: "Updated DERP config",
  ip_config_updated: "Updated IP config",
  device_approval_approved: "Approved device",
  device_approval_rejected: "Rejected device",
  device_locked: "Locked device",
  device_unlocked: "Unlocked device",
  join_request_created: "Join request submitted",
  join_request_approved: "Approved join request",
  join_request_rejected: "Rejected join request",
  service_device_registered: "Registered service device",
  service_device_approved: "Approved service device",
  service_device_rejected: "Rejected service device",
  service_device_removed: "Removed service device",
  service_registered: "Registered service",
  service_approved: "Approved service",
  service_rejected: "Rejected service",
  service_removed: "Removed service",
  board_post_created: "Created board post",
  board_post_removed: "Removed board post",
  federation_requested: "Requested federation",
  federation_accepted: "Accepted federation",
  federation_rejected: "Rejected federation",
  federation_revoked: "Revoked federation",
  federation_posture_updated: "Updated federation posture",
  federation_scope_updated: "Updated federation scope",
  federation_did_rotated: "Rotated federation DID",
  agent_token_created: "Created agent token",
  agent_token_revoked: "Revoked agent token",
  credential_issued: "Issued credential",
  credential_revoked: "Revoked credential",
  collective_created: "Created sub-collective",
  collective_ejected: "Ejected sub-collective",
  traversal_policy_updated: "Updated traversal policy",
  hibernation_updated: "Updated hibernation",
  board_limits_updated: "Updated board limits",
  plan_updated: "Updated plan",
  limits_updated: "Updated limits",
  route_enabled: "Enabled route",
  route_disabled: "Disabled route",
  route_deleted: "Deleted route",
};
