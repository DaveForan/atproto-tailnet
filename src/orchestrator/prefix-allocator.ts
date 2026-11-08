/**
 * @module orchestrator/prefix-allocator
 * Allocates unique IPv4/IPv6 sub-prefixes for new tenants (ADR-0020 §5).
 * Each tenant gets a /24 out of 100.64.0.0/10 (1024 /24s available) and
 * a /64 out of fd7a:115c:a1e0::/48 (65536 /64s available).
 */

import { db } from "../db/index.js";
import { tenants } from "../db/schema.js";
import { ne } from "drizzle-orm";
import { parseCidr, cidrsOverlap } from "../federation/cidr.js";

const IPV4_PARENT = "100.64.0.0/10";
const IPV6_PARENT = "fd7a:115c:a1e0::/48";

/**
 * Allocate a unique /24 within 100.64.0.0/10. The range 100.64.0.0–100.127.255.255
 * gives us 64 /16s × 256 /24s = 16384 possible /24 prefixes. We skip
 * 100.64.0.0/24 (used as infrastructure) and scan for the first free one.
 */
export async function allocateIpv4Prefix(): Promise<string> {
  const existing = await getExistingPrefixes("ipv4");

  // Scan /24s within 100.64.0.0/10: 100.64.0.0 through 100.127.255.0
  for (let second = 64; second < 128; second++) {
    for (let third = 0; third < 256; third++) {
      // Skip the first /24 — reserved for infrastructure
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

/**
 * Allocate a unique /64 within fd7a:115c:a1e0::/48.
 */
export async function allocateIpv6Prefix(): Promise<string> {
  const existing = await getExistingPrefixes("ipv6");

  // Scan /64s within fd7a:115c:a1e0::/48
  // That gives us fd7a:115c:a1e0:0000::/64 through fd7a:115c:a1e0:ffff::/64
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

/**
 * Allocate both IPv4 and IPv6 prefixes for a new tenant.
 * Returns { ipv4Prefix, ipv6Prefix } ready for insertion.
 */
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
