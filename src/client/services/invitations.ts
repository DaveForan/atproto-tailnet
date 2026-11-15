import { api, tenantApi } from "./api";
import type { SentInvitation } from "../lib/types";

export const invitationService = {
  getSent: (tid: string) =>
    tenantApi<SentInvitation[]>(tid, "/invitations"),

  send: (tid: string, handle: string) =>
    tenantApi(tid, "/invitations", {
      method: "POST",
      body: JSON.stringify({ handle }),
    }),

  revoke: (tid: string, id: string) =>
    tenantApi(tid, `/invitations/${id}`, { method: "DELETE" }),

  accept: (id: string) =>
    api(`/api/invitations/${id}/accept`, { method: "POST" }),

  decline: (id: string) =>
    api(`/api/invitations/${id}/decline`, { method: "POST" }),
};
