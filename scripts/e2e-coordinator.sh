#!/usr/bin/env bash
set -euo pipefail

# End-to-end test: boots the Rust coordinator, exercises the full REST API surface,
# then runs the TS CoordinatorApiClient against it.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COORD_DIR="$PROJECT_DIR/coordinator"

export PATH="$HOME/.cargo/bin:$PATH"

ADMIN_KEY="e2e-test-key-$(date +%s)"
PORT=0  # will be assigned

cleanup() {
  if [[ -n "${COORD_PID:-}" ]]; then
    kill "$COORD_PID" 2>/dev/null || true
    wait "$COORD_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== Building coordinator ==="
cd "$COORD_DIR"
cargo build --release 2>&1 | tail -3

BINARY="$COORD_DIR/target/release/coordinator"
if [[ ! -x "$BINARY" ]]; then
  echo "FAIL: coordinator binary not found at $BINARY"
  exit 1
fi

# Find a free port
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
BASE="http://127.0.0.1:$PORT"

echo "=== Starting coordinator on port $PORT ==="
COORD_LISTEN="127.0.0.1:$PORT" COORD_ADMIN_KEY="$ADMIN_KEY" RUST_LOG=warn \
  "$BINARY" &
COORD_PID=$!

# Wait for coordinator to be ready
for i in $(seq 1 30); do
  if curl -sf "$BASE/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$COORD_PID" 2>/dev/null; then
    echo "FAIL: coordinator exited prematurely"
    exit 1
  fi
  sleep 0.1
done

if ! curl -sf "$BASE/health" >/dev/null; then
  echo "FAIL: coordinator did not become healthy"
  exit 1
fi
echo "OK: health endpoint"

# Verify auth is required
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/tenants")
if [[ "$STATUS" != "401" ]]; then
  echo "FAIL: expected 401 without auth, got $STATUS"
  exit 1
fi
echo "OK: auth required (401 without key)"

AUTH="Authorization: Bearer $ADMIN_KEY"

# === Key endpoint ===
KEY_RESP=$(curl -sf "$BASE/key?v=68")
if ! echo "$KEY_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['publicKey'].startswith('mkey:')"; then
  echo "FAIL: key endpoint"
  exit 1
fi
echo "OK: key endpoint returns mkey"

# === Tenant CRUD ===
TENANT=$(curl -sf -X POST "$BASE/api/tenants" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"slug":"e2e-test"}')
TENANT_ID=$(echo "$TENANT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "OK: created tenant $TENANT_ID"

# List tenants
LIST=$(curl -sf "$BASE/api/tenants" -H "$AUTH")
COUNT=$(echo "$LIST" | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])")
if [[ "$COUNT" -lt 1 ]]; then
  echo "FAIL: expected at least 1 tenant, got $COUNT"
  exit 1
fi
echo "OK: list tenants (count=$COUNT)"

# Get tenant
GET_T=$(curl -sf "$BASE/api/tenants/$TENANT_ID" -H "$AUTH")
SLUG=$(echo "$GET_T" | python3 -c "import sys,json; print(json.load(sys.stdin)['tenant']['slug'])")
if [[ "$SLUG" != "e2e-test" ]]; then
  echo "FAIL: expected slug e2e-test, got $SLUG"
  exit 1
fi
echo "OK: get tenant"

# === Posture ===
POSTURE_RESP=$(curl -sf -X PUT "$BASE/api/tenants/$TENANT_ID/posture" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"posture":"open"}')
POSTURE=$(echo "$POSTURE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['federation_posture'])")
if [[ "$POSTURE" != "open" ]]; then
  echo "FAIL: expected posture open, got $POSTURE"
  exit 1
fi
echo "OK: posture updated to open"

# Invalid posture
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/api/tenants/$TENANT_ID/posture" \
  -H "$AUTH" -H "Content-Type: application/json" -d '{"posture":"invalid"}')
if [[ "$STATUS" != "400" ]]; then
  echo "FAIL: expected 400 for invalid posture, got $STATUS"
  exit 1
fi
echo "OK: invalid posture rejected (400)"

# === Preauth key ===
KEY_RESP=$(curl -sf -X POST "$BASE/api/preauth-keys" -H "$AUTH" \
  -H "Content-Type: application/json" -d "{\"tenant_id\":\"$TENANT_ID\"}")
PREAUTH_KEY=$(echo "$KEY_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")
if [[ ! "$PREAUTH_KEY" == tskey-auth-* ]]; then
  echo "FAIL: expected tskey-auth-* key, got $PREAUTH_KEY"
  exit 1
fi
echo "OK: created preauth key"

# === ACL ===
curl -sf -X POST "$BASE/api/acl" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"tenant_id\":\"$TENANT_ID\",\"policy\":{\"acls\":[{\"action\":\"accept\",\"src\":[\"*\"],\"dst\":[\"*:*\"]}]}}" >/dev/null
GET_ACL=$(curl -sf "$BASE/api/tenants/$TENANT_ID/acl" -H "$AUTH")
echo "OK: ACL set and read back"

# === Tenant-scoped nodes (empty) ===
NODES=$(curl -sf "$BASE/api/tenants/$TENANT_ID/nodes" -H "$AUTH")
NODE_COUNT=$(echo "$NODES" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['nodes']))")
if [[ "$NODE_COUNT" != "0" ]]; then
  echo "FAIL: expected 0 nodes, got $NODE_COUNT"
  exit 1
fi
echo "OK: tenant-scoped node list (empty)"

# === Child tenant + hierarchy ===
CHILD=$(curl -sf -X POST "$BASE/api/tenants" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"slug\":\"e2e-child\",\"parent_id\":\"$TENANT_ID\"}")
CHILD_ID=$(echo "$CHILD" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "OK: created child tenant $CHILD_ID"

# Routes endpoint
ROUTES=$(curl -sf "$BASE/api/tenants/$TENANT_ID/routes" -H "$AUTH")
echo "OK: routes endpoint"

# === Duplicate slug rejected ===
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/tenants" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"slug":"e2e-test"}')
if [[ "$STATUS" != "409" ]]; then
  echo "FAIL: expected 409 for duplicate slug, got $STATUS"
  exit 1
fi
echo "OK: duplicate slug rejected (409)"

# === Delete child then parent ===
curl -sf -X DELETE "$BASE/api/tenants/$CHILD_ID" -H "$AUTH" >/dev/null
echo "OK: deleted child tenant"

curl -sf -X DELETE "$BASE/api/tenants/$TENANT_ID" -H "$AUTH" >/dev/null
echo "OK: deleted parent tenant"

# Verify gone
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/tenants/$TENANT_ID" -H "$AUTH")
if [[ "$STATUS" != "404" ]]; then
  echo "FAIL: expected 404 for deleted tenant, got $STATUS"
  exit 1
fi
echo "OK: deleted tenant returns 404"

echo ""
echo "=== Running TS CoordinatorApiClient tests ==="
cd "$PROJECT_DIR"

node --input-type=module <<TSEOF
import { CoordinatorApiClient } from './src/orchestrator/coordinator-api.ts';

const client = new CoordinatorApiClient(
  'http://127.0.0.1:$PORT',
  'placeholder',
  '$ADMIN_KEY'
);

// Health check
const healthy = await client.healthcheck();
if (!healthy) throw new Error('healthcheck failed');
console.log('TS OK: healthcheck');

// Create a fresh tenant for TS tests (need low-level fetch since client is tenant-scoped)
const createResp = await fetch('http://127.0.0.1:$PORT/api/tenants', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $ADMIN_KEY',
  },
  body: JSON.stringify({ slug: 'ts-e2e' }),
});
const tenant = await createResp.json();
const tenantId = tenant.id;
console.log('TS OK: created tenant', tenantId);

// Now create a properly-scoped client
const tc = new CoordinatorApiClient(
  'http://127.0.0.1:$PORT',
  tenantId,
  '$ADMIN_KEY'
);

// List nodes (empty)
const nodes = await tc.listNodes();
if (nodes.length !== 0) throw new Error('expected 0 nodes, got ' + nodes.length);
console.log('TS OK: listNodes (empty)');

// Create preauth key
const key = await tc.createPreAuthKey('test-user');
if (!key.key.startsWith('tskey-auth-')) throw new Error('bad key: ' + key.key);
console.log('TS OK: createPreAuthKey');

// Get/set policy
await tc.setPolicy({ acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }] });
const policy = await tc.getPolicy();
console.log('TS OK: setPolicy + getPolicy');

// Set posture
await tc.setPosture('selective');
console.log('TS OK: setPosture');

// List users (synthetic)
const users = await tc.listUsers();
if (users.length !== 1) throw new Error('expected 1 user');
console.log('TS OK: listUsers');

// List routes
const routes = await tc.listRoutes();
console.log('TS OK: listRoutes (' + routes.length + ' routes)');

console.log('');
console.log('=== All TS CoordinatorApiClient tests passed ===');
TSEOF

echo ""
echo "=== All e2e tests passed ==="
