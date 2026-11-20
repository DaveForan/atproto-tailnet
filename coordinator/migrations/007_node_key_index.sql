-- DERP relay admission looks nodes up by node key (ADR-0027).
CREATE INDEX IF NOT EXISTS idx_coord_nodes_node_key ON coord_nodes (node_key);
