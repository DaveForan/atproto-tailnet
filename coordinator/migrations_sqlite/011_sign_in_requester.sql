-- Who started a pending device sign-in (ADR-0032), shown on the approval page:
-- the client address of the request that started it, and when (unix seconds).
ALTER TABLE coord_sign_ins ADD COLUMN requester_ip TEXT;
ALTER TABLE coord_sign_ins ADD COLUMN requested_at BIGINT;
