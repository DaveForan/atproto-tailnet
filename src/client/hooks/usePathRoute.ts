import { useCallback, useState } from "react";

const DEVICE_PATH = /^\/device\/([0-9a-f]{32})\/?$/;
const INVITE_PATH = /^\/invite\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The page chosen by the URL path: a device sign-in, an invitation, device verification or the dashboard. */
export function usePathRoute() {
  const [path, setPath] = useState(window.location.pathname);

  /** Leaves a path page for the dashboard without a page load. */
  const goHome = useCallback(() => {
    history.replaceState(null, "", "/");
    setPath("/");
  }, []);

  return {
    verifyDevice: path === "/verify-device",
    inviteId: INVITE_PATH.exec(path)?.[1] ?? null,
    deviceId: DEVICE_PATH.exec(path)?.[1] ?? null,
    goHome,
  };
}
