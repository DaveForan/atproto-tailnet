-- The member put their own devices under the tailnet's open policy (ADR-0036).
-- Only the member sets it. Without it, the member's devices stay closed in every mode.
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "open_access" boolean DEFAULT false NOT NULL;
