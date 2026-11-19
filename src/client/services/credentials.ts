import { api, tenantApi } from "./api";
import type { CredentialResult, VerifyResult, ChallengeResult } from "../lib/types";

export const credentialsService = {
  issueMembership: (tid: string, subjectDid: string) =>
    tenantApi<CredentialResult>(tid, "/credentials/membership", {
      method: "POST",
      body: JSON.stringify({ subjectDid }),
    }),

  issueRole: (tid: string, subjectDid: string, permissions: string) =>
    tenantApi<CredentialResult>(tid, "/credentials/role", {
      method: "POST",
      body: JSON.stringify({ subjectDid, permissions }),
    }),

  issueCapability: (tid: string, subjectDid: string, capability: string) =>
    tenantApi<CredentialResult>(tid, "/credentials/capability", {
      method: "POST",
      body: JSON.stringify({ subjectDid, capability }),
    }),

  verify: (jwt: string) =>
    api<VerifyResult>("/api/credentials/verify", {
      method: "POST",
      body: JSON.stringify({ jwt }),
    }),

  generateChallenge: (tid: string) =>
    tenantApi<ChallengeResult>(tid, "/credentials/challenge"),
};
