import type { FederationLink } from "../../lib/types";

export const peer = (link: FederationLink) => link.peerName || link.peerDid;

export function CidrList({ label, list }: { label: string; list?: string[] | null }) {
  return list && list.length > 0 ? (
    <span className="item-detail">
      {label}: <span className="mono">{list.join(", ")}</span>
    </span>
  ) : null;
}
