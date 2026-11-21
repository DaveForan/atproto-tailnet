/**
 * @module federation/cidr
 * CIDR parsing, normalization, and overlap checking for federation links (ADR-0019 §6).
 */

export interface ParsedCidr {
  prefix: string;
  address: bigint;
  mask: bigint;
  bits: number;
  family: 4 | 6;
  normalized: string;
}

export function parseCidr(cidr: string): ParsedCidr | null {
  const trimmed = cidr.trim();
  const slashIdx = trimmed.lastIndexOf("/");
  if (slashIdx === -1) return null;

  const addrStr = trimmed.slice(0, slashIdx);
  const bitsStr = trimmed.slice(slashIdx + 1);
  if (!/^\d{1,3}$/.test(bitsStr)) return null;
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0) return null;

  if (addrStr.includes(":")) {
    return parseIpv6Cidr(addrStr, bits);
  }
  return parseIpv4Cidr(addrStr, bits);
}

function parseIpv4Cidr(addrStr: string, bits: number): ParsedCidr | null {
  if (bits > 32) return null;
  const parts = addrStr.split(".");
  if (parts.length !== 4) return null;

  let address = 0n;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255 || part !== String(n)) return null;
    address = (address << 8n) | BigInt(n);
  }

  const mask = bits === 0 ? 0n : ((1n << 32n) - 1n) << BigInt(32 - bits);
  const network = address & mask;

  const normalizedAddr = [
    Number((network >> 24n) & 0xFFn),
    Number((network >> 16n) & 0xFFn),
    Number((network >> 8n) & 0xFFn),
    Number(network & 0xFFn),
  ].join(".");

  return {
    prefix: `${addrStr}/${bits}`,
    address: network,
    mask,
    bits,
    family: 4,
    normalized: `${normalizedAddr}/${bits}`,
  };
}

function parseIpv6Cidr(addrStr: string, bits: number): ParsedCidr | null {
  if (bits > 128) return null;

  const expanded = expandIpv6(addrStr);
  if (!expanded) return null;

  const groups = expanded.split(":");
  if (groups.length !== 8) return null;

  let address = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const n = parseInt(group, 16);
    if (isNaN(n) || n < 0 || n > 0xFFFF) return null;
    address = (address << 16n) | BigInt(n);
  }

  const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) << BigInt(128 - bits);
  const network = address & mask;

  const normalizedGroups: string[] = [];
  for (let i = 7; i >= 0; i--) {
    normalizedGroups.unshift(
      ((network >> BigInt(i * 16)) & 0xFFFFn).toString(16),
    );
  }

  return {
    prefix: `${addrStr}/${bits}`,
    address: network,
    mask,
    bits,
    family: 6,
    normalized: `${normalizedGroups.join(":")}/${bits}`,
  };
}

function expandIpv6(addr: string): string | null {
  if (addr.includes("::")) {
    if (addr.split("::").length !== 2) return null;
    const [left, right] = addr.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 0) return null;
    const fill = Array(missing).fill("0");
    return [...leftGroups, ...fill, ...rightGroups].join(":");
  }
  return addr;
}

export function cidrsOverlap(a: ParsedCidr, b: ParsedCidr): boolean {
  if (a.family !== b.family) return false;

  const narrowerBits = Math.min(a.bits, b.bits);
  const totalBits = a.family === 4 ? 32 : 128;
  const compareMask =
    narrowerBits === 0
      ? 0n
      : ((1n << BigInt(totalBits)) - 1n) << BigInt(totalBits - narrowerBits);

  return (a.address & compareMask) === (b.address & compareMask);
}

export function checkCidrOverlaps(
  incoming: ParsedCidr[],
  localRanges: ParsedCidr[],
  existingPeerCidrs: ParsedCidr[],
): string[] {
  const errors: string[] = [];

  for (const cidr of incoming) {
    for (const local of localRanges) {
      if (cidrsOverlap(cidr, local)) {
        errors.push(
          `${cidr.normalized} overlaps with local range ${local.normalized}`,
        );
      }
    }

    for (const existing of existingPeerCidrs) {
      if (cidrsOverlap(cidr, existing)) {
        errors.push(
          `${cidr.normalized} overlaps with existing peer CIDR ${existing.normalized}`,
        );
      }
    }
  }

  return errors;
}

/** True when `subnet` lies entirely inside `parent` (same family, same or longer prefix). */
export function isSubnetOf(subnet: ParsedCidr, parent: ParsedCidr): boolean {
  if (subnet.family !== parent.family) return false;
  if (subnet.bits < parent.bits) return false;

  const totalBits = parent.family === 4 ? 32 : 128;
  const parentMask =
    parent.bits === 0
      ? 0n
      : ((1n << BigInt(totalBits)) - 1n) << BigInt(totalBits - parent.bits);

  return (subnet.address & parentMask) === (parent.address & parentMask);
}

const DEFAULT_ROUTES = ["0.0.0.0/0", "::/0"];

/** A default route in any spelling (`0.0.0.0/0`, `::/0`, `1.2.3.4/0`, …). */
export function isDefaultRoute(cidr: string): boolean {
  if (DEFAULT_ROUTES.includes(cidr.trim())) return true;
  return parseCidr(cidr)?.bits === 0;
}

function parseAll(cidrs: (string | null | undefined)[]): ParsedCidr[] {
  const out: ParsedCidr[] = [];
  for (const c of cidrs) {
    if (!c) continue;
    const parsed = parseCidr(c);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Validates CIDRs a local collective offers to share (ADR-0019 §6). Returns normalised prefixes or refusal reasons.
 * Each must parse and must not be a default route.
 * Each must lie inside the tenant's tailnet range or one of its approved subnet routes.
 */
export function validateLocalOffer(
  offered: string[],
  tenantIpv4Prefix: string | null,
  tenantIpv6Prefix: string | null,
  approvedSubnets: string[] = [],
): { cidrs: string[]; errors: string[] } {
  const ownRanges = parseAll([tenantIpv4Prefix, tenantIpv6Prefix, ...approvedSubnets]);
  const cidrs: string[] = [];
  const errors: string[] = [];
  for (const cidr of offered) {
    const parsed = parseCidr(cidr);
    if (!parsed) {
      errors.push(`Invalid CIDR: ${cidr}`);
      continue;
    }
    if (parsed.bits === 0) {
      errors.push(`Default route ${parsed.normalized} cannot be shared`);
      continue;
    }
    if (!ownRanges.some((range) => isSubnetOf(parsed, range))) {
      errors.push(`${parsed.normalized} is not within your tenant's IP range or an approved subnet route`);
      continue;
    }
    if (!cidrs.includes(parsed.normalized)) cidrs.push(parsed.normalized);
  }
  return { cidrs, errors };
}

/**
 * Validates CIDRs a peer offers to a local collective (ADR-0019 §6). Returns normalised prefixes or refusal reasons.
 * Each must parse and must not be a default route.
 * Each must not overlap the local range or prefixes imported over other active links.
 */
export function validatePeerOffer(
  offered: string[],
  localIpv4Prefix: string | null,
  localIpv6Prefix: string | null,
  otherPeerCidrs: string[] = [],
): { cidrs: string[]; errors: string[] } {
  const localRanges = parseAll([localIpv4Prefix, localIpv6Prefix]);
  const existing = parseAll(otherPeerCidrs);
  const cidrs: string[] = [];
  const errors: string[] = [];
  const valid: ParsedCidr[] = [];
  for (const cidr of offered) {
    const parsed = parseCidr(cidr);
    if (!parsed) {
      errors.push(`Invalid CIDR: ${cidr}`);
      continue;
    }
    if (parsed.bits === 0) {
      errors.push(`Default route ${parsed.normalized} cannot be imported`);
      continue;
    }
    valid.push(parsed);
  }
  errors.push(...checkCidrOverlaps(valid, localRanges, existing));
  if (errors.length === 0) {
    for (const p of valid) if (!cidrs.includes(p.normalized)) cidrs.push(p.normalized);
  }
  return { cidrs, errors };
}

/**
 * True when `prefix` is a valid, non-default CIDR equal to or inside one of `agreed`.
 * An empty agreed list contains nothing.
 */
export function isWithinAgreed(prefix: string, agreed: string[]): boolean {
  const parsed = parseCidr(prefix);
  if (!parsed || parsed.bits === 0) return false;
  return parseAll(agreed).some((range) => range.bits > 0 && isSubnetOf(parsed, range));
}
