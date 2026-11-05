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
  atprotoPrivateKey: z.string().optional(),
  /** 32-byte hex key (AES-256-GCM) encrypting collective DID private keys at rest. */
  federationKeyEncryptionKey: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 bytes)")
    .optional(),
  headscale: z.object({
    image: z.string().default("headscale/headscale:0.29.1"),
    portRangeStart: z.coerce.number().default(10001),
    portRangeEnd: z.coerce.number().default(10100),
    dataDir: z.string().default("./data/headscale"),
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
  atprotoPrivateKey: process.env.ATPROTO_PRIVATE_KEY,
  federationKeyEncryptionKey: process.env.FEDERATION_KEY_ENCRYPTION_KEY || undefined,
  headscale: {
    image: process.env.HEADSCALE_IMAGE,
    portRangeStart: process.env.HEADSCALE_PORT_RANGE_START,
    portRangeEnd: process.env.HEADSCALE_PORT_RANGE_END,
    dataDir: process.env.HEADSCALE_DATA_DIR,
  },
});

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

/** TypeScript type inferred from the validated config object. */
export type Config = typeof config;
