import { tenantApi } from "./api";
import type {
  FederationLink,
  PostureData,
  ScopeData,
  ScopeUpdate,
  DidData,
  BrokerData,
} from "../lib/types";

export const federationService = {
  getLinks: (tid: string) =>
    tenantApi<{ links: FederationLink[] }>(tid, "/federation"),

  requestLink: (tid: string, targetSlug: string, message: string, cidrs: string[]) =>
    tenantApi(tid, "/federation", {
      method: "POST",
      body: JSON.stringify({
        targetSlug: targetSlug.trim(),
        message: message || undefined,
        cidrs: cidrs.length > 0 ? cidrs : undefined,
      }),
    }),

  acceptLink: (tid: string, linkId: string, cidrs: string[]) =>
    tenantApi(tid, `/federation/${linkId}/accept`, {
      method: "POST",
      body: JSON.stringify({ cidrs: cidrs.length > 0 ? cidrs : undefined }),
    }),

  rejectLink: (tid: string, linkId: string) =>
    tenantApi(tid, `/federation/${linkId}/reject`, { method: "POST" }),

  revokeLink: (tid: string, linkId: string) =>
    tenantApi(tid, `/federation/${linkId}/revoke`, { method: "POST" }),

  getPosture: (tid: string) =>
    tenantApi<PostureData>(tid, "/federation/posture"),

  setPosture: (tid: string, posture: string) =>
    tenantApi(tid, "/federation/posture", {
      method: "PUT",
      body: JSON.stringify({ posture }),
    }),

  getScope: (tid: string) =>
    tenantApi<ScopeData>(tid, "/federation/scope"),

  setScope: (tid: string, scope: ScopeUpdate) =>
    tenantApi(tid, "/federation/scope", {
      method: "PUT",
      body: JSON.stringify(scope),
    }),

  getDid: (tid: string) =>
    tenantApi<DidData>(tid, "/federation/did"),

  rotateDid: (tid: string) =>
    tenantApi(tid, "/federation/did/rotate", { method: "POST" }),

  getBroker: (tid: string) =>
    tenantApi<BrokerData>(tid, "/federation/broker"),
};
