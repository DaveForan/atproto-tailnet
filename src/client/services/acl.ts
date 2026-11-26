import { tenantApi } from "./api";
import type { AclData, AclGetResponse } from "../lib/types";

export const aclService = {
  getAcl: (tid: string) =>
    tenantApi<AclGetResponse>(tid, "/acl"),

  setAcl: (tid: string, { acls, hosts }: Pick<AclData, "acls" | "hosts">) =>
    tenantApi(tid, "/acl", {
      method: "PUT",
      body: JSON.stringify({ acls, hosts }),
    }),
};
