import { useCallback, useMemo, useReducer } from "react";
import { useToast } from "../../components/Toast";
import type { AclData, AclRule } from "../../lib/types";

/** The policy being edited; nothing reaches the tailnet until it is saved. */
export type AclDraft = Pick<AclData, "acls" | "hosts">;

type DraftAction =
  | { type: "load"; draft: AclDraft }
  | { type: "addRule"; rule: AclRule }
  | { type: "removeRule"; index: number }
  | { type: "setHost"; name: string; ip: string }
  | { type: "removeHost"; name: string };

const EMPTY: AclDraft = { acls: [], hosts: {} };
const ALLOW_ALL: AclDraft = { acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }], hosts: {} };

function without<V>(record: Record<string, V>, key: string): Record<string, V> {
  const next = { ...record };
  delete next[key];
  return next;
}

function reducer(draft: AclDraft, action: DraftAction): AclDraft {
  switch (action.type) {
    case "load":
      return action.draft;
    case "addRule":
      return { ...draft, acls: [...draft.acls, action.rule] };
    case "removeRule":
      return { ...draft, acls: draft.acls.filter((_, i) => i !== action.index) };
    case "setHost":
      return { ...draft, hosts: { ...draft.hosts, [action.name]: action.ip } };
    case "removeHost":
      return { ...draft, hosts: without(draft.hosts, action.name) };
  }
}

/** Unsaved ACL edits; each edit says so in a toast. */
export function useAclDraft() {
  const { toast } = useToast();
  const [draft, dispatch] = useReducer(reducer, EMPTY);

  const edit = useCallback((action: DraftAction, message: string) => {
    dispatch(action);
    toast(`${message} (unsaved)`);
  }, [toast]);

  const actions = useMemo(() => ({
    load: (next: AclDraft) => dispatch({ type: "load", draft: next }),
    addRule: (rule: AclRule) => edit({ type: "addRule", rule }, "Rule added"),
    removeRule: (index: number) => edit({ type: "removeRule", index }, "Rule removed"),
    addHost: (name: string, ip: string) => edit({ type: "setHost", name, ip }, "Host added"),
    removeHost: (name: string) => edit({ type: "removeHost", name }, "Host removed"),
    resetToAllowAll: () => edit({ type: "load", draft: ALLOW_ALL }, "ACL reset to allow-all"),
  }), [edit]);

  return { draft, ...actions };
}

export type AclDraftActions = Omit<ReturnType<typeof useAclDraft>, "draft">;
