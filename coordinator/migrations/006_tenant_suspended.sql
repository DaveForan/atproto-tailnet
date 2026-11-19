-- Instance-operator tenant suspension: while TRUE the tenant's nodes are cut off from the control plane.
ALTER TABLE coord_tenants ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT FALSE;
