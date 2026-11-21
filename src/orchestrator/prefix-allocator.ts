/**
 * @module orchestrator/prefix-allocator
 * Allocates unique per-tenant sub-prefixes (ADR-0020 §5).
 * Each tenant gets a /24 from 100.64.0.0/10 and a /64 from fd7a:115c:a1e0::/48.
 */

import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { ne } from "drizzle-orm";
import { parseCidr, cidrsOverlap } from "../federation/cidr.js";

const IPV4_PARENT = "100.64.0.0/10";
const IPV6_PARENT = "fd7a:115c:a1e0::/48";

export async function allocateIpv4Prefix(): Promise<string> {
  const existing = await getExistingPrefixes("ipv4");

  for (let second = 64; second < 128; second++) {
    for (let third = 0; third < 256; third++) {
      // 100.64.0.0/24 is reserved for infrastructure
      if (second === 64 && third === 0) continue;

      const candidate = `100.${second}.${third}.0/24`;
      const parsed = parseCidr(candidate);
      if (!parsed) continue;

      let overlaps = false;
      for (const ex of existing) {
        if (cidrsOverlap(parsed, ex)) {
          overlaps = true;
          break;
        }
      }

      if (!overlaps) return candidate;
    }
  }

  throw new Error("No free IPv4 /24 prefixes available in 100.64.0.0/10");
}

export async function allocateIpv6Prefix(): Promise<string> {
  const existing = await getExistingPrefixes("ipv6");

  for (let sub = 1; sub <= 0xffff; sub++) {
    const hex = sub.toString(16).padStart(4, "0");
    const candidate = `fd7a:115c:a1e0:${hex}::/64`;
    const parsed = parseCidr(candidate);
    if (!parsed) continue;

    let overlaps = false;
    for (const ex of existing) {
      if (cidrsOverlap(parsed, ex)) {
        overlaps = true;
        break;
      }
    }

    if (!overlaps) return candidate;
  }

  throw new Error("No free IPv6 /64 prefixes available in fd7a:115c:a1e0::/48");
}

async function getExistingPrefixes(family: "ipv4" | "ipv6") {
  const column = family === "ipv4" ? tenants.ipv4Prefix : tenants.ipv6Prefix;
  const rows = await db
    .select({ prefix: column })
    .from(tenants);

  return rows
    .map((r) => parseCidr(r.prefix))
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

export async function allocateTenantPrefixes(): Promise<{
  ipv4Prefix: string;
  ipv6Prefix: string;
}> {
  const [ipv4Prefix, ipv6Prefix] = await Promise.all([
    allocateIpv4Prefix(),
    allocateIpv6Prefix(),
  ]);
  return { ipv4Prefix, ipv6Prefix };
}
