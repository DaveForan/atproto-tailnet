/**
 * @module federation/cidr
 * CIDR parsing, normalization, and overlap checking for federation links (ADR-0019 §6).
 */

import { logger } from "../logger.js";

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

export function validateOfferedCidrs(
  offered: string[],
  tenantIpv4Prefix: string | null,
  tenantIpv6Prefix: string | null,
): { valid: ParsedCidr[]; errors: string[] } {
  const valid: ParsedCidr[] = [];
  const errors: string[] = [];

  const tenantRanges: ParsedCidr[] = [];
  if (tenantIpv4Prefix) {
    const parsed = parseCidr(tenantIpv4Prefix);
    if (parsed) tenantRanges.push(parsed);
  }
  if (tenantIpv6Prefix) {
    const parsed = parseCidr(tenantIpv6Prefix);
    if (parsed) tenantRanges.push(parsed);
  }

  for (const cidr of offered) {
    const parsed = parseCidr(cidr);
    if (!parsed) {
      errors.push(`Invalid CIDR: ${cidr}`);
      continue;
    }

    if (tenantRanges.length > 0) {
      const withinOwn = tenantRanges.some(
        (range) => range.family === parsed.family && isSubnetOf(parsed, range),
      );
      if (!withinOwn) {
        errors.push(
          `${parsed.normalized} is not within your tenant's IP range`,
        );
        continue;
      }
    }

    valid.push(parsed);
  }

  return { valid, errors };
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

function isSubnetOf(subnet: ParsedCidr, parent: ParsedCidr): boolean {
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

export function isDefaultRoute(cidr: string): boolean {
  return DEFAULT_ROUTES.includes(cidr.trim());
}
