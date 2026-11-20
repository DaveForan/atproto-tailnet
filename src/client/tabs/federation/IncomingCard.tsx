import { Card } from "../../components/Card";
import { StatusBadge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { relativeTime } from "../../lib/utils";
import type { FederationLink } from "../../lib/types";
import { CidrList, peer } from "./linkParts";
import type { Federation } from "./useFederation";

export function IncomingCard({ fed, links }: { fed: Federation; links: FederationLink[] }) {
  const { busy, canManage } = fed;
  const { acceptCidrs, setAcceptCidrs, acceptLink, rejectLink } = fed.accept;
  return (
    <Card title="Incoming requests">
      {links.length > 0 ? (
        <ul className="post-list">
          {links.map((link) => (
            <li key={link.id} className="post-card">
              <div className="post-head">
                <h4>{peer(link)}</h4>
                <span className="text-dim text-sm">{relativeTime(link.createdAt)}</span>
                <StatusBadge status={link.status} />
              </div>
              <CidrList label="Their CIDRs" list={link.peerCidrs} />
              {link.message && <p className="post-desc">{link.message}</p>}
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void acceptLink(link.id);
                }}
              >
                <div className="field">
                  <label htmlFor={`fed-accept-${link.id}`}>Your CIDRs to share (one per line)</label>
                  <textarea
                    id={`fed-accept-${link.id}`}
                    className="mono"
                    spellCheck={false}
                    value={acceptCidrs[link.id] ?? ""}
                    onChange={(e) =>
                      setAcceptCidrs((prev) => ({
                        ...prev,
                        [link.id]: e.target.value,
                      }))
                    }
                    rows={2}
                  />
                </div>
                <div className="btn-group">
                  <button type="submit" className="btn-sm" disabled={busy || !canManage}>
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn-sm btn-danger btn-apart"
                    onClick={() => rejectLink(link.id)}
                    disabled={busy || !canManage}
                  >
                    Reject
                  </button>
                </div>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>No incoming requests.</EmptyState>
      )}
    </Card>
  );
}
