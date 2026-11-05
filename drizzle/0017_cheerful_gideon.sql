CREATE TYPE "public"."broker_session_status" AS ENUM('connecting', 'established', 'degraded', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."relay_node_status" AS ENUM('provisioning', 'active', 'unhealthy', 'decommissioned');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'sub_collective_quota_updated' BEFORE 'floor_policy_updated';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'credential_revoked' BEFORE 'floor_policy_updated';--> statement-breakpoint
CREATE TABLE "broker_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"federation_link_id" uuid NOT NULL,
	"local_tenant_id" uuid NOT NULL,
	"remote_tenant_id" uuid NOT NULL,
	"status" "broker_session_status" DEFAULT 'connecting' NOT NULL,
	"cfp_session_id" text,
	"remote_endpoint" text,
	"protocol_version" integer DEFAULT 1 NOT NULL,
	"exported_routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imported_routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_keepalive" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collective_dids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"did" text NOT NULL,
	"public_key_jwk" jsonb NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"broker_endpoint" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"rotated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "collective_dids_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "collective_dids_did_unique" UNIQUE("did")
);
--> statement-breakpoint
CREATE TABLE "credential_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"issuer_did" text NOT NULL,
	"reason" text,
	"revoked_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credential_revocations_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "holder_binding_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"holder_did" text,
	"expires_at" timestamp NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "holder_binding_challenges_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE TABLE "relay_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_session_id" uuid NOT NULL,
	"local_node_id" text,
	"remote_node_id" text,
	"wireguard_public_key" text,
	"status" "relay_node_status" DEFAULT 'provisioning' NOT NULL,
	"last_health_check" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "federation_links" ADD COLUMN "signed_request" text;--> statement-breakpoint
ALTER TABLE "federation_links" ADD COLUMN "requester_broker_endpoint" text;--> statement-breakpoint
ALTER TABLE "federation_links" ADD COLUMN "target_broker_endpoint" text;--> statement-breakpoint
ALTER TABLE "federation_links" ADD COLUMN "protocol_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "egress_policy" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "ingress_policy" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "federation_scopes" jsonb DEFAULT '["regional"]'::jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "federation_region" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "federation_coordinates" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "federation_scope_policies" jsonb;--> statement-breakpoint
ALTER TABLE "broker_sessions" ADD CONSTRAINT "broker_sessions_federation_link_id_federation_links_id_fk" FOREIGN KEY ("federation_link_id") REFERENCES "public"."federation_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_sessions" ADD CONSTRAINT "broker_sessions_local_tenant_id_tenants_id_fk" FOREIGN KEY ("local_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_sessions" ADD CONSTRAINT "broker_sessions_remote_tenant_id_tenants_id_fk" FOREIGN KEY ("remote_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collective_dids" ADD CONSTRAINT "collective_dids_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_revocations" ADD CONSTRAINT "credential_revocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holder_binding_challenges" ADD CONSTRAINT "holder_binding_challenges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_nodes" ADD CONSTRAINT "relay_nodes_broker_session_id_broker_sessions_id_fk" FOREIGN KEY ("broker_session_id") REFERENCES "public"."broker_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broker_sessions_link_idx" ON "broker_sessions" USING btree ("federation_link_id");--> statement-breakpoint
CREATE INDEX "broker_sessions_local_idx" ON "broker_sessions" USING btree ("local_tenant_id");--> statement-breakpoint
CREATE INDEX "broker_sessions_cfp_idx" ON "broker_sessions" USING btree ("cfp_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "broker_sessions_link_local_uq" ON "broker_sessions" USING btree ("federation_link_id","local_tenant_id");--> statement-breakpoint
CREATE INDEX "cred_revocations_cred_idx" ON "credential_revocations" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "holder_challenges_nonce_idx" ON "holder_binding_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "relay_nodes_session_idx" ON "relay_nodes" USING btree ("broker_session_id");