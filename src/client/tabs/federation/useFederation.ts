import { useCallback, useState } from "react";
import { federationService } from "../../services/federation";
import { useSession } from "../../hooks/session";
import { useToast } from "../../components/Toast";
import { useTenantData } from "../../hooks/useTenantData";
import { useTenantMutation } from "../../hooks/useMutation";
import { useConfirm } from "../../components/ConfirmDialog";
import type {
  FederationLink,
  BrokerData,
  DidData,
  FederationScope,
  PostureData,
  ScopeData,
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
  const { hasPerm } = useSession();
  const { toastError } = useToast();
  const { mutate, busy } = useTenantMutation();
  const confirm = useConfirm();
  const canManage = hasPerm("manage_settings");

  // One hook per part, so each action reloads only what it changed
  const keep = { keepPreviousOnReload: true };
  const linksData = useTenantData((tid) => federationService.getLinks(tid), { links: [] as FederationLink[] }, [], keep);
  const postureData = useTenantData<PostureData | null>((tid) => federationService.getPosture(tid), null, [], keep);
  const scopeData = useTenantData<ScopeData | null>((tid) => federationService.getScope(tid), null, [], keep);
  const didData = useTenantData<DidData | null>((tid) => federationService.getDid(tid), null, [], keep);
  const brokerData = useTenantData<BrokerData | null>((tid) => federationService.getBroker(tid), null, [], keep);
  const parts = [linksData, postureData, scopeData, didData, brokerData];
  const loading = parts.some((p) => p.loading);
  const failure = parts.find((p) => p.error)?.error;
  const loadError = failure ? `Some federation data failed to load: ${failure}` : null;
  const { reload: loadLinks } = linksData;
  const { reload: loadPosture } = postureData;
  const { reload: loadScope } = scopeData;
  const { reload: loadDid } = didData;
  const { reload: loadBroker } = brokerData;
  const loadAll = useCallback(async () => {
    await Promise.all([loadLinks(), loadPosture(), loadScope(), loadDid(), loadBroker()]);
  }, [loadLinks, loadPosture, loadScope, loadDid, loadBroker]);

  const [targetSlug, setTargetSlug] = useState("");
  const [requestMessage, setRequestMessage] = useState("");
  const [requestCidrs, setRequestCidrs] = useState("");

  const [acceptCidrs, setAcceptCidrs] = useState<Record<string, string>>({});

  const [posture, setPosture] = useState("closed");
  const [scopes, setScopes] = useState<FederationScope[]>(["regional"]);
  const [region, setRegion] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [policies, setPolicies] = useState<Partial<Record<FederationScope, ScopePolicyConfig>>>({});

  // Loaded values reset the forms once per load
  const [seenPosture, setSeenPosture] = useState<PostureData | null>(null);
  if (postureData.data && postureData.data !== seenPosture) {
    setSeenPosture(postureData.data);
    setPosture(postureData.data.posture);
  }
  const [seenScope, setSeenScope] = useState<ScopeData | null>(null);
  const scopeLoaded = scopeData.data;
  if (scopeLoaded && scopeLoaded !== seenScope) {
    setSeenScope(scopeLoaded);
    setScopes(scopeLoaded.scopes);
    setRegion(scopeLoaded.region ?? "");
    setLat(scopeLoaded.coordinates ? String(scopeLoaded.coordinates[0]) : "");
    setLon(scopeLoaded.coordinates ? String(scopeLoaded.coordinates[1]) : "");
    setPolicies(scopeLoaded.scopePolicies ?? {});
  }

  const links = linksData.data.links ?? [];
  const did = didData.data?.did ?? "";
  const broker = brokerData.data;

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
