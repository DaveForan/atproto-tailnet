/**
 * @module orchestrator/coordinator-acl
 * Translates Tailscale-format ACL policy files to and from the coordinator's `coord_acl::AclPolicy`.
 * Rule `src`/`dst` become FilterRule `SrcIPs`/`DstPorts[].IP`, so each must be `*`, an IP, or a CIDR.
 * Security: we reject groups, tags and autoApprovers, because dropping them silently can widen access.
 */

import { isIP } from "node:net";

/** `coord_acl::PortSpec` as serialized by serde (externally tagged enum). */
export type CoordPortSpec = "All" | { Single: number } | { Range: [number, number] };

export interface CoordAclRule {
  src: string;
  dst: string;
  ports: CoordPortSpec[];
}

export interface CoordAclPolicy {
  default_deny: boolean;
  rules: CoordAclRule[];
}

/** ACL policy file (Tailscale format) as accepted by `PUT /api/tenants/:id/acl`. */
export interface AclPolicyFile {
  acls?: Array<{ action: string; src: string[]; dst: string[] }>;
  groups?: Record<string, string[]>;
  hosts?: Record<string, string>;
  tagOwners?: Record<string, string[]>;
  autoApprovers?: {
    routes?: Record<string, string[]>;
    exitNode?: Record<string, string[]> | string[];
  };
  [key: string]: unknown;
}

/** Thrown when a policy cannot be expressed faithfully by the coordinator. */
export class AclTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AclTranslationError";
  }
}

const SUPPORTED_KEYS = new Set(["acls", "groups", "hosts", "tagOwners", "autoApprovers"]);

function isAddressOrCidr(value: string): boolean {
  if (value === "*") return true;
  const slash = value.indexOf("/");
  if (slash === -1) return isIP(value) !== 0;
  const addr = value.slice(0, slash);
  const bits = value.slice(slash + 1);
  const family = isIP(addr);
  if (family === 0 || !/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  return n >= 0 && n <= (family === 4 ? 32 : 128);
}

function isEmpty(obj: unknown): boolean {
  if (obj === undefined || obj === null) return true;
  if (Array.isArray(obj)) return obj.length === 0;
  if (typeof obj === "object") return Object.keys(obj).length === 0;
  return false;
}

function resolveTarget(
  token: string,
  hosts: Record<string, string>,
  where: string,
): string {
  if (isAddressOrCidr(token)) return token;
  if (Object.hasOwn(hosts, token)) return hosts[token];
  throw new AclTranslationError(
    `ACL ${where} "${token}" cannot be expressed in the coordinator — ` +
      `only "*", IP addresses, CIDRs and host aliases are supported ` +
      `(users, groups, tags and autogroups are not)`,
  );
}

function parsePorts(spec: string, where: string): CoordPortSpec[] {
  if (spec === "*") return ["All"];
  const out: CoordPortSpec[] = [];
  for (const part of spec.split(",")) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part.trim());
    if (!m) throw new AclTranslationError(`ACL ${where}: invalid port spec "${spec}"`);
    const first = Number(m[1]);
    const last = m[2] === undefined ? first : Number(m[2]);
    if (first > 65535 || last > 65535 || first > last) {
      throw new AclTranslationError(`ACL ${where}: invalid port range "${part}"`);
    }
    if (first === 0 && last === 65535) out.push("All");
    else out.push(first === last ? { Single: first } : { Range: [first, last] });
  }
  return out;
}

/** Splits an ACL policy file dst entry (`target:ports`, `[v6]:ports`) on the last colon. */
function splitDst(entry: string, where: string): { target: string; ports: string } {
  const bracket = /^\[([^\]]+)\](?:\/(\d{1,3}))?:([^:]+)$/.exec(entry);
  if (bracket) {
    return { target: bracket[2] ? `${bracket[1]}/${bracket[2]}` : bracket[1], ports: bracket[3] };
  }
  const idx = entry.lastIndexOf(":");
  if (idx <= 0 || idx === entry.length - 1) {
    throw new AclTranslationError(`ACL ${where} "${entry}" must be of the form "<target>:<ports>"`);
  }
  return { target: entry.slice(0, idx), ports: entry.slice(idx + 1) };
}

/**
 * Follows Tailscale semantics: only listed rules allow traffic, and empty `acls` denies all.
 * @throws {AclTranslationError} when the coordinator cannot represent the policy.
 */
export function aclPolicyFileToCoordinator(policy: AclPolicyFile): CoordAclPolicy {
  for (const key of Object.keys(policy)) {
    if (!SUPPORTED_KEYS.has(key) && !isEmpty(policy[key])) {
      throw new AclTranslationError(`ACL policy field "${key}" is not supported`);
    }
  }
  if (!isEmpty(policy.groups)) {
    throw new AclTranslationError(
      "ACL groups are not supported — the coordinator has no per-user identities; use host aliases or CIDRs",
    );
  }
  if (!isEmpty(policy.tagOwners)) {
    throw new AclTranslationError("ACL tagOwners are not supported — nodes cannot be tagged");
  }
  const aa = policy.autoApprovers;
  if (aa && (!isEmpty(aa.routes) || !isEmpty(aa.exitNode))) {
    throw new AclTranslationError("ACL autoApprovers are not supported");
  }

  const hosts = policy.hosts ?? {};
  for (const [name, value] of Object.entries(hosts)) {
    if (value === "*" || !isAddressOrCidr(value)) {
      throw new AclTranslationError(`ACL host "${name}" must be an IP address or CIDR (got "${value}")`);
    }
  }

  const rules: CoordAclRule[] = [];
  (policy.acls ?? []).forEach((acl, i) => {
    const where = `rule ${i + 1}`;
    if (acl.action !== "accept") {
      throw new AclTranslationError(`ACL ${where}: only "accept" rules are supported`);
    }
    const srcs = acl.src.map((s) => resolveTarget(s, hosts, `${where} source`));
    const dsts = acl.dst.map((d) => {
      const { target, ports } = splitDst(d, `${where} destination`);
      return {
        dst: resolveTarget(target, hosts, `${where} destination`),
        ports: parsePorts(ports, `${where} destination "${d}"`),
      };
    });
    for (const src of srcs) {
      for (const { dst, ports } of dsts) rules.push({ src, dst, ports });
    }
  });

  return { default_deny: true, rules };
}

function formatPort(p: unknown): string | null {
  if (p === "All") return "*";
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    if (typeof o.Single === "number") return String(o.Single);
    const range = (o.Range ?? o.range) as unknown;
    if (Array.isArray(range) && range.length === 2) {
      const [a, b] = range as [number, number];
      if (a === 0 && b === 65535) return "*";
      return a === b ? String(a) : `${a}-${b}`;
    }
  }
  return null;
}

/** The coordinator does not store host aliases, so rules come back with literal addresses. */
export function coordinatorToAclPolicyFile(raw: unknown): {
  acls: Array<{ action: "accept"; src: string[]; dst: string[] }>;
  groups: Record<string, string[]>;
  hosts: Record<string, string>;
} {
  const policy = (raw ?? {}) as Partial<CoordAclPolicy>;
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const base = { groups: {}, hosts: {} };

  if (rules.length === 0) {
    return {
      ...base,
      acls: policy.default_deny ? [] : [{ action: "accept", src: ["*"], dst: ["*:*"] }],
    };
  }

  return {
    ...base,
    acls: rules.map((r) => {
      const ports = (r.ports ?? []).map(formatPort).filter((p): p is string => p !== null);
      const portStr = ports.includes("*") || ports.length === 0 ? "*" : ports.join(",");
      return { action: "accept" as const, src: [r.src], dst: [`${r.dst}:${portStr}`] };
    }),
  };
}
