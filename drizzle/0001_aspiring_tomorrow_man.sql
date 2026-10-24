CREATE TABLE "oauth_sessions" (
	"key" text PRIMARY KEY NOT NULL,
	"session" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"key" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
