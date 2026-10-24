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
  headscale: {
    image: process.env.HEADSCALE_IMAGE,
    portRangeStart: process.env.HEADSCALE_PORT_RANGE_START,
    portRangeEnd: process.env.HEADSCALE_PORT_RANGE_END,
    dataDir: process.env.HEADSCALE_DATA_DIR,
  },
});

if (
  !config.publicUrl.includes("localhost") &&
  (config.sessionSecret === "dev-secret-change-me" ||
    config.sessionSecret.length < 32)
) {
  throw new Error(
    "SESSION_SECRET must be a strong value (>= 32 chars) in production",
  );
}

/** TypeScript type inferred from the validated config object. */
export type Config = typeof config;
