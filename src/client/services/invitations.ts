import { api, tenantApi } from "./api";
import type { InvitationDetail, SentInvitation } from "../lib/types";

export function inviteeBody(input: string): { did: string } | { handle: string } {
  const v = input.trim().replace(/^@/, "");
  return v.startsWith("did:") ? { did: v } : { handle: v };
}

export const invitationService = {
  getSent: (tid: string) =>
    tenantApi<SentInvitation[]>(tid, "/invitations"),

  send: (tid: string, invitee: string) =>
    tenantApi<SentInvitation>(tid, "/invitations", {
      method: "POST",
      body: JSON.stringify(inviteeBody(invitee)),
    }),

  revoke: (tid: string, id: string) =>
    tenantApi(tid, `/invitations/${id}`, { method: "DELETE" }),

  get: (id: string) =>
    api<InvitationDetail>(`/api/invitations/${encodeURIComponent(id)}`),

  accept: (id: string) =>
    api(`/api/invitations/${id}/accept`, { method: "POST" }),

  decline: (id: string) =>
    api(`/api/invitations/${id}/decline`, { method: "POST" }),
};
