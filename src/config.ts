/**
 * @module config
 * Central Zod-validated configuration for the atproto-tailnet service.
 * All env vars flow through here; nothing reads process.env directly elsewhere.
 * Throws at startup if production invariants are violated (e.g. weak session secret).
 */
import { z } from "zod";
import { logger } from "./logger.js";

/** Zod schema defining every config knob and its default. */
const configSchema = z.object({
  port: z.coerce.number().default(3000),
  publicUrl: z.string().default("http://localhost:3000"),
  databaseUrl: z
    .string()
    .default(
      "postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/atproto_tailnet",
    ),
  sessionSecret: z.string().default("dev-secret-change-me"),
  baseDomain: z.string().default("ts.localhost"),
  /**
   * Hostname of the shared control URL every tailnet's devices use in
   * coordinator mode (ADR-0026). Must NOT be under baseDomain: the
   * coordinator's split DNS for baseDomain could stop it resolving on devices.
   */
  controlDomain: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i, "CONTROL_DOMAIN must be a hostname")
    .optional(),
  caddyAdminUrl: z.string().url().default("http://localhost:2019"),
  /**
   * Port devices use to reach tenant URLs, when the proxy is not published on
   * the scheme's default port (local development: Caddy is on 8180).
   */
  tenantPublicPort: z.coerce.number().int().min(1).max(65535).optional(),
  atprotoPrivateKey: z.string().optional(),
  /** 32-byte hex key (AES-256-GCM) encrypting collective DID private keys at rest. */
  federationKeyEncryptionKey: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 bytes)")
    .optional(),
  /**
   * URL of the Rust mesh coordinator (ADR-0023). When set, tenant control-plane
   * operations go to the coordinator instead of per-tenant Headscale containers.
   */
  coordinatorUrl: z.string().url().optional(),
  coordinatorApiKey: z.string().min(1).optional(),
  /**
   * Allow notification webhooks to target private/loopback addresses and plain
   * http. Only for single-organisation self-hosting where the webhook receiver
   * (ntfy, Gotify, a Matrix bridge…) lives on the same private network. Never
   * enable on a multi-tenant instance: any tenant admin could then make the
   * service POST to internal hosts.
   */
  webhookAllowPrivate: z.boolean().default(false),
  /** Federation (links between tailnets) is off until its data plane works without Docker. */
  federationEnabled: z.boolean().default(false),
  /** Reverse-proxy hops to trust for X-Forwarded-* (1 behind Caddy). 0 = direct exposure. */
  trustProxy: z.coerce.number().int().min(0).max(5).default(0),
  /**
   * Instance operators (OPERATOR_DIDS, comma-separated `did:` values). Only
   * operators (and the tailnet creators they designate) may create tailnets,
   * and only operators can reach /api/operator/*. Empty is allowed (dev).
   */
  operatorDids: z
    .array(z.string().regex(/^did:[a-z0-9]+:\S+$/, 'each OPERATOR_DIDS entry must be a DID ("did:…")'))
    .default([]),
  headscale: z.object({
    image: z.string().default("headscale/headscale:0.29.1"),
    portRangeStart: z.coerce.number().default(10001),
    portRangeEnd: z.coerce.number().default(10100),
    dataDir: z.string().default("./data/headscale"),
    /**
     * Docker network shared by Caddy and the tenant containers. When set,
     * tenant containers join it and Caddy reaches them by container name;
     * when unset, Caddy must run on the host and dials localhost:<port>.
     */
    network: z.string().min(1).optional(),
  }),
});

/** Splits a comma-separated DID list (OPERATOR_DIDS), trimming blanks. */
export function parseDidList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((d) => d.trim()).filter(Boolean))];
}

/** Parsed and validated application config. Importing this triggers validation at module load. */
export const config = configSchema.parse({
  port: process.env.PORT,
  publicUrl: process.env.PUBLIC_URL,
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET,
  baseDomain: process.env.BASE_DOMAIN,
  controlDomain: process.env.CONTROL_DOMAIN || undefined,
  caddyAdminUrl: process.env.CADDY_ADMIN_URL,
  tenantPublicPort: process.env.TENANT_PUBLIC_PORT || undefined,
  coordinatorUrl: process.env.COORDINATOR_URL || undefined,
  coordinatorApiKey: process.env.COORDINATOR_API_KEY || undefined,
  atprotoPrivateKey: process.env.ATPROTO_PRIVATE_KEY,
  webhookAllowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE === "true",
  federationEnabled: process.env.FEDERATION_ENABLED === "true",
  trustProxy: process.env.TRUST_PROXY || undefined,
  federationKeyEncryptionKey: process.env.FEDERATION_KEY_ENCRYPTION_KEY || undefined,
  operatorDids: parseDidList(process.env.OPERATOR_DIDS),
  headscale: {
    image: process.env.HEADSCALE_IMAGE,
    portRangeStart: process.env.HEADSCALE_PORT_RANGE_START,
    portRangeEnd: process.env.HEADSCALE_PORT_RANGE_END,
    dataDir: process.env.HEADSCALE_DATA_DIR,
    network: process.env.HEADSCALE_NETWORK || undefined,
  },
});

// ── Coordinator URL validation ──
// COORDINATOR_URL is operator-set infrastructure config, not user input —
// private/Docker-internal addresses (172.x, 10.x) are expected. SSRF
// protection for user-supplied URLs lives in identity/resolver.ts.
if (config.coordinatorUrl) {
  const coordUrl = new URL(config.coordinatorUrl);
  if (!["http:", "https:"].includes(coordUrl.protocol)) {
    throw new Error(
      `COORDINATOR_URL must use http or https protocol, got ${coordUrl.protocol}`,
    );
  }

  if (!config.coordinatorApiKey) {
    throw new Error(
      "COORDINATOR_API_KEY is required when COORDINATOR_URL is set",
    );
  }
}

/** True when the service is served from a loopback address, i.e. local development. */
export const isLoopbackDeployment = ["localhost", "127.0.0.1", "[::1]"].includes(
  new URL(config.publicUrl).hostname,
);

/** Rejects template/placeholder secrets such as "change-me-at-least-32-chars…". */
const PLACEHOLDER_SECRET_RE = /change-?me/i;

if (
  !isLoopbackDeployment &&
  (config.sessionSecret.length < 32 ||
    PLACEHOLDER_SECRET_RE.test(config.sessionSecret))
) {
  throw new Error(
    "SESSION_SECRET must be a strong, non-placeholder value (>= 32 chars) in production",
  );
}

if (
  !isLoopbackDeployment &&
  config.coordinatorApiKey &&
  (config.coordinatorApiKey.length < 32 || PLACEHOLDER_SECRET_RE.test(config.coordinatorApiKey))
) {
  throw new Error(
    "COORDINATOR_API_KEY must be a strong, non-placeholder value (>= 32 chars) in production",
  );
}

// Without operators nobody can create a tailnet (or administer the instance).
// Loud, but not fatal: the first deploy may set OPERATOR_DIDS afterwards.
if (!isLoopbackDeployment && config.operatorDids.length === 0) {
  logger.warn(
    "*** OPERATOR_DIDS IS EMPTY — this instance has no operator: nobody can create a tailnet " +
      "or use /api/operator. Set OPERATOR_DIDS=did:plc:… (comma-separated) and restart. ***",
  );
}

/**
 * Public URL of a tenant's Headscale (`<proto>://<slug>.<baseDomain>[:port]`):
 * the login server devices are given, and the instance's own `server_url`.
 */
export function tenantPublicUrl(slug: string): string {
  const proto = config.publicUrl.startsWith("https") ? "https" : "http";
  const port = config.tenantPublicPort ? `:${config.tenantPublicPort}` : "";
  return `${proto}://${slug}.${config.baseDomain}${port}`;
}

/**
 * The shared control URL (`<proto>://<CONTROL_DOMAIN>[:port]`), or null when
 * no CONTROL_DOMAIN is configured (per-tailnet URLs are used instead).
 */
export function sharedControlUrl(): string | null {
  if (!config.controlDomain) return null;
  const proto = config.publicUrl.startsWith("https") ? "https" : "http";
  const port = config.tenantPublicPort ? `:${config.tenantPublicPort}` : "";
  return `${proto}://${config.controlDomain}${port}`;
}

if (config.controlDomain) {
  const c = config.controlDomain.toLowerCase();
  const b = config.baseDomain.toLowerCase();
  if (c === b || c.endsWith(`.${b}`)) {
    throw new Error("CONTROL_DOMAIN must not be BASE_DOMAIN or a name under it (ADR-0026 / ADR-0028)");
  }
}

/**
 * Name of the dashboard session cookie. Over HTTPS it carries the `__Host-`
 * prefix: browsers then only accept it from this exact host, with `Secure`,
 * `Path=/` and no `Domain`, so content on another subdomain (for example a
 * member's service) can never set or replace it. Plain-HTTP development
 * cannot use the prefix.
 */
export function sessionCookieName(publicUrl: string = config.publicUrl): string {
  return publicUrl.startsWith("https") ? "__Host-tailnet-session" : "tailnet-session";
}

/** TypeScript type inferred from the validated config object. */
export type Config = typeof config;
