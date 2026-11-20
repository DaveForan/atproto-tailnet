import { tenantApi } from "./api";

export interface Person {
  id?: string;
  userId: string;
  handle?: string;
  displayName?: string | null;
}

export interface FriendsData {
  friends: Person[];
  incoming: Person[];
  outgoing: Person[];
  blocked: Person[];
}

export interface PortSpec {
  proto: "any" | "tcp" | "udp" | "icmp";
  first: number;
  last: number;
}

export interface Share {
  id: string;
  role: "owner" | "guest";
  other: Person;
  ownerNodeId: string;
  ownerDeviceName: string | null;
  address: string | null;
  ports: PortSpec[];
  guestNodeIds: string[];
  status: "requested" | "offered" | "active" | "expired";
  awaitingMe: boolean;
  expiresAt: string | null;
}

export interface NewShare {
  kind: "request" | "offer";
  friendId: string;
  ownerNodeId: string;
  ports: PortSpec[];
  guestNodeIds?: string[];
  expiresInHours?: number;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const sharingService = {
  friends: (tid: string) => tenantApi<FriendsData>(tid, "/friends"),
  candidates: (tid: string) => tenantApi<{ members: Person[] }>(tid, "/friends/candidates"),
  requestFriend: (tid: string, userId: string) => tenantApi(tid, "/friends", json("POST", { userId })),
  acceptFriend: (tid: string, id: string) => tenantApi(tid, `/friends/${id}/accept`, json("POST", {})),
  removeFriend: (tid: string, id: string) => tenantApi(tid, `/friends/${id}`, json("DELETE")),
  block: (tid: string, userId: string) => tenantApi(tid, "/blocks", json("POST", { userId })),
  unblock: (tid: string, userId: string) => tenantApi(tid, `/blocks/${userId}`, json("DELETE")),
  friendDevices: (tid: string, userId: string) =>
    tenantApi<{ devices: Array<{ id: string; name: string }> }>(tid, `/friends/${userId}/devices`),

  shares: (tid: string) => tenantApi<{ shares: Share[] }>(tid, "/shares"),
  createShare: (tid: string, share: NewShare) => tenantApi(tid, "/shares", json("POST", share)),
  acceptShare: (tid: string, id: string, body: { ports?: PortSpec[]; guestNodeIds?: string[] } = {}) =>
    tenantApi<{ status: string }>(tid, `/shares/${id}/accept`, json("POST", body)),
  endShare: (tid: string, id: string) => tenantApi(tid, `/shares/${id}`, json("DELETE")),
  stopDeviceSharing: (tid: string, nodeId: string) =>
    tenantApi<{ sharesEnded: number }>(tid, `/my-devices/${nodeId}/shares`, json("DELETE")),
};

/** "tcp 22, tcp 8000-8010, ping" */
export function describePorts(ports: PortSpec[]): string {
  return ports
    .map((p) => {
      if (p.proto === "icmp") return "ping";
      const range = p.first === p.last ? String(p.first) : `${p.first}-${p.last}`;
      return p.first === 0 && p.last === 65535 ? `${p.proto} all ports` : `${p.proto} ${range}`;
    })
    .join(", ");
}

/**
 * Parse "22, 443, 8000-8010, udp:53, ping" into port specs. Returns null when
 * any entry is not understood.
 */
export function parsePorts(input: string): PortSpec[] | null {
  const out: PortSpec[] = [];
  for (const raw of input.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (raw === "ping" || raw === "icmp") {
      out.push({ proto: "icmp", first: 0, last: 0 });
      continue;
    }
    const m = /^(?:(tcp|udp):)?(\d{1,5})(?:-(\d{1,5}))?$/.exec(raw);
    if (!m) return null;
    const first = Number(m[2]);
    const last = m[3] ? Number(m[3]) : first;
    if (first < 1 || last > 65535 || first > last) return null;
    out.push({ proto: (m[1] as "tcp" | "udp" | undefined) ?? "tcp", first, last });
  }
  return out.length > 0 ? out : null;
}
