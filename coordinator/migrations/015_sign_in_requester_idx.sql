-- Counts pending device sign-ins per client address for the per-address cap.
CREATE INDEX IF NOT EXISTS coord_sign_ins_requester_idx ON coord_sign_ins (requester_ip);
