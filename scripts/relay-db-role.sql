-- Least-privilege PostgreSQL role for relay processes (COORD_ROLE=relay).
--
-- A relay process reads the store for one thing: to admit only devices that
-- are registered and whose tailnet is not suspended. It also reports itself
-- in coord_relays every 20 seconds, so that the control processes put it in
-- the DERP map. It needs no other table, and none of the tables of the
-- TypeScript service.
--
-- What the relay does in the database, and the grant for it:
--
--   Startup: a relay never runs migrations. It reads the applied versions
--   and stops with a clear error if the schema is behind its binary.
--     -> SELECT on _sqlx_migrations.
--   Start the control processes (or the coordinator with COORD_ROLE=all)
--   first after an upgrade: they apply new migrations. A relay that starts
--   first fails, and Kubernetes starts it again.
--   Admission (StoreAdmission: get_node_by_node_key, get_node_info,
--   get_tenant), at connect and at every keep-alive:
--     -> SELECT on some columns of coord_nodes and coord_tenants.
--   Relay discovery (relay_heartbeat): INSERT ... ON CONFLICT DO UPDATE.
--     -> SELECT, INSERT, UPDATE on coord_relays.
--   Events of other replicas (LISTEN coord_events): needs no grant.
--
-- The relay never writes nodes or tenants, never sends NOTIFY, and does not
-- read keys, sign-ins, configuration or federation tables. A relay with a
-- gateway (COORD_GATEWAY_CERT) registers nodes and needs the full role; the
-- Kubernetes relays have no gateway.
--
-- Run it as the owner of the coordinator tables (the user of DATABASE_URL),
-- in the database of the coordinator, after the coordinator has created its
-- tables (start it once):
--
--   psql "$DATABASE_URL" -v relay_role=tailnet_relay \
--        -v relay_password="$(openssl rand -hex 24)" -f scripts/relay-db-role.sql
--
-- Then give the relays this URL (RELAY_DATABASE_URL):
--
--   postgresql://tailnet_relay:<password>@<host>:5432/<database>
--
-- The script can run again: it then sets a new password and grants again.
-- Run it again after an upgrade that changes these tables.

\set ON_ERROR_STOP on

-- The role: login only, no other privilege.
SELECT format('CREATE ROLE %I LOGIN', :'relay_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'relay_role') \gexec

ALTER ROLE :"relay_role" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'relay_password';

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'relay_role') \gexec

GRANT USAGE ON SCHEMA public TO :"relay_role";

-- Start of a relay: is the schema current? Relay-role coordinators never
-- migrate; they only read the applied versions and stop if the schema is behind.
GRANT SELECT ON public._sqlx_migrations TO :"relay_role";
-- Undo the search_path of an earlier version of this script, if present.
SELECT format('ALTER ROLE %I IN DATABASE %I RESET search_path', :'relay_role', current_database()) \gexec

-- Admission of a device
GRANT SELECT (id, tenant_id, ipv4, stable_id, node_key, machine_key, disco_key,
              endpoints, hostname, os, online, owner, tags, ephemeral,
              advertised_routes, approved_routes)
  ON public.coord_nodes TO :"relay_role";

GRANT SELECT (id, slug, parent_id, federation_posture, ipv4_prefix, ipv6_prefix,
              created_at, suspended)
  ON public.coord_tenants TO :"relay_role";

-- Relay discovery
GRANT SELECT, INSERT, UPDATE ON public.coord_relays TO :"relay_role";
