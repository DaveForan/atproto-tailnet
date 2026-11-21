# Status memo

Last updated: 2026-11-20. Code as of `61d6d8e` on `master`. CI is green (TS, Rust, clippy `-D warnings`, `cargo doc`, `cargo audit`).

## Where we are

The single-instance product is ready to deploy. Federation is off and deferred (ADR-0033).

Recent work, newest first:

- **Gateway certificate scope (ADR-0038).** Named HTTPS services now live at `<name>.svc.<BASE_DOMAIN>`. The gateway holds only the `*.svc` key, and it runs in a separate `relay` container without the admin key or the control key.
- **Dependencies.** zod 4 for our own code. chrono replaced by `time`. `rustls-pemfile` replaced. sqlx 0.9.1 fixes RUSTSEC-2026-0459. `cargo audit` reports nothing.
- **OWASP Top 10 review and fixes.** Sign-in SSRF, `/API/` case bypass of CSRF and the enrolment gate, step-up bound to the device cookie, absolute session expiry, audit of security events, Noise connection limits, unique device names.
- **Refactors.** One `tenantGuard` middleware. Clean layering: nothing below `routes/` imports from it. Transactional tenant creation. Schema split into `src/db/schema/*`. Single-flight dashboard actions and shared loaders. Coordinator `CoordinatorState::builder`.
- **Comment pass.** Comments are short ASD-STE100 sentences, and only where the code cannot speak for itself. The rule is in CLAUDE.md under "Comments".
- **Decisions recorded.** ADR-0037: keep separate PostgreSQL and SQLite stores. ADR-0033: federation deferred, its scaffolding modules are not dead code.

## Deploy (DigitalOcean)

Follow `deploy/digitalocean/AGENT.md`. CLAUDE.md points Claude Code at it. Ask Claude Code: "Deploy this to DigitalOcean following CLAUDE.md."

You need:

- The domain. DNS records for `APP_DOMAIN`, `*.BASE_DOMAIN`, `DERP_DOMAIN` (new and required) and, optionally, `*.svc.BASE_DOMAIN`.
- `OPERATOR_DIDS=did:plc:rfrx5n26phualqc6x54n6myq` (`daveforan.bsky.social`).
- A DigitalOcean API token (scope it to DNS if possible) or the DigitalOcean MCP. Droplet steps still need SSH.
- `ATPROTO_PRIVATE_KEY`, generated on the Droplet (step 8 of the guide).
- A DigitalOcean Cloud Firewall: SSH from your IP only, 80, 443 TCP and UDP, 3478 UDP (STUN).

After the first start: sign in yourself before you share the URL, then connect Claude to `https://<APP_DOMAIN>/mcp`.

## Behaviour changes to expect on first deploy

- Everyone is signed out once (old sessions have no start time).
- Boards are off by default. An admin must turn the board on before public posts work.
- Named HTTPS service addresses move to `<name>.svc.<BASE_DOMAIN>`.
- Compose runs two coordinator containers: `coordinator` (control) and `relay` (DERP, STUN, gateway).

## Not yet tested live

- A real Bluesky sign-in in production.
- Named services at the new `svc` addresses with a real client outside the test stack.

## Next steps

1. Done 2026-11-21: `21534fc` runs on the Droplet. Both wildcard certificates came from Let's Encrypt through DigitalOcean DNS (the `*.svc` one at the second try: the first DNS lookup failed). A real macOS client reconnected by itself and uses the relay. Still open: the two sign-in and `svc` checks above.
2. Done, not yet deployed: the relay container has a least-privilege database role (`relay-db-role` compose service, ADR-0038). The relay offers its gateway keys and the control process registers the node.
3. Resume federation when a second collective needs access (resume criteria in ADR-0033): gateway data plane, protocol version on CFP messages, replica-safe handshake state, traversal policy enforcement.
4. Optional: the @atproto packages still bundle zod 3 (advisory flagged by `npm audit`); it clears when they release.

## Working notes

- Local dev box quirks: `NODE_ENV=production` is set globally, so use `npm ci --include=dev`. Regenerate `package-lock.json` only with npm 10 in `node:22-alpine` (see CLAUDE.md), or the image build rejects it.
- Drizzle migrations 0018 and later are hand-written. Add the SQL file and the `_journal.json` entry by hand; `drizzle-kit generate` prompts interactively.
- Never edit applied coordinator migrations (`coordinator/migrations*`), even comments: sqlx checks their checksums.
- `cargo fmt` was never applied to the Rust code. Running it rewrites most files, so do it only as its own commit if you want it.
- On this machine, a cleanup removed Docker's unused build cache. The first image build here starts cold.
