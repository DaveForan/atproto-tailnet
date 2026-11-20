import { useCallback, useEffect, useState } from "react";
import { federationService } from "../../services/federation";
import { useSession } from "../../hooks/session";
import { useToast } from "../../components/Toast";
import { useTenantMutation } from "../../hooks/useMutation";
import { useConfirm } from "../../components/ConfirmDialog";
import { errorMessage } from "../../lib/utils";
import type {
  FederationLink,
  BrokerData,
  FederationScope,
  ScopePolicyConfig,
  ScopeUpdate,
} from "../../lib/types";

export const ALL_SCOPES: FederationScope[] = ["local", "regional", "global"];
export const DEFAULT_POLICY: ScopePolicyConfig = { autoAccept: false, verification: "standard" };

const lines = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

/** State and actions of the Federation tab, shared by its cards. */
export function useFederation() {
  const { currentTenant, hasPerm } = useSession();
  const { toastError } = useToast();
  const { mutate, busy } = useTenantMutation();
  const confirm = useConfirm();
  const canManage = hasPerm("manage_settings");

  const [links, setLinks] = useState<FederationLink[]>([]);
  const [posture, setPosture] = useState("selective");
  const [did, setDid] = useState("");
  const [broker, setBroker] = useState<BrokerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [targetSlug, setTargetSlug] = useState("");
  const [requestMessage, setRequestMessage] = useState("");
  const [requestCidrs, setRequestCidrs] = useState("");

  // Accept form state: per-link CIDRs
  const [acceptCidrs, setAcceptCidrs] = useState<Record<string, string>>({});

  const [scopes, setScopes] = useState<FederationScope[]>(["regional"]);
  const [region, setRegion] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [policies, setPolicies] = useState<Partial<Record<FederationScope, ScopePolicyConfig>>>({});

  const loadLinks = useCallback(async () => {
    if (!currentTenant) return;
    const data = await federationService.getLinks(currentTenant.id);
    setLinks(data?.links ?? []);
  }, [currentTenant?.id]);

  const loadPosture = useCallback(async () => {
    if (!currentTenant) return;
    const data = await federationService.getPosture(currentTenant.id);
    if (data) setPosture(data.posture);
  }, [currentTenant?.id]);

  const loadScope = useCallback(async () => {
    if (!currentTenant) return;
    const data = await federationService.getScope(currentTenant.id);
    if (data) {
      setScopes(data.scopes);
      setRegion(data.region ?? "");
      setLat(data.coordinates ? String(data.coordinates[0]) : "");
      setLon(data.coordinates ? String(data.coordinates[1]) : "");
      setPolicies(data.scopePolicies ?? {});
    }
  }, [currentTenant?.id]);

  const loadDid = useCallback(async () => {
    if (!currentTenant) return;
    const data = await federationService.getDid(currentTenant.id);
    if (data) setDid(data.did);
  }, [currentTenant?.id]);

  const loadBroker = useCallback(async () => {
    if (!currentTenant) return;
    const data = await federationService.getBroker(currentTenant.id);
    setBroker(data);
  }, [currentTenant?.id]);

  const loadAll = useCallback(async () => {
    if (!currentTenant) return;
    try {
      const results = await Promise.allSettled([
        loadLinks(), loadPosture(), loadScope(), loadDid(), loadBroker(),
      ]);
      const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      setLoadError(failure ? `Some federation data failed to load: ${errorMessage(failure.reason, "unknown error")}` : null);
    } finally {
      setLoading(false);
    }
  }, [loadLinks, loadPosture, loadScope, loadDid, loadBroker]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const requestFederation = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await mutate(
      (tid) => federationService.requestLink(tid, targetSlug, requestMessage, lines(requestCidrs)),
      { successMsg: "Federation request sent", reload: loadLinks },
    );
    if (ok) {
      setTargetSlug("");
      setRequestMessage("");
      setRequestCidrs("");
    }
  };

  const acceptLink = async (id: string) => {
    const ok = await mutate(
      (tid) => federationService.acceptLink(tid, id, lines(acceptCidrs[id] ?? "")),
      { successMsg: "Federation link accepted", reload: loadLinks },
    );
    if (ok) {
      setAcceptCidrs((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const rejectLink = async (id: string) => {
    await mutate((tid) => federationService.rejectLink(tid, id), {
      successMsg: "Federation link rejected",
      reload: loadLinks,
    });
  };

  const revokeLink = async (id: string) => {
    if (!(await confirm({ title: "Revoke this federation link?", message: "This cannot be undone.", confirmLabel: "Revoke link", danger: true }))) return;
    await mutate((tid) => federationService.revokeLink(tid, id), {
      successMsg: "Federation link revoked",
      reload: loadLinks,
    });
  };

  const savePosture = async (e: React.FormEvent) => {
    e.preventDefault();
    await mutate((tid) => federationService.setPosture(tid, posture), { successMsg: "Federation posture updated" });
  };

  const toggleScope = (sc: FederationScope, on: boolean) => {
    setScopes((prev) =>
      on ? ALL_SCOPES.filter((x) => x === sc || prev.includes(x)) : prev.filter((x) => x !== sc),
    );
  };

  const setPolicy = (sc: FederationScope, patch: Partial<ScopePolicyConfig>) => {
    setPolicies((prev) => ({ ...prev, [sc]: { ...DEFAULT_POLICY, ...prev[sc], ...patch } }));
  };

  const saveScope = async (e: React.FormEvent) => {
    e.preventDefault();
    if (scopes.length === 0) {
      toastError("Select at least one scope");
      return;
    }
    const body: ScopeUpdate = { scopes };
    if (region.trim()) body.region = region.trim();
    if (lat.trim() || lon.trim()) {
      const la = Number(lat);
      const lo = Number(lon);
      if (!lat.trim() || !lon.trim() || Number.isNaN(la) || Number.isNaN(lo)) {
        toastError("Coordinates need both a numeric latitude and longitude");
        return;
      }
      body.coordinates = [la, lo];
    }
    const scopePolicies: Partial<Record<FederationScope, ScopePolicyConfig>> = {};
    for (const sc of scopes) {
      if (policies[sc]) scopePolicies[sc] = policies[sc];
    }
    if (Object.keys(scopePolicies).length > 0) body.scopePolicies = scopePolicies;
    await mutate((tid) => federationService.setScope(tid, body), {
      successMsg: "Federation scope updated",
      reload: loadScope,
    });
  };

  const rotateDid = async () => {
    if (!(await confirm({
      title: "Rotate the collective DID?",
      message: "This invalidates all federation sessions and credentials signed under the current DID.",
      confirmLabel: "Rotate DID",
      danger: true,
    }))) return;
    await mutate((tid) => federationService.rotateDid(tid), {
      successMsg: "Collective DID rotated",
      reload: loadDid,
    });
  };

  return {
    busy, canManage, loading, loadError, loadAll,
    links, did, broker,
    request: { targetSlug, setTargetSlug, requestMessage, setRequestMessage, requestCidrs, setRequestCidrs, requestFederation },
    accept: { acceptCidrs, setAcceptCidrs, acceptLink, rejectLink },
    revokeLink,
    posture: { posture, setPosture, savePosture },
    scope: { scopes, toggleScope, policies, setPolicy, region, setRegion, lat, setLat, lon, setLon, saveScope },
    rotateDid,
  };
}

export type Federation = ReturnType<typeof useFederation>;
