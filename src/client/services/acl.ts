import { tenantApi } from "./api";
import type { AclData, AclGetResponse } from "../lib/types";

export const aclService = {
  getAcl: (tid: string) =>
    tenantApi<AclGetResponse>(tid, "/acl"),

  setAcl: (tid: string, policy: AclData) =>
    tenantApi(tid, "/acl", {
      method: "PUT",
      body: JSON.stringify(policy),
    }),
};
