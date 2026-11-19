-- Instance-operator tenant suspension: while 1 the tenant's nodes are cut off from the control plane.
ALTER TABLE coord_tenants ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT 0;
