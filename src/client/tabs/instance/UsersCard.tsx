import { Card } from "../../components/Card";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { useConfirm } from "../../components/ConfirmDialog";
import { useSession } from "../../hooks/session";
import { operatorService } from "../../services/operator";
import type { OperatorUser } from "../../lib/types";
import type { RunAction } from "./types";

export function UsersCard({ users, busy, run }: { users: OperatorUser[]; busy: boolean; run: RunAction }) {
  const { user } = useSession();
  const confirm = useConfirm();

  const toggleUser = async (u: OperatorUser) => {
    if (!u.disabled) {
      const n = u.tenantCount;
      const msg =
        `They won't be able to sign in, and their tokens and connected apps stop working. ` +
        `This also removes them from ${n === 1 ? "their tailnet" : `all ${n} of their tailnets`} ` +
        `and deletes their devices. Re-enabling them later does not restore memberships or devices.`;
      if (!(await confirm({ title: `Disable @${u.handle}?`, message: msg, confirmLabel: "Disable user", danger: true }))) return;
    }
    void run(
      () => operatorService.setUserDisabled(u.id, !u.disabled),
      u.disabled ? `@${u.handle} enabled` : `@${u.handle} disabled`,
    );
  };

  return (
    <Card title="Users">
      {users.length === 0 ? (
        <EmptyState>No users yet.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table stack">
            <caption className="sr-only">All users who have signed in to this instance</caption>
            <thead>
              <tr>
                <th scope="col">Handle</th>
                <th scope="col">DID</th>
                <th scope="col">Tailnets</th>
                <th scope="col"><span className="sr-only">Badges</span></th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td data-label="Handle">@{u.handle}</td>
                  <td data-label="DID" className="mono text-xs">{u.did}</td>
                  <td data-label="Tailnets">{u.tenantCount}</td>
                  <td className="cell-badges">
                    <span className="badge-stack">
                      {u.isOperator && <Badge variant="originator">operator</Badge>}
                      {u.disabled && <Badge variant="stopped">disabled</Badge>}
                      {u.id === user?.id && <Badge variant="role">you</Badge>}
                    </span>
                  </td>
                  <td className="cell-actions">
                    {!u.isOperator && u.id !== user?.id && (
                      <button
                        type="button"
                        className={`btn-sm ${u.disabled ? "" : "btn-danger"}`}
                        disabled={busy}
                        onClick={() => { void toggleUser(u); }}
                        aria-label={`${u.disabled ? "Enable" : "Disable"} @${u.handle}`}
                      >
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
