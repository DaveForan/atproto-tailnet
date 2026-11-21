/**
 * @module orchestrator/hostnames
 * Public tailnet addresses (`<name>.<BASE_DOMAIN>`).
 *
 * `tenants.slug` is the permanent internal id (coordinator tenant slug,
 * collective DID, dashboard identity). The `tenant_hostnames` table holds the
 * names a tailnet answers to publicly:
 *
 * - exactly one live **primary** name — what new devices are told to use
 *   (login server) and what join/board links show;
 * - older names stay as **aliases**, still routed, so devices enrolled under
 *   them keep working;
 * - a **retired** name is no longer routed and stays reserved for
 *   {@link RETIRED_QUARANTINE_MS} so nobody can take over a name that devices
 *   or shared links may still point at.
 */

import { randomInt } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { tenants, tenantHostnames } from "../db/schema.js";
import { sharedControlUrl, tenantPublicUrl } from "../config.js";
import { useCoordinator } from "./control-client.js";

/** The db client or an open transaction. */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One DNS label: lowercase letters, digits, inner hyphens, 1-63 chars. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Live (primary + alias) names a tailnet may hold at once. */
export const MAX_LIVE_HOSTNAMES = 5;

/** How long a retired name stays reserved before anyone may claim it. */
export const RETIRED_QUARANTINE_MS = 30 * 24 * 60 * 60 * 1000;

/** Names that would be confusing or impersonate infrastructure. */
export const RESERVED_HOSTNAMES = new Set([
  "www", "api", "app", "admin", "administrator", "root", "mail", "smtp", "imap", "pop",
  "ns", "ns1", "ns2", "dns", "ftp", "ssh", "vpn", "derp", "relay", "stun", "turn",
  "login", "auth", "oauth", "sso", "account", "accounts", "dashboard", "console",
  "status", "health", "metrics", "internal", "localhost", "static", "assets", "cdn",
  "mcp", "operator", "support", "help", "security", "abuse", "postmaster", "hostmaster",
  "webmaster", "noc", "billing", "docs", "blog", "test", "staging", "dev",
  "tailscale", "headscale", "coordinator", "control", "controlplane",
]);

export type HostnameError =
  | "invalid"
  | "reserved"
  | "taken"
  | "too_many";

/** Normalises and validates a requested name; returns it or an error code. */
export function validateHostname(input: unknown): { ok: true; name: string } | { ok: false; error: HostnameError } {
  if (typeof input !== "string") return { ok: false, error: "invalid" };
  const name = input.trim().toLowerCase();
  if (!LABEL_RE.test(name) || name.includes("--")) return { ok: false, error: "invalid" };
  if (RESERVED_HOSTNAMES.has(name)) return { ok: false, error: "reserved" };
  return { ok: true, name };
}

/** The tailnet's primary public name (falls back to its internal slug). */
export async function primaryHostname(tenantId: string, fallbackSlug?: string): Promise<string> {
  const [row] = await db
    .select({ slug: tenantHostnames.slug })
    .from(tenantHostnames)
    .where(
      and(
        eq(tenantHostnames.tenantId, tenantId),
        eq(tenantHostnames.isPrimary, true),
        isNull(tenantHostnames.retiredAt),
      ),
    )
    .limit(1);
  if (row) return row.slug;
  if (fallbackSlug) return fallbackSlug;
  const [t] = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId));
  return t?.slug ?? "";
}

/** True when every tailnet's devices use one shared control URL (coordinator mode + CONTROL_DOMAIN). */
export function usesSharedControlUrl(): boolean {
  return useCoordinator && sharedControlUrl() !== null;
}

/**
 * Login server URL new devices of this tailnet should use: the shared control
 * URL in coordinator mode (the pre-auth key alone selects the tailnet), else
 * the tailnet's own primary address (Headscale mode: one server per tailnet).
 */
export async function tenantLoginServerFor(tenant: { id: string; slug: string }): Promise<string> {
  if (usesSharedControlUrl()) return sharedControlUrl()!;
  return tenantPublicUrl(await primaryHostname(tenant.id, tenant.slug));
}

/** Live (routed) names per tenant id. */
export async function liveHostnamesByTenant(tenantIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (tenantIds.length === 0) return out;
  const rows = await db
    .select({ slug: tenantHostnames.slug, tenantId: tenantHostnames.tenantId, isPrimary: tenantHostnames.isPrimary })
    .from(tenantHostnames)
    .where(and(inArray(tenantHostnames.tenantId, tenantIds), isNull(tenantHostnames.retiredAt)));
  // Primary first, then alphabetical (stable Caddy config)
  rows.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.slug.localeCompare(b.slug));
  for (const r of rows) {
    const list = out.get(r.tenantId) ?? [];
    list.push(r.slug);
    out.set(r.tenantId, list);
  }
  return out;
}

/** Tenant id a live public name (primary or alias) belongs to, or null. */
export async function tenantIdForHostname(name: string): Promise<string | null> {
  const v = validateHostname(name);
  // Reserved names were never assignable, but an internal slug may predate the list
  const lookup = v.ok ? v.name : typeof name === "string" ? name.toLowerCase() : "";
  if (!lookup) return null;
  const [row] = await db
    .select({ tenantId: tenantHostnames.tenantId })
    .from(tenantHostnames)
    .where(and(eq(tenantHostnames.slug, lookup), isNull(tenantHostnames.retiredAt)))
    .limit(1);
  return row?.tenantId ?? null;
}

/**
 * Tenant id for a name in a public link (`/join/:name`, `/board/:name`):
 * live public names only (primary or alias). The internal slug never resolves
 * publicly — aliases keep links shared before a rename working until retired.
 */
export async function tenantIdForPublicLink(name: string): Promise<string | null> {
  return tenantIdForHostname(name);
}

// ── Generated names ─────────────────────────────────────────────────────

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l
const ADJECTIVES = [
  "amber", "ancient", "autumn", "bold", "brave", "bright", "calm", "clever", "cool", "copper",
  "crimson", "crisp", "dawn", "deep", "eager", "early", "fair", "fancy", "fast", "fresh",
  "gentle", "golden", "grand", "green", "happy", "hidden", "humble", "icy", "jolly", "keen",
  "kind", "late", "lively", "lucky", "lunar", "mellow", "misty", "noble", "north", "olive",
  "patient", "plain", "polar", "proud", "quick", "quiet", "rapid", "rare", "rosy", "royal",
  "rustic", "silent", "silver", "sly", "solar", "spring", "steady", "still", "sunny", "swift",
  "tidy", "velvet", "warm", "wild",
];
const NOUNS = [
  "anchor", "aspen", "badger", "beacon", "birch", "bison", "breeze", "brook", "canyon", "cedar",
  "cliff", "cloud", "comet", "coral", "cove", "crane", "creek", "delta", "dune", "falcon",
  "fern", "fjord", "forest", "fox", "garden", "glade", "grove", "harbor", "hawk", "heron",
  "hill", "island", "lagoon", "lake", "lark", "maple", "meadow", "mesa", "moon", "moss",
  "oak", "orbit", "otter", "owl", "peak", "pine", "planet", "pond", "prairie", "raven",
  "reef", "ridge", "river", "robin", "shore", "sparrow", "spruce", "star", "stone", "summit",
  "tide", "trail", "valley", "willow",
];

/** Opaque internal id for a new tailnet (`t-` + 10 chars, ~50 bits). Never shown publicly. */
export function generateInternalSlug(): string {
  let s = "t-";
  for (let i = 0; i < 10; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return s;
}

/** Random friendly public name, e.g. `quiet-harbor-4821` — says nothing about the owner. */
export function generateFriendlyName(): string {
  const a = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const n = NOUNS[randomInt(NOUNS.length)];
  return `${a}-${n}-${randomInt(1000, 10000)}`;
}

/** A free friendly public name for a new tailnet. */
export async function generateAvailableFriendlyName(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = generateFriendlyName();
    if (await hostnameAvailableFor(candidate, "")) return candidate;
  }
  throw new Error("Could not generate a free tailnet address");
}

/**
 * Whether `name` can be claimed by `tenantId`: not a live name of another
 * tailnet, not another tailnet's internal slug, and not retired by another
 * tailnet within the quarantine window. A tailnet may always re-claim its own
 * names.
 */
export async function hostnameAvailableFor(name: string, tenantId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ tenantId: tenantHostnames.tenantId, retiredAt: tenantHostnames.retiredAt })
    .from(tenantHostnames)
    .where(eq(tenantHostnames.slug, name))
    .limit(1);
  if (row && row.tenantId !== tenantId) {
    if (!row.retiredAt) return false;
    if (now.getTime() - row.retiredAt.getTime() < RETIRED_QUARANTINE_MS) return false;
  }
  const [internal] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, name))
    .limit(1);
  return !internal || internal.id === tenantId;
}

/** Record a new tenant's first primary public name. */
export async function registerInitialHostname(
  tenantId: string,
  name: string,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .insert(tenantHostnames)
    .values({ slug: name, tenantId, isPrimary: true })
    .onConflictDoNothing();
}

/**
 * Make `name` the tailnet's primary address. The previous primary stays as a
 * live alias. Returns an error code when refused.
 */
export async function setPrimaryHostname(
  tenantId: string,
  requested: unknown,
  now = new Date(),
): Promise<{ ok: true; name: string } | { ok: false; error: HostnameError }> {
  const v = validateHostname(requested);
  if (!v.ok) return v;
  const name = v.name;

  return db.transaction(async (tx) => {
    const own = await tx
      .select()
      .from(tenantHostnames)
      .where(eq(tenantHostnames.tenantId, tenantId));
    const existing = own.find((h) => h.slug === name);
    if (existing && existing.isPrimary && !existing.retiredAt) return { ok: true as const, name };

    if (!existing) {
      if (!(await hostnameAvailableFor(name, tenantId, now))) return { ok: false as const, error: "taken" as const };
      const live = own.filter((h) => !h.retiredAt).length;
      if (live >= MAX_LIVE_HOSTNAMES) return { ok: false as const, error: "too_many" as const };
    } else if (existing.retiredAt) {
      const live = own.filter((h) => !h.retiredAt).length;
      if (live >= MAX_LIVE_HOSTNAMES) return { ok: false as const, error: "too_many" as const };
    }

    // Demote the current primary (it stays routed as an alias)
    await tx
      .update(tenantHostnames)
      .set({ isPrimary: false })
      .where(and(eq(tenantHostnames.tenantId, tenantId), eq(tenantHostnames.isPrimary, true)));

    if (existing) {
      await tx
        .update(tenantHostnames)
        .set({ isPrimary: true, retiredAt: null })
        .where(eq(tenantHostnames.slug, name));
    } else {
      // A long-retired name from another tailnet is released first
      await tx.delete(tenantHostnames).where(eq(tenantHostnames.slug, name));
      await tx.insert(tenantHostnames).values({ slug: name, tenantId, isPrimary: true });
    }
    return { ok: true as const, name };
  });
}

/**
 * Stop routing an alias. The primary cannot be retired (set another primary
 * first). Returns false when the name is not a live alias of this tailnet.
 */
export async function retireHostname(tenantId: string, name: string, now = new Date()): Promise<boolean> {
  const updated = await db
    .update(tenantHostnames)
    .set({ retiredAt: now })
    .where(
      and(
        eq(tenantHostnames.tenantId, tenantId),
        eq(tenantHostnames.slug, name),
        eq(tenantHostnames.isPrimary, false),
        isNull(tenantHostnames.retiredAt),
      ),
    )
    .returning({ slug: tenantHostnames.slug });
  return updated.length > 0;
}

/** All of a tailnet's names, for the settings UI. */
export async function listHostnames(tenantId: string) {
  return db
    .select({
      name: tenantHostnames.slug,
      primary: tenantHostnames.isPrimary,
      createdAt: tenantHostnames.createdAt,
      retiredAt: tenantHostnames.retiredAt,
    })
    .from(tenantHostnames)
    .where(eq(tenantHostnames.tenantId, tenantId))
    .orderBy(tenantHostnames.createdAt);
}
