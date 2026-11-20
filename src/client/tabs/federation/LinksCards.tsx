import { Card } from "../../components/Card";
import { Badge, StatusBadge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { relativeTime } from "../../lib/utils";
import type { FederationLink } from "../../lib/types";
import { CidrList, peer } from "./linkParts";
import type { Federation } from "./useFederation";

export function OutgoingCard({ links }: { links: FederationLink[] }) {
  return (
    <Card title="Outgoing requests">
      {links.length > 0 ? (
        <ul className="item-list">
          {links.map((link) => (
            <li key={link.id} className="item-row">
              <div className="item-info">
                <span className="item-header">
                  <span className="item-name">{peer(link)}</span>
                  <StatusBadge status={link.status} />
                </span>
                <CidrList label="Local CIDRs" list={link.localCidrs} />
                <span className="item-detail">{relativeTime(link.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>No outgoing requests.</EmptyState>
      )}
    </Card>
  );
}

export function ActiveLinksCard({ fed, links }: { fed: Federation; links: FederationLink[] }) {
  const { busy, canManage, revokeLink } = fed;
  return (
    <Card title="Active links">
      {links.length > 0 ? (
        <ul className="item-list">
          {links.map((link) => (
            <li key={link.id} className="item-row">
              <div className="item-info">
                <span className="item-header">
                  <span className="item-name">{peer(link)}</span>
                  <Badge variant="role">{link.direction}</Badge>
                </span>
                <CidrList label="Local CIDRs" list={link.localCidrs} />
                <CidrList label="Peer CIDRs" list={link.peerCidrs} />
              </div>
              <button
                type="button"
                className="btn-sm btn-danger"
                aria-label={`Revoke link with ${peer(link)}`}
                onClick={() => revokeLink(link.id)}
                disabled={busy || !canManage}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>No active federation links.</EmptyState>
      )}
    </Card>
  );
}

export function HistoryCard({ links }: { links: FederationLink[] }) {
  return (
    <Card title="History">
      {links.length > 0 ? (
        <ul className="item-list dimmed">
          {links.map((link) => (
            <li key={link.id} className="item-row">
              <div className="item-info">
                <span className="item-header">
                  <span className="item-name">{peer(link)}</span>
                  <StatusBadge status={link.status} />
                  <Badge variant="role">{link.direction}</Badge>
                </span>
                <span className="item-detail">{relativeTime(link.updatedAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>No federation history.</EmptyState>
      )}
    </Card>
  );
}
