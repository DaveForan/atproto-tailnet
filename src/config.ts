/**
 * @module config
 * Central Zod-validated configuration for the atproto-tailnet service.
 * All env vars flow through here; nothing reads process.env directly elsewhere.
 * Throws at startup if production invariants are violated (e.g. weak session secret).
 */
import { z } from "zod";

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

/** Parsed and validated application config. Importing this triggers validation at module load. */
export const config = configSchema.parse({
  port: process.env.PORT,
  publicUrl: process.env.PUBLIC_URL,
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET,
  baseDomain: process.env.BASE_DOMAIN,
  caddyAdminUrl: process.env.CADDY_ADMIN_URL,
  tenantPublicPort: process.env.TENANT_PUBLIC_PORT || undefined,
  coordinatorUrl: process.env.COORDINATOR_URL || undefined,
  coordinatorApiKey: process.env.COORDINATOR_API_KEY || undefined,
  atprotoPrivateKey: process.env.ATPROTO_PRIVATE_KEY,
  federationKeyEncryptionKey: process.env.FEDERATION_KEY_ENCRYPTION_KEY || undefined,
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

if (
  !isLoopbackDeployment &&
  (config.sessionSecret === "dev-secret-change-me" ||
    config.sessionSecret.length < 32)
) {
  throw new Error(
    "SESSION_SECRET must be a strong value (>= 32 chars) in production",
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

/** TypeScript type inferred from the validated config object. */
export type Config = typeof config;
