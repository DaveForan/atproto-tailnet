// Installs the service's managed tenant route in the spike Caddy, using the
// project's own code. Env: CADDY_ADMIN_URL, BASE_DOMAIN.
import { applyTenantRouter, buildTenantRouter } from "../../../src/orchestrator/caddy.ts";
import { pool } from "../../../src/db/index.ts";

// With no HEADSCALE_NETWORK the upstream is localhost:<port> — the stand-in on 9998.
console.log(await applyTenantRouter(buildTenantRouter([{ slug: "acme", port: 9998 }])));
await pool.end();
