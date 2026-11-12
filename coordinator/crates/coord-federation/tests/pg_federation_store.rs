//! PgFederationStore integration tests — run against a real PostgreSQL instance.
//!
//! Skipped unless TEST_DATABASE_URL is set. To run:
//!   TEST_DATABASE_URL=postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/coord_test \
//!     cargo test -p coord-federation --test pg_federation_store

use chrono::Utc;
use coord_core::types::{
    BrokerSession, BrokerSessionStatus, CollectiveDid, FederationLink, LinkDirection, LinkId,
    LinkStatus, SessionId, TenantId,
};
use coord_federation::{FederationStore, PgFederationStore};
use rand::RngCore;
use sqlx::PgPool;

async fn setup() -> Option<(PgFederationStore, PgPool)> {
    let url = match std::env::var("TEST_DATABASE_URL") {
        Ok(u) => u,
        Err(_) => return None,
    };
    let pool = PgPool::connect(&url).await.expect("connect to test DB");

    sqlx::migrate!("../../migrations")
        .run(&pool)
        .await
        .expect("run migrations");

    let store = PgFederationStore::new(pool.clone());
    Some((store, pool))
}

fn unique(prefix: &str) -> String {
    let mut buf = [0u8; 4];
    rand::rng().fill_bytes(&mut buf);
    format!("{}-{}", prefix, hex::encode(buf))
}

/// Insert a tenant row directly — federation tables FK to coord_tenants.
async fn insert_tenant(pool: &PgPool, tenant_id: TenantId) {
    sqlx::query("INSERT INTO coord_tenants (id, slug) VALUES ($1, $2)")
        .bind(tenant_id.as_uuid())
        .bind(unique("fed"))
        .execute(pool)
        .await
        .expect("insert tenant");
}

fn make_link(tenant_id: TenantId, peer_did: &str, direction: LinkDirection) -> FederationLink {
    let now = Utc::now();
    FederationLink {
        id: LinkId::generate(),
        local_tenant_id: tenant_id,
        peer_did: peer_did.into(),
        peer_broker_url: Some("https://peer.example/broker".into()),
        peer_name: Some("Test Peer".into()),
        direction,
        status: LinkStatus::Pending,
        local_cidrs: vec!["100.64.0.0/24".into()],
        peer_cidrs: vec!["100.65.0.0/24".into()],
        protocol_version: Some("1.0".into()),
        message: None,
        signed_request: None,
        created_at: now,
        updated_at: now,
    }
}

fn make_session(link: &FederationLink) -> BrokerSession {
    let now = Utc::now();
    BrokerSession {
        id: SessionId::generate(),
        federation_link_id: link.id,
        local_tenant_id: link.local_tenant_id,
        peer_did: link.peer_did.clone(),
        status: BrokerSessionStatus::Connecting,
        cfp_session_id: None,
        remote_endpoint: Some("https://peer.example/cfp".into()),
        protocol_version: Some("1.0".into()),
        exported_routes: vec!["100.64.0.0/24".into()],
        imported_routes: vec![],
        last_keepalive: None,
        created_at: now,
        updated_at: now,
    }
}

macro_rules! skip_without_db {
    ($store:ident, $pool:ident) => {
        let Some(($store, $pool)) = setup().await else {
            eprintln!("TEST_DATABASE_URL not set — skipping PgFederationStore test");
            return;
        };
    };
}

// ── Link CRUD ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn create_and_get_link() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let peer_did = unique("did:web:peer");
    let link = make_link(tid, &peer_did, LinkDirection::Outgoing);
    let created = store.create_link(link).await.unwrap();
    assert_eq!(created.peer_did, peer_did);
    assert_eq!(created.direction, LinkDirection::Outgoing);
    assert_eq!(created.status, LinkStatus::Pending);

    let fetched = store.get_link(created.id).await.unwrap().unwrap();
    assert_eq!(fetched.id, created.id);
    assert_eq!(fetched.local_cidrs, vec!["100.64.0.0/24"]);
}

#[tokio::test]
async fn find_active_link_returns_none_when_pending() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let peer_did = unique("did:web:pend");
    let link = make_link(tid, &peer_did, LinkDirection::Outgoing);
    store.create_link(link).await.unwrap();

    let found = store.find_active_link(tid, &peer_did).await.unwrap();
    assert!(found.is_none(), "pending link should not be returned as active");
}

#[tokio::test]
async fn update_link_status_to_active() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let peer_did = unique("did:web:activate");
    let link = make_link(tid, &peer_did, LinkDirection::Outgoing);
    let created = store.create_link(link).await.unwrap();

    store
        .update_link_status(created.id, LinkStatus::Active)
        .await
        .unwrap();

    let found = store.find_active_link(tid, &peer_did).await.unwrap();
    assert!(found.is_some());
    assert_eq!(found.unwrap().status, LinkStatus::Active);
}

#[tokio::test]
async fn update_link_on_accept() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let link = make_link(tid, &unique("did:web:accept"), LinkDirection::Outgoing);
    let created = store.create_link(link).await.unwrap();

    store
        .update_link_on_accept(
            created.id,
            vec!["10.1.0.0/16".into()],
            "https://accepted.example/broker".into(),
            "Accepted Peer".into(),
        )
        .await
        .unwrap();

    let fetched = store.get_link(created.id).await.unwrap().unwrap();
    assert_eq!(fetched.status, LinkStatus::Active);
    assert_eq!(fetched.peer_cidrs, vec!["10.1.0.0/16"]);
    assert_eq!(fetched.peer_name, Some("Accepted Peer".into()));
}

#[tokio::test]
async fn list_active_links_filters() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let pending = make_link(tid, &unique("did:web:pend-list"), LinkDirection::Outgoing);
    store.create_link(pending).await.unwrap();

    let active_did = unique("did:web:active-list");
    let mut active = make_link(tid, &active_did, LinkDirection::Incoming);
    active.status = LinkStatus::Active;
    let created = store.create_link(active).await.unwrap();

    let actives = store.list_active_links().await.unwrap();
    assert!(
        actives.iter().any(|l| l.id == created.id),
        "active link should appear in list_active_links"
    );
}

#[tokio::test]
async fn find_pending_outgoing_link() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let out_did = unique("did:web:pend-out");
    let outgoing = make_link(tid, &out_did, LinkDirection::Outgoing);
    store.create_link(outgoing).await.unwrap();

    let found = store
        .find_pending_outgoing_link(tid, &out_did)
        .await
        .unwrap();
    assert!(found.is_some());
    assert_eq!(found.unwrap().direction, LinkDirection::Outgoing);

    let in_did = unique("did:web:pend-in");
    let incoming = make_link(tid, &in_did, LinkDirection::Incoming);
    store.create_link(incoming).await.unwrap();

    let found_incoming = store
        .find_pending_outgoing_link(tid, &in_did)
        .await
        .unwrap();
    assert!(found_incoming.is_none());
}

#[tokio::test]
async fn revoke_link() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let peer_did = unique("did:web:revoke");
    let mut link = make_link(tid, &peer_did, LinkDirection::Outgoing);
    link.status = LinkStatus::Active;
    let created = store.create_link(link).await.unwrap();

    store
        .update_link_status(created.id, LinkStatus::Revoked)
        .await
        .unwrap();

    let fetched = store.get_link(created.id).await.unwrap().unwrap();
    assert_eq!(fetched.status, LinkStatus::Revoked);

    let active = store.find_active_link(tid, &peer_did).await.unwrap();
    assert!(active.is_none());
}

// ── Session CRUD ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn create_and_list_sessions() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let mut link = make_link(tid, &unique("did:web:sess"), LinkDirection::Outgoing);
    link.status = LinkStatus::Active;
    let link = store.create_link(link).await.unwrap();

    let session = make_session(&link);
    let created = store
        .create_session_if_missing(session)
        .await
        .unwrap()
        .expect("should create new session");
    assert_eq!(created.status, BrokerSessionStatus::Connecting);

    let sessions = store.get_sessions_for_link(link.id).await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, created.id);

    let all = store.list_sessions().await.unwrap();
    assert!(all.iter().any(|s| s.id == created.id));
}

#[tokio::test]
async fn create_session_if_missing_deduplicates() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let mut link = make_link(tid, &unique("did:web:dedup"), LinkDirection::Outgoing);
    link.status = LinkStatus::Active;
    let link = store.create_link(link).await.unwrap();

    let s1 = make_session(&link);
    let created = store.create_session_if_missing(s1).await.unwrap();
    assert!(created.is_some());

    let s2 = make_session(&link);
    let duplicate = store.create_session_if_missing(s2).await.unwrap();
    assert!(
        duplicate.is_none(),
        "second session for same link+tenant should be rejected"
    );
}

#[tokio::test]
async fn update_session_established() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let mut link = make_link(tid, &unique("did:web:establish"), LinkDirection::Outgoing);
    link.status = LinkStatus::Active;
    let link = store.create_link(link).await.unwrap();

    let session = make_session(&link);
    let created = store
        .create_session_if_missing(session)
        .await
        .unwrap()
        .unwrap();

    let cfp_id = unique("cfp-sess");
    store
        .update_session_established(
            link.id,
            tid,
            cfp_id.clone(),
            vec!["10.1.0.0/16".into()],
        )
        .await
        .unwrap();

    let found = store
        .find_session_by_cfp_id(&cfp_id, tid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.id, created.id);
    assert_eq!(found.status, BrokerSessionStatus::Established);
    assert_eq!(found.imported_routes, vec!["10.1.0.0/16"]);
    assert!(found.last_keepalive.is_some());
}

#[tokio::test]
async fn update_session_keepalive() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let mut link = make_link(tid, &unique("did:web:keepalive"), LinkDirection::Outgoing);
    link.status = LinkStatus::Active;
    let link = store.create_link(link).await.unwrap();

    let session = make_session(&link);
    let created = store
        .create_session_if_missing(session)
        .await
        .unwrap()
        .unwrap();
    assert!(created.last_keepalive.is_none());

    store.update_session_keepalive(created.id).await.unwrap();

    let sessions = store.get_sessions_for_link(link.id).await.unwrap();
    assert!(sessions[0].last_keepalive.is_some());
}

#[tokio::test]
async fn update_session_status() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let mut link = make_link(tid, &unique("did:web:status"), LinkDirection::Outgoing);
    link.status = LinkStatus::Active;
    let link = store.create_link(link).await.unwrap();

    let session = make_session(&link);
    let created = store
        .create_session_if_missing(session)
        .await
        .unwrap()
        .unwrap();

    store
        .update_session_status(
            created.id,
            BrokerSessionStatus::Degraded,
            Some(vec!["10.2.0.0/16".into()]),
        )
        .await
        .unwrap();

    let sessions = store.get_sessions_for_link(link.id).await.unwrap();
    assert_eq!(sessions[0].status, BrokerSessionStatus::Degraded);
    assert_eq!(sessions[0].imported_routes, vec!["10.2.0.0/16"]);

    store
        .update_session_status(
            created.id,
            BrokerSessionStatus::Disconnected,
            None,
        )
        .await
        .unwrap();

    let sessions = store.get_sessions_for_link(link.id).await.unwrap();
    assert_eq!(sessions[0].status, BrokerSessionStatus::Disconnected);
    assert_eq!(
        sessions[0].imported_routes,
        vec!["10.2.0.0/16"],
        "routes should be preserved when None passed"
    );
}

#[tokio::test]
async fn delete_session() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let mut link = make_link(tid, &unique("did:web:delete"), LinkDirection::Outgoing);
    link.status = LinkStatus::Active;
    let link = store.create_link(link).await.unwrap();

    let session = make_session(&link);
    let created = store
        .create_session_if_missing(session)
        .await
        .unwrap()
        .unwrap();

    store.delete_session(created.id).await.unwrap();

    let sessions = store.get_sessions_for_link(link.id).await.unwrap();
    assert!(sessions.is_empty());
}

// ── Collective DIDs ───────────────────────────────────────────────────────────

#[tokio::test]
async fn create_and_get_collective_did() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let did_str = unique("did:web:collective");
    let cdid = CollectiveDid {
        tenant_id: tid,
        did: did_str.clone(),
        public_key_jwk: serde_json::json!({"kty": "OKP", "crv": "Ed25519", "x": "abc123"}),
        encrypted_private_key: "enc-key-data".into(),
        created_at: Utc::now(),
    };

    store.create_collective_did(cdid).await.unwrap();

    let fetched = store.get_collective_did(tid).await.unwrap().unwrap();
    assert_eq!(fetched.did, did_str);
    assert_eq!(fetched.public_key_jwk["kty"], "OKP");
}

#[tokio::test]
async fn find_tenant_by_did() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let did_str = unique("did:web:findme");
    let cdid = CollectiveDid {
        tenant_id: tid,
        did: did_str.clone(),
        public_key_jwk: serde_json::json!({"kty": "OKP"}),
        encrypted_private_key: "enc-data".into(),
        created_at: Utc::now(),
    };
    store.create_collective_did(cdid).await.unwrap();

    let found = store.find_tenant_by_did(&did_str).await.unwrap();
    assert_eq!(found, Some(tid));

    let not_found = store
        .find_tenant_by_did("did:web:nonexistent.example")
        .await
        .unwrap();
    assert_eq!(not_found, None);
}

#[tokio::test]
async fn delete_collective_did() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let cdid = CollectiveDid {
        tenant_id: tid,
        did: unique("did:web:deleteme"),
        public_key_jwk: serde_json::json!({"kty": "OKP"}),
        encrypted_private_key: "enc-data".into(),
        created_at: Utc::now(),
    };
    store.create_collective_did(cdid).await.unwrap();

    store.delete_collective_did(tid).await.unwrap();

    let fetched = store.get_collective_did(tid).await.unwrap();
    assert!(fetched.is_none());
}

// ── Pending link counts ───────────────────────────────────────────────────────

#[tokio::test]
async fn count_and_expire_pending_incoming() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    for i in 0..5 {
        let link = make_link(
            tid,
            &format!("did:web:pending-{}-{}", i, unique("x")),
            LinkDirection::Incoming,
        );
        store.create_link(link).await.unwrap();
    }

    let count = store.count_pending_incoming(tid).await.unwrap();
    assert_eq!(count, 5);

    let expired = store.expire_oldest_pending(tid, 3).await.unwrap();
    assert_eq!(expired, 2);

    let remaining = store.count_pending_incoming(tid).await.unwrap();
    assert_eq!(remaining, 3);
}

// ── FK cascade behavior ──────────────────────────────────────────────────────

#[tokio::test]
async fn cascade_delete_tenant_removes_links_and_sessions() {
    skip_without_db!(store, pool);
    let tid = TenantId::generate();
    insert_tenant(&pool, tid).await;

    let mut link = make_link(tid, &unique("did:web:cascade"), LinkDirection::Outgoing);
    link.status = LinkStatus::Active;
    let link = store.create_link(link).await.unwrap();

    let session = make_session(&link);
    store.create_session_if_missing(session).await.unwrap();

    let cdid = CollectiveDid {
        tenant_id: tid,
        did: unique("did:web:cascade-did"),
        public_key_jwk: serde_json::json!({"kty": "OKP"}),
        encrypted_private_key: "enc".into(),
        created_at: Utc::now(),
    };
    store.create_collective_did(cdid).await.unwrap();

    sqlx::query("DELETE FROM coord_tenants WHERE id = $1")
        .bind(tid.as_uuid())
        .execute(&pool)
        .await
        .unwrap();

    assert!(store.get_link(link.id).await.unwrap().is_none());
    assert!(store.get_sessions_for_link(link.id).await.unwrap().is_empty());
    assert!(store.get_collective_did(tid).await.unwrap().is_none());
}
