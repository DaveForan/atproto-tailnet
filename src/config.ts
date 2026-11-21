/**
 * Zod-validated configuration. No other module reads process.env.
 * Startup fails when a production rule is broken (weak secrets, missing keys).
 */
import { z } from "zod";
import { logger } from "./logger.js";

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
   * Shared control URL hostname for all tailnets in coordinator mode (ADR-0026).
   * It must not be under baseDomain. Split DNS for baseDomain can stop it resolving on devices.
   */
  /**
   * Resolver IPs that devices use for baseDomain names with no record (ADR-0028).
   * When empty, devices use their own resolvers through the client forwarder.
   */
  tailnetDnsUpstream: z.array(z.string().ip()).max(4).default([]),
  controlDomain: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i, "CONTROL_DOMAIN must be a hostname")
    .optional(),
  caddyAdminUrl: z.string().url().default("http://localhost:2019"),
  /**
   * False when `CADDY_ADMIN_URL=off`. Another proxy with static routes is in front (for example an Ingress).
   * The service then writes no Caddy routes and does not answer Caddy certificate checks.
   * Requires `CONTROL_DOMAIN`, because per-tailnet hostnames are not routed.
   */
  caddyEnabled: z.boolean().default(true),
  /** Port for tenant URLs when the proxy is not on the default port (local development uses 8180). */
  tenantPublicPort: z.coerce.number().int().min(1).max(65535).optional(),
  atprotoPrivateKey: z.string().optional(),
  /** 32-byte hex key (AES-256-GCM) encrypting collective DID private keys at rest. */
  federationKeyEncryptionKey: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 bytes)")
    .optional(),
  /** Rust mesh coordinator URL (ADR-0023). When set, it replaces per-tenant Headscale containers. */
  coordinatorUrl: z.string().url().optional(),
  coordinatorApiKey: z.string().min(1).optional(),
  /**
   * Lets notification webhooks target private or loopback addresses over plain http.
   * Use it only for single-organisation self-hosting.
   * Security: never enable it on a multi-tenant instance. Any tenant admin can then make the service POST to internal hosts.
   */
  webhookAllowPrivate: z.boolean().default(false),
  /** Federation stays off until its data plane works without Docker. */
  federationEnabled: z.boolean().default(false),
  /** Reverse-proxy hops to trust for X-Forwarded-* (1 behind Caddy). 0 = direct exposure. */
  trustProxy: z.coerce.number().int().min(0).max(5).default(0),
  /**
   * Instance operator DIDs (OPERATOR_DIDS, comma-separated).
   * Only operators and their designated creators can create tailnets. Only operators can reach /api/operator/*.
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
     * Docker network for Caddy and tenant containers. When set, Caddy reaches tenants by container name.
     * When unset, Caddy must run on the host and dial localhost:<port>.
     */
    network: z.string().min(1).optional(),
  }),
});

export function parseDidList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((d) => d.trim()).filter(Boolean))];
}

/** Validated application config. Importing this module runs validation. */
export const config = configSchema.parse({
  port: process.env.PORT,
  publicUrl: process.env.PUBLIC_URL,
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET,
  baseDomain: process.env.BASE_DOMAIN,
  controlDomain: process.env.CONTROL_DOMAIN || undefined,
  tailnetDnsUpstream: (process.env.TAILNET_DNS_UPSTREAM ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  caddyAdminUrl: process.env.CADDY_ADMIN_URL === "off" ? undefined : process.env.CADDY_ADMIN_URL,
  caddyEnabled: process.env.CADDY_ADMIN_URL !== "off",
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

// COORDINATOR_URL is operator config, not user input, so private addresses are expected.
// SSRF protection for user-supplied URLs is in identity/resolver.ts.
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

/** True when the service runs on a loopback address (local development). */
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

/**
 * Returns an error for a federating production instance without key encryption, else null.
 * Security: without encryption, collective private keys are stored as plain base64.
 */
export function federationKeyProblem(
  cfg: { federationEnabled: boolean; federationKeyEncryptionKey?: string },
  loopback: boolean,
): string | null {
  if (loopback || !cfg.federationEnabled || cfg.federationKeyEncryptionKey) return null;
  return "FEDERATION_KEY_ENCRYPTION_KEY (64 hex characters) is required when FEDERATION_ENABLED=true in production";
}

const federationKeyError = federationKeyProblem(config, isLoopbackDeployment);
if (federationKeyError) throw new Error(federationKeyError);

// Without operators, nobody can create a tailnet. This is a warning, not fatal:
// the first deploy can set OPERATOR_DIDS later.
if (!isLoopbackDeployment && config.operatorDids.length === 0) {
  logger.warn(
    "*** OPERATOR_DIDS IS EMPTY — this instance has no operator: nobody can create a tailnet " +
      "or use /api/operator. Set OPERATOR_DIDS=did:plc:… (comma-separated) and restart. ***",
  );
}

/** Public tenant Headscale URL (`<proto>://<slug>.<baseDomain>[:port]`), used as the device login server. */
export function tenantPublicUrl(slug: string): string {
  const proto = config.publicUrl.startsWith("https") ? "https" : "http";
  const port = config.tenantPublicPort ? `:${config.tenantPublicPort}` : "";
  return `${proto}://${slug}.${config.baseDomain}${port}`;
}

/** Shared control URL (`<proto>://<CONTROL_DOMAIN>[:port]`), or null when CONTROL_DOMAIN is not set. */
export function sharedControlUrl(): string | null {
  if (!config.controlDomain) return null;
  const proto = config.publicUrl.startsWith("https") ? "https" : "http";
  const port = config.tenantPublicPort ? `:${config.tenantPublicPort}` : "";
  return `${proto}://${config.controlDomain}${port}`;
}

if (!config.caddyEnabled && !config.controlDomain) {
  throw new Error("CADDY_ADMIN_URL=off needs CONTROL_DOMAIN: without Caddy, per-tailnet control hostnames are not routed");
}
if (config.controlDomain) {
  const c = config.controlDomain.toLowerCase();
  const b = config.baseDomain.toLowerCase();
  if (c === b || c.endsWith(`.${b}`)) {
    throw new Error("CONTROL_DOMAIN must not be BASE_DOMAIN or a name under it (ADR-0026 / ADR-0028)");
  }
}

/**
 * Dashboard session cookie name.
 * Security: over HTTPS it uses the `__Host-` prefix. Then no other subdomain can set or replace it.
 * Plain-HTTP development cannot use the prefix.
 */
export function sessionCookieName(publicUrl: string = config.publicUrl): string {
  return publicUrl.startsWith("https") ? "__Host-tailnet-session" : "tailnet-session";
}

export type Config = typeof config;
