import { tenantApi } from "./api";
import type { AclData, AclGetResponse } from "../lib/types";

export const aclService = {
  getAcl: (tid: string) =>
    tenantApi<AclGetResponse>(tid, "/acl"),

  /** The coordinator has no groups: they are left out of its policy. */
  setAcl: (tid: string, { acls, groups, hosts }: Pick<AclData, "acls" | "groups" | "hosts">, coordinatorMode: boolean) =>
    tenantApi(tid, "/acl", {
      method: "PUT",
      body: JSON.stringify(coordinatorMode ? { acls, hosts } : { acls, groups, hosts }),
    }),
};
