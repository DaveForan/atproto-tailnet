import { useState } from "react";
import { useSession } from "../../hooks/session";
import { useTenantMutation } from "../../hooks/useMutation";
import { boardsService, type MyPost } from "../../services/boards";

/** Names of the given roles, in the order of the tailnet's role list. Unknown ids (deleted roles) are left out. */
export function useRoleNames(ids: string[]): string[] {
  const { roles } = useSession();
  return roles.filter((r) => ids.includes(r.id)).map((r) => r.name);
}

/** Choose the roles that may connect to a public service. Nothing chosen = every member. */
export function RolePicker({ selected, onChange, disabled = false }: { selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const { roles } = useSession();
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div>
      <ul className="chip-list">
        <li>
          <button type="button" className="chip" aria-pressed={selected.length === 0} disabled={disabled} onClick={() => onChange([])}>All members</button>
        </li>
        {roles.map((r) => (
          <li key={r.id}>
            <button type="button" className="chip" aria-pressed={selected.includes(r.id)} disabled={disabled} onClick={() => toggle(r.id)}>
              {r.name}
            </button>
          </li>
        ))}
      </ul>
      <p className="help-text">
        {selected.length === 0
          ? "Every member can see this service and connect to it."
          : "Only members with a chosen role see this service and can connect. You and the originator always can. A member who loses the role loses the access."}
      </p>
    </div>
  );
}

/** Shows who may connect to one of my public posts, and changes it. */
export function PostRoles({ post, onChanged }: { post: MyPost; onChanged: () => void }) {
  const names = useRoleNames(post.allowedRoleIds);
  const { mutate, busy } = useTenantMutation({ onError: "Could not change who may connect" });
  const [draft, setDraft] = useState<string[] | null>(null);
  if (draft === null) {
    return (
      <p className="text-dim text-sm">
        {post.allowedRoleIds.length === 0
          ? "For every member"
          : names.length > 0
            ? `For: ${names.join(", ")}`
            : "For roles that no longer exist: only you and the originator"}{" "}
        <button type="button" className="btn-sm btn-ghost" onClick={() => setDraft(post.allowedRoleIds)}>Change</button>
      </p>
    );
  }
  const save = () =>
    mutate((tid) => boardsService.setRoles(tid, post.id, draft), { successMsg: "Saved" }).then((ok) => {
      if (!ok) return;
      setDraft(null);
      onChanged();
    });
  return (
    <div className="form-stack">
      <RolePicker selected={draft} onChange={setDraft} disabled={busy} />
      <div className="btn-group">
        <button type="button" className="btn-sm" disabled={busy} onClick={() => { void save(); }}>{busy ? "Saving..." : "Save"}</button>
        <button type="button" className="btn-sm btn-ghost" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </div>
  );
}
