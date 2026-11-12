//! PgStore integration tests — run against a real PostgreSQL instance.
//!
//! Skipped unless TEST_DATABASE_URL is set. To run:
//!   TEST_DATABASE_URL=postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/coord_test \
//!     cargo test -p coord-store --test pg_integration

use coord_core::{FederationPosture, NodeInfo};
use coord_store::PgStore;
use rand::RngCore;
use sqlx::PgPool;

async fn setup() -> Option<PgStore> {
    let url = match std::env::var("TEST_DATABASE_URL") {
        Ok(u) => u,
        Err(_) => return None,
    };
    let pool = PgPool::connect(&url).await.expect("connect to test DB");
    let store = PgStore::new(pool).await.expect("PgStore::new");
    Some(store)
}

macro_rules! skip_without_db {
    ($store:ident) => {
        let Some($store) = setup().await else {
            eprintln!("TEST_DATABASE_URL not set — skipping PgStore test");
            return;
        };
    };
}

/// Generate a unique slug to avoid collisions across parallel runs.
fn unique(prefix: &str) -> String {
    let mut buf = [0u8; 4];
    rand::rng().fill_bytes(&mut buf);
    format!("{}-{}", prefix, hex::encode(buf))
}

/// Generate a unique 32-byte key.
fn unique_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    key
}

fn make_info(hostname: &str) -> NodeInfo {
    NodeInfo {
        node_key: unique_key().to_vec(),
        machine_key: unique_key().to_vec(),
        disco_key: None,
        endpoints: vec![],
        hostname: hostname.into(),
        os: "linux".into(),
        ipv4: None,
        ipv6: None,
    }
}

// ── Tenant CRUD ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn pg_create_and_get_tenant() {
    skip_without_db!(store);

    let slug = unique("alpha");
    let tenant = store.create_tenant(slug.clone(), None, None).await.unwrap();
    assert_eq!(tenant.slug, slug);
    assert_eq!(tenant.federation_posture, FederationPosture::Closed);

    let fetched = store.get_tenant(tenant.id).await.unwrap();
    assert_eq!(fetched.slug, slug);
}

#[tokio::test]
async fn pg_list_tenants() {
    skip_without_db!(store);

    store.create_tenant(unique("list-a"), None, None).await.unwrap();
    store.create_tenant(unique("list-b"), None, None).await.unwrap();

    let all = store.list_tenants().await;
    assert!(all.len() >= 2);
}

#[tokio::test]
async fn pg_duplicate_slug_rejected() {
    skip_without_db!(store);

    let slug = unique("dup");
    store.create_tenant(slug.clone(), None, None).await.unwrap();
    let result = store.create_tenant(slug, None, None).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn pg_delete_tenant() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("del"), None, None).await.unwrap();
    store.delete_tenant(tenant.id).await.unwrap();
    assert!(store.get_tenant(tenant.id).await.is_none());
}

#[tokio::test]
async fn pg_update_posture() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("posture"), None, None).await.unwrap();
    assert_eq!(tenant.federation_posture, FederationPosture::Closed);

    let updated = store
        .update_tenant_posture(tenant.id, FederationPosture::Open)
        .await
        .unwrap();
    assert_eq!(updated.federation_posture, FederationPosture::Open);

    let fetched = store.get_tenant(tenant.id).await.unwrap();
    assert_eq!(fetched.federation_posture, FederationPosture::Open);
}

#[tokio::test]
async fn pg_parent_child_tenants() {
    skip_without_db!(store);

    let parent = store.create_tenant(unique("parent"), None, None).await.unwrap();
    let child_slug = unique("child");
    let child = store
        .create_tenant(child_slug.clone(), Some(parent.id), None)
        .await
        .unwrap();

    assert_eq!(child.parent_id, Some(parent.id));

    let children = store.get_child_tenants(parent.id).await;
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].slug, child_slug);
}

// ── Preauth keys ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn pg_preauth_key_single_use() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("key"), None, None).await.unwrap();
    let key = store.create_preauth_key(tenant.id, false).await.unwrap();

    let tid = store.validate_preauth_key(&key).await;
    assert_eq!(tid, Some(tenant.id));

    let tid2 = store.validate_preauth_key(&key).await;
    assert_eq!(tid2, None, "single-use key should be consumed");
}

#[tokio::test]
async fn pg_preauth_key_reusable() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("reuse"), None, None).await.unwrap();
    let key = store.create_preauth_key(tenant.id, true).await.unwrap();

    let tid1 = store.validate_preauth_key(&key).await;
    assert_eq!(tid1, Some(tenant.id));

    let tid2 = store.validate_preauth_key(&key).await;
    assert_eq!(tid2, Some(tenant.id), "reusable key should still validate");
}

// ── Node registration ─────────────────────────────────────────────────────────

#[tokio::test]
async fn pg_register_node_assigns_ip() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("nodereg"), None, None).await.unwrap();
    let mkey = unique_key();
    let info = make_info("node-one");

    let (node_id, ipv4, generation) = store
        .register_node(tenant.id, mkey, info)
        .await
        .unwrap();

    assert!(node_id.as_i64() > 0);
    assert_eq!(ipv4.octets()[0], 100); // CGNAT range
    assert!(generation > 0);
}

#[tokio::test]
async fn pg_register_unique_ips() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("multi"), None, None).await.unwrap();

    let (_, ip1, _) = store
        .register_node(tenant.id, unique_key(), make_info("n1"))
        .await
        .unwrap();
    let (_, ip2, _) = store
        .register_node(tenant.id, unique_key(), make_info("n2"))
        .await
        .unwrap();

    assert_ne!(ip1, ip2);
}

#[tokio::test]
async fn pg_reregistration_reuses_node() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("rereg"), None, None).await.unwrap();
    let mkey = unique_key();

    let (id1, ip1, _) = store
        .register_node(tenant.id, mkey, make_info("orig-host"))
        .await
        .unwrap();
    let (id2, ip2, _) = store
        .register_node(tenant.id, mkey, make_info("new-host"))
        .await
        .unwrap();

    assert_eq!(id1, id2, "same machine key should reuse the node");
    assert_eq!(ip1, ip2, "IP should stay the same on re-registration");
}

// ── Peer queries ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn pg_peers_exclude_self() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("peers"), None, None).await.unwrap();
    let (n1, _, _) = store
        .register_node(tenant.id, unique_key(), make_info("p1"))
        .await
        .unwrap();
    let (_n2, _, _) = store
        .register_node(tenant.id, unique_key(), make_info("p2"))
        .await
        .unwrap();

    let peers = store.get_peers(tenant.id, n1).await;
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].hostname, "p2");
}

#[tokio::test]
async fn pg_tenant_isolation() {
    skip_without_db!(store);

    let t1 = store.create_tenant(unique("iso-a"), None, None).await.unwrap();
    let t2 = store.create_tenant(unique("iso-b"), None, None).await.unwrap();

    let (n1, _, _) = store
        .register_node(t1.id, unique_key(), make_info("t1-node"))
        .await
        .unwrap();
    store
        .register_node(t2.id, unique_key(), make_info("t2-node"))
        .await
        .unwrap();

    let peers = store.get_peers(t1.id, n1).await;
    assert!(peers.is_empty(), "t1 should not see t2's nodes");
}

// ── Node operations ───────────────────────────────────────────────────────────

#[tokio::test]
async fn pg_node_online_offline() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("online"), None, None).await.unwrap();
    let (node_id, _, _) = store
        .register_node(tenant.id, unique_key(), make_info("toggle"))
        .await
        .unwrap();

    store.set_node_online(node_id, false).await.unwrap();

    let detail = store.get_node_info(node_id).await.unwrap();
    assert_eq!(detail.info.hostname, "toggle");

    let nodes = store.list_nodes_for_tenant(tenant.id).await;
    let found = nodes.iter().find(|n| n.id == node_id).unwrap();
    assert!(!found.online, "node should be offline");
}

#[tokio::test]
async fn pg_offline_if_current_generation() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("gen"), None, None).await.unwrap();
    let (node_id, _, generation) = store
        .register_node(tenant.id, unique_key(), make_info("gen-node"))
        .await
        .unwrap();

    store
        .set_node_offline_if_current(node_id, generation - 1)
        .await
        .unwrap();
    let nodes = store.list_nodes_for_tenant(tenant.id).await;
    let found = nodes.iter().find(|n| n.id == node_id).unwrap();
    assert!(found.online, "stale gen should not mark offline");

    store
        .set_node_offline_if_current(node_id, generation)
        .await
        .unwrap();
    let nodes = store.list_nodes_for_tenant(tenant.id).await;
    let found = nodes.iter().find(|n| n.id == node_id).unwrap();
    assert!(!found.online, "current gen should mark offline");
}

#[tokio::test]
async fn pg_rename_node() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("rename"), None, None).await.unwrap();
    let (node_id, _, _) = store
        .register_node(tenant.id, unique_key(), make_info("old-name"))
        .await
        .unwrap();

    store.rename_node(node_id, "new-name".into()).await.unwrap();

    let detail = store.get_node_info(node_id).await.unwrap();
    assert_eq!(detail.info.hostname, "new-name");
}

#[tokio::test]
async fn pg_delete_node() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("delnode"), None, None).await.unwrap();
    let (node_id, _, _) = store
        .register_node(tenant.id, unique_key(), make_info("gone"))
        .await
        .unwrap();

    let tid = store.delete_node(node_id).await.unwrap();
    assert_eq!(tid, tenant.id);

    assert!(store.get_node_info(node_id).await.is_none());
}

#[tokio::test]
async fn pg_rotate_node_key() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("rotate"), None, None).await.unwrap();
    let mkey = unique_key();
    let new_nkey = unique_key();

    let info = make_info("rotate-node");
    let old_nkey: [u8; 32] = info.node_key.clone().try_into().unwrap();
    let (node_id, _, _) = store.register_node(tenant.id, mkey, info).await.unwrap();

    store.rotate_node_key(&mkey, &old_nkey, &new_nkey).await.unwrap();

    let detail = store.get_node_info(node_id).await.unwrap();
    assert_eq!(detail.info.node_key, new_nkey.to_vec());
}

#[tokio::test]
async fn pg_update_endpoints() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("ep"), None, None).await.unwrap();
    let (node_id, _, _) = store
        .register_node(tenant.id, unique_key(), make_info("ep-node"))
        .await
        .unwrap();

    store
        .update_endpoints(
            node_id,
            vec!["192.168.1.1:41641".into()],
            Some("disco:abc123".into()),
        )
        .await
        .unwrap();

    let detail = store.get_node_info(node_id).await.unwrap();
    assert_eq!(detail.info.endpoints, vec!["192.168.1.1:41641"]);
    assert_eq!(detail.info.disco_key.as_deref(), Some("disco:abc123"));
}

// ── Peer events ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn pg_peer_event_on_register() {
    skip_without_db!(store);

    let mut rx = store.subscribe();
    let tenant = store.create_tenant(unique("event"), None, None).await.unwrap();
    let (node_id, _, _) = store
        .register_node(tenant.id, unique_key(), make_info("ev-node"))
        .await
        .unwrap();

    let event = rx.try_recv().unwrap();
    match event {
        coord_store::PeerEvent::NodeJoined {
            tenant_id,
            node_id: nid,
        } => {
            assert_eq!(tenant_id, tenant.id);
            assert_eq!(nid, node_id);
        }
        _ => panic!("expected NodeJoined, got {:?}", event),
    }
}

// ── Route snapshot ────────────────────────────────────────────────────────────

#[tokio::test]
async fn pg_tenant_route_snapshot() {
    skip_without_db!(store);

    let parent = store.create_tenant(unique("snap-p"), None, None).await.unwrap();
    let child = store
        .create_tenant(unique("snap-c"), Some(parent.id), None)
        .await
        .unwrap();

    store
        .register_node(parent.id, unique_key(), make_info("parent-n"))
        .await
        .unwrap();
    store
        .register_node(child.id, unique_key(), make_info("child-n"))
        .await
        .unwrap();

    let snapshot = store.get_tenant_route_snapshot(parent.id).await.unwrap();
    assert_eq!(snapshot.own_nodes.len(), 1);
    assert_eq!(snapshot.children.len(), 1);
}
