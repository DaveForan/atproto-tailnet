//! PgStore integration tests against a real PostgreSQL instance.
//! Skipped without TEST_DATABASE_URL; a failure when `CI` is set. Run:
//!   TEST_DATABASE_URL=postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/coord_test cargo test -p coord-store --test pg_integration

use coord_core::{FederationPosture, NodeInfo};
use coord_store::PgStore;
use rand::RngCore;
use sqlx::PgPool;

/// TEST_DATABASE_URL, or `None` to skip. In CI (env `CI` set) a missing URL
/// is a failure, so these PostgreSQL tests cannot silently skip.
fn test_database_url() -> Option<String> {
    match std::env::var("TEST_DATABASE_URL") {
        Ok(url) if !url.is_empty() => Some(url),
        _ if std::env::var_os("CI").is_some() => {
            panic!("CI is set but TEST_DATABASE_URL is not: the PostgreSQL tests must run in CI")
        }
        _ => {
            eprintln!("NOTICE: TEST_DATABASE_URL not set; PostgreSQL test skipped");
            None
        }
    }
}

async fn setup() -> Option<PgStore> {
    let url = test_database_url()?;
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

/// A unique slug, so parallel runs do not collide.
fn unique(prefix: &str) -> String {
    let mut buf = [0u8; 4];
    rand::rng().fill_bytes(&mut buf);
    format!("{}-{}", prefix, hex::encode(buf))
}

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


#[tokio::test]
async fn pg_preauth_key_single_use() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("key"), None, None).await.unwrap();
    let key = store.create_preauth_key(tenant.id, false).await.unwrap();

    let tid = store.validate_preauth_key(&key).await.map(|g| g.tenant_id);
    assert_eq!(tid, Some(tenant.id));

    let tid2 = store.validate_preauth_key(&key).await.map(|g| g.tenant_id);
    assert_eq!(tid2, None, "single-use key should be consumed");
}

#[tokio::test]
async fn pg_preauth_key_reusable() {
    skip_without_db!(store);

    let tenant = store.create_tenant(unique("reuse"), None, None).await.unwrap();
    let key = store.create_preauth_key(tenant.id, true).await.unwrap();

    let tid1 = store.validate_preauth_key(&key).await.map(|g| g.tenant_id);
    assert_eq!(tid1, Some(tenant.id));

    let tid2 = store.validate_preauth_key(&key).await.map(|g| g.tenant_id);
    assert_eq!(tid2, Some(tenant.id), "reusable key should still validate");
}


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


#[tokio::test]
async fn pg_peer_event_on_register() {
    skip_without_db!(store);

    let mut rx = store.subscribe();
    let tenant = store.create_tenant(unique("event"), None, None).await.unwrap();
    let (node_id, _, _) = store
        .register_node(tenant.id, unique_key(), make_info("ev-node"))
        .await
        .unwrap();

    // The channel also carries events of other replicas (other tests on the
    // same database): find the event of this tenant.
    let mut joined = None;
    while let Ok(event) = rx.try_recv() {
        if let coord_store::PeerEvent::NodeJoined { tenant_id, node_id: nid } = event
            && tenant_id == tenant.id {
                joined = Some(nid);
            }
    }
    assert_eq!(joined, Some(node_id));
}


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


#[tokio::test]
async fn pg_events_reach_the_other_replica_but_not_twice_the_sender() {
    use coord_store::{PeerEvent, RemoteEvent};
    use std::time::Duration;
    skip_without_db!(a);
    let b = setup().await.unwrap();
    let tenant = a.create_tenant(unique("bus"), None, None).await.unwrap();
    let mut a_peers = a.subscribe();
    let mut b_peers = b.subscribe();
    let mut b_remote = b.subscribe_remote();
    let mut a_remote = a.subscribe_remote();

    // The listeners connect in the background, so publish until replica B hears it.
    // Each listener also emits a local Resync when it (re)connects; skip those.
    let mut heard = false;
    'publish: for _ in 0..50 {
        a.publish(RemoteEvent::TenantChanged(tenant.id)).await;
        while let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(100), b_remote.recv()).await {
            if e == RemoteEvent::Resync {
                continue;
            }
            assert_eq!(e, RemoteEvent::TenantChanged(tenant.id));
            heard = true;
            break 'publish;
        }
    }
    assert!(heard, "replica B never received the tenant-changed event");
    while let Ok(e) = a_remote.try_recv() {
        assert_eq!(e, RemoteEvent::Resync, "a replica does not receive its own remote events");
    }

    // A node that registers at replica A appears as an event at replica B
    let mut mkey = [0u8; 32];
    rand::rng().fill_bytes(&mut mkey);
    let (node_id, _, _) = a.register_node(tenant.id, mkey, make_info("bus-node")).await.unwrap();
    let want = |e: &PeerEvent| matches!(e, PeerEvent::NodeJoined { node_id: n, .. } if *n == node_id);
    let got = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if want(&b_peers.recv().await.unwrap()) {
                return;
            }
        }
    })
    .await;
    assert!(got.is_ok(), "replica B never saw the node join");

    // Replica A delivered it locally exactly once
    let mut local = 0;
    tokio::time::sleep(Duration::from_millis(200)).await;
    while let Ok(e) = a_peers.try_recv() {
        if want(&e) {
            local += 1;
        }
    }
    assert_eq!(local, 1);
}

/// A pool whose connections use `schema` as their only search path.
async fn pool_in_schema(url: &str, schema: &str) -> PgPool {
    let schema = schema.to_string();
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .after_connect(move |conn, _| {
            let schema = schema.clone();
            Box::pin(async move {
                sqlx::query(sqlx::AssertSqlSafe(format!("SET search_path TO {schema}"))).execute(conn).await?;
                Ok(())
            })
        })
        .connect(url)
        .await
        .expect("connect to test DB")
}

#[tokio::test]
async fn relay_store_verifies_the_schema_without_migrating() {
    let Some(url) = test_database_url() else { return };
    // A migrated database: the relay connects
    let migrated = PgStore::new(PgPool::connect(&url).await.unwrap()).await.expect("migrate");
    drop(migrated);
    PgStore::new_verified(PgPool::connect(&url).await.unwrap()).await.expect("schema is current");

    let admin = PgPool::connect(&url).await.unwrap();
    let suffix = hex::encode(rand::random::<[u8; 4]>());

    // Nothing there: refused, and nothing was created
    let empty = format!("relay_empty_{suffix}");
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {empty}"))).execute(&admin).await.unwrap();
    let err = PgStore::new_verified(pool_in_schema(&url, &empty).await).await.expect_err("refused").to_string();
    assert!(err.contains("start a control process first"), "{err}");
    let tables: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = $1")
        .bind(&empty)
        .fetch_one(&admin)
        .await
        .unwrap();
    assert_eq!(tables, 0, "a relay never creates tables");

    // An older schema: refused with both versions in the message
    let old = format!("relay_old_{suffix}");
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {old}"))).execute(&admin).await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE TABLE {old}._sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), \
         success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)"
    )))
    .execute(&admin)
    .await
    .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO {old}._sqlx_migrations VALUES (1, 'initial', now(), TRUE, '\\x00', 1)")))
        .execute(&admin)
        .await
        .unwrap();
    let err = PgStore::new_verified(pool_in_schema(&url, &old).await).await.expect_err("refused").to_string();
    assert!(err.contains("applied version 1") && err.contains(&format!("needs {}", PgStore::required_schema_version())), "{err}");

    for s in [empty, old] {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {s} CASCADE"))).execute(&admin).await.unwrap();
    }
}
