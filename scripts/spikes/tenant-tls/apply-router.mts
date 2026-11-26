// Installs the service's managed tenant route in the spike Caddy, using the
// project's own code. Env: CADDY_ADMIN_URL, BASE_DOMAIN, COORDINATOR_URL (the upstream; the stand-in on 9998).
import { applyTenantRouter, buildTenantRouter } from "../../../src/orchestrator/caddy.ts";
import { pool } from "../../../src/db/index.ts";

console.log(await applyTenantRouter(buildTenantRouter([{ slug: "acme" }])));
await pool.end();
