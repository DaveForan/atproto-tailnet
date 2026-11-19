//! The same scenarios run against every storage backend so Memory, SQLite and
//! Postgres stay behaviourally identical. Memory and SQLite (temp file) always
//! run; Postgres runs only when TEST_DATABASE_URL is set.

use std::sync::Arc;

use coord_core::{NodeInfo, NodeRegistration, PreAuthKeyOptions, TenantId};
use coord_store::{PeerEvent, Store};
use rand::RngCore;

struct Backend {
    name: &'static str,
    store: Arc<Store>,
    _cleanup: Option<TempDb>,
}

struct TempDb(std::path::PathBuf);

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut p = self.0.clone().into_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(p);
        }
    }
}

async fn backends() -> Vec<Backend> {
    let mut out = vec![Backend {
        name: "memory",
        store: Arc::new(Store::Memory(Box::new(coord_store::MemoryStore::new()))),
        _cleanup: None,
    }];

    let path = std::env::temp_dir().join(format!("coord-parity-{}.db", hex::encode(rand_bytes::<8>())));
    let pool = coord_store::create_sqlite_pool(path.to_str().unwrap()).await.unwrap();
    let sqlite = coord_store::SqliteStore::new(pool).await.unwrap();
    out.push(Backend { name: "sqlite", store: Arc::new(Store::Sqlite(sqlite)), _cleanup: Some(TempDb(path)) });

    if let Ok(url) = std::env::var("TEST_DATABASE_URL") {
        let pool = sqlx::PgPool::connect(&url).await.expect("connect to test DB");
        let pg = coord_store::PgStore::new(pool).await.expect("PgStore::new");
        out.push(Backend { name: "postgres", store: Arc::new(Store::Pg(pg)), _cleanup: None });
    }
    out
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::rng().fill_bytes(&mut b);
    b
}

fn unique(prefix: &str) -> String {
    format!("{}-{}", prefix, hex::encode(rand_bytes::<4>()))
}

fn info(hostname: &str, mkey: [u8; 32]) -> NodeInfo {
    NodeInfo {
        node_key: rand_bytes::<32>().to_vec(),
        machine_key: mkey.to_vec(),
        disco_key: None,
        endpoints: vec![],
        hostname: hostname.into(),
        os: "linux".into(),
        ipv4: None,
        ipv6: None,
    }
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

async fn tenant(store: &Store, prefix: &str) -> TenantId {
    store.create_tenant(unique(prefix), None, None).await.unwrap().id
}

#[tokio::test]
async fn preauth_key_metadata_listing_and_revocation() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "keys").await;
        let other = tenant(s, "keys-other").await;

        let k1 = s
            .create_preauth_key_with(
                t,
                PreAuthKeyOptions {
                    reusable: true,
                    ephemeral: true,
                    expires_at: None,
                    owner: Some("user-1".into()),
                    tags: strs(&["tag:relay"]),
                },
            )
            .await
            .unwrap();
        let k2 = s
            .create_preauth_key_with(t, PreAuthKeyOptions { owner: Some("user-1".into()), ..Default::default() })
            .await
            .unwrap();
        let k3 = s
            .create_preauth_key_with(t, PreAuthKeyOptions { owner: Some("user-2".into()), ..Default::default() })
            .await
            .unwrap();

        let grant = s.validate_preauth_key(&k1.key).await.expect(b.name);
        assert_eq!(grant.tenant_id, t, "{}", b.name);
        assert_eq!(grant.owner.as_deref(), Some("user-1"), "{}", b.name);
        assert_eq!(grant.tags, strs(&["tag:relay"]), "{}", b.name);
        assert!(grant.ephemeral, "{}", b.name);

        let list = s.list_preauth_keys(t).await;
        assert_eq!(list.len(), 3, "{}", b.name);
        let l1 = list.iter().find(|k| k.id == k1.id).unwrap();
        assert_eq!(l1.prefix, k1.key[..12], "{}", b.name);
        assert!(l1.used && l1.reusable && l1.ephemeral && !l1.revoked, "{}", b.name);
        assert_eq!(l1.tags, strs(&["tag:relay"]), "{}", b.name);
        assert!(s.list_preauth_keys(other).await.is_empty(), "{}", b.name);

        // Revoke by id: wrong tenant is a miss, right tenant revokes.
        assert!(!s.revoke_preauth_key(other, k3.id).await.unwrap(), "{}", b.name);
        assert!(s.revoke_preauth_key(t, k3.id).await.unwrap(), "{}", b.name);
        assert!(s.validate_preauth_key(&k3.key).await.is_none(), "{}: revoked key accepted", b.name);

        // Revoke by owner: counts only not-yet-revoked keys; reusable keys die too.
        assert_eq!(s.revoke_preauth_keys_by_owner(t, "user-1").await.unwrap(), 2, "{}", b.name);
        assert_eq!(s.revoke_preauth_keys_by_owner(t, "user-1").await.unwrap(), 0, "{}", b.name);
        assert!(s.validate_preauth_key(&k1.key).await.is_none(), "{}: revoked reusable key accepted", b.name);
        assert!(s.validate_preauth_key(&k2.key).await.is_none(), "{}", b.name);
        assert!(s.list_preauth_keys(t).await.iter().all(|k| k.revoked), "{}", b.name);
    }
}

#[tokio::test]
async fn expired_keys_rejected() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "expiry").await;
        let past = chrono::DateTime::from_timestamp(chrono::Utc::now().timestamp() - 10, 0);
        let future = chrono::DateTime::from_timestamp(chrono::Utc::now().timestamp() + 3600, 0);
        let expired = s
            .create_preauth_key_with(t, PreAuthKeyOptions { reusable: true, expires_at: past, ..Default::default() })
            .await
            .unwrap();
        let live = s
            .create_preauth_key_with(t, PreAuthKeyOptions { reusable: true, expires_at: future, ..Default::default() })
            .await
            .unwrap();
        assert!(s.validate_preauth_key(&expired.key).await.is_none(), "{}", b.name);
        assert!(s.validate_preauth_key(&live.key).await.is_some(), "{}", b.name);
        let listed = s.list_preauth_keys(t).await;
        let l = listed.iter().find(|k| k.id == live.id).unwrap();
        assert_eq!(l.expires_at, future, "{}", b.name);
    }
}

#[tokio::test]
async fn single_use_key_race_has_one_winner() {
    for b in backends().await {
        let t = tenant(&b.store, "race").await;
        let key = b.store.create_preauth_key(t, false).await.unwrap();
        let mut handles = Vec::new();
        for _ in 0..16 {
            let store = b.store.clone();
            let key = key.clone();
            handles.push(tokio::spawn(async move { store.validate_preauth_key(&key).await.is_some() }));
        }
        let mut wins = 0;
        for h in handles {
            if h.await.unwrap() {
                wins += 1;
            }
        }
        assert_eq!(wins, 1, "{}: single-use key consumed {wins} times", b.name);
    }
}

#[tokio::test]
async fn registration_attrs_and_routes() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "routes").await;
        let mk = rand_bytes::<32>();
        let (n1, ip1, _) = s
            .register_node_with(
                t,
                mk,
                info("router", mk),
                NodeRegistration {
                    owner: Some("alice".into()),
                    tags: strs(&["tag:relay"]),
                    ephemeral: true,
                    advertised_routes: Some(strs(&["0.0.0.0/0", "10.0.0.0/24"])),
                },
            )
            .await
            .unwrap();
        let mk2 = rand_bytes::<32>();
        let (n2, _, _) = s.register_node(t, mk2, info("peer", mk2)).await.unwrap();

        let d = s.get_node_info(n1).await.unwrap();
        assert_eq!(d.attrs.owner.as_deref(), Some("alice"), "{}", b.name);
        assert_eq!(d.attrs.tags, strs(&["tag:relay"]), "{}", b.name);
        assert!(d.attrs.ephemeral, "{}", b.name);
        assert_eq!(d.attrs.advertised_routes, strs(&["0.0.0.0/0", "10.0.0.0/24"]), "{}", b.name);
        assert!(d.attrs.approved_routes.is_empty(), "{}", b.name);

        // Unchanged → false; changed → true.
        assert!(!s.set_advertised_routes(n1, strs(&["0.0.0.0/0", "10.0.0.0/24"])).await.unwrap(), "{}", b.name);
        assert!(s.set_approved_routes(n1, strs(&["0.0.0.0/0", "10.0.0.0/24"])).await.unwrap(), "{}", b.name);
        assert!(!s.set_approved_routes(n1, strs(&["0.0.0.0/0", "10.0.0.0/24"])).await.unwrap(), "{}", b.name);
        assert!(s.set_approved_routes(rnode(), vec![]).await.is_err(), "{}", b.name);

        let peers = s.get_peers(t, n2).await;
        let p = peers.iter().find(|p| p.node_id == n1).unwrap();
        assert_eq!(p.addresses, vec![format!("{ip1}/32")], "{}", b.name);
        assert_eq!(
            p.allowed_ips,
            vec![format!("{ip1}/32"), "0.0.0.0/0".into(), "10.0.0.0/24".into()],
            "{}",
            b.name
        );
        assert_eq!(p.primary_routes, strs(&["10.0.0.0/24"]), "{}: exit routes are not primary", b.name);

        // Withdrawn advertisement stops being served even though still approved.
        assert!(s.set_advertised_routes(n1, strs(&["0.0.0.0/0"])).await.unwrap(), "{}", b.name);
        let p = s.get_peers(t, n2).await.into_iter().find(|p| p.node_id == n1).unwrap();
        assert_eq!(p.allowed_ips, vec![format!("{ip1}/32"), "0.0.0.0/0".into()], "{}", b.name);
        assert!(p.primary_routes.is_empty(), "{}", b.name);

        // Re-register keeps owner/tags/ephemeral; replaces advertised routes when given.
        s.register_node_with(
            t,
            mk,
            info("router", mk),
            NodeRegistration {
                owner: Some("mallory".into()),
                tags: vec![],
                ephemeral: false,
                advertised_routes: Some(strs(&["192.168.1.0/24"])),
            },
        )
        .await
        .unwrap();
        let d = s.get_node_info(n1).await.unwrap();
        assert_eq!(d.attrs.owner.as_deref(), Some("alice"), "{}", b.name);
        assert_eq!(d.attrs.tags, strs(&["tag:relay"]), "{}", b.name);
        assert!(d.attrs.ephemeral, "{}", b.name);
        assert_eq!(d.attrs.advertised_routes, strs(&["192.168.1.0/24"]), "{}", b.name);

        let summaries = s.list_nodes_for_tenant(t).await;
        let sum = summaries.iter().find(|n| n.id == n1).unwrap();
        assert_eq!(sum.attrs, d.attrs, "{}", b.name);
    }
}

fn rnode() -> coord_core::NodeId {
    coord_core::NodeId::new(i64::MAX - 7)
}

#[tokio::test]
async fn delete_nodes_by_owner_scoped_to_tenant_and_owner() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "owner-del").await;
        let other = tenant(s, "owner-del-o").await;
        let reg = |owner: &str| NodeRegistration { owner: Some(owner.into()), ..Default::default() };

        let mut bob_nodes = Vec::new();
        for i in 0..2 {
            let mk = rand_bytes::<32>();
            let (id, _, _) = s.register_node_with(t, mk, info(&format!("bob-{i}"), mk), reg("bob")).await.unwrap();
            bob_nodes.push(id);
        }
        let mk = rand_bytes::<32>();
        let (carol, _, _) = s.register_node_with(t, mk, info("carol", mk), reg("carol")).await.unwrap();
        let mk = rand_bytes::<32>();
        let (bob_elsewhere, _, _) = s.register_node_with(other, mk, info("bob-o", mk), reg("bob")).await.unwrap();

        let mut rx = s.subscribe();
        let deleted = s.delete_nodes_by_owner(t, "bob").await.unwrap();
        bob_nodes.sort_by_key(|n| n.as_i64());
        assert_eq!(deleted, bob_nodes, "{}", b.name);

        let mut offline = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let PeerEvent::NodeOffline { node_id, tenant_id } = ev {
                assert_eq!(tenant_id, t);
                offline.push(node_id);
            }
        }
        assert_eq!(offline, bob_nodes, "{}", b.name);

        for n in &bob_nodes {
            assert!(s.get_node_tenant(*n).await.is_none(), "{}", b.name);
        }
        assert_eq!(s.get_node_tenant(carol).await, Some(t), "{}", b.name);
        assert_eq!(s.get_node_tenant(bob_elsewhere).await, Some(other), "{}", b.name);
        assert!(s.delete_nodes_by_owner(t, "bob").await.unwrap().is_empty(), "{}", b.name);
    }
}

#[tokio::test]
async fn ephemeral_sweep() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "sweep").await;
        let eph = NodeRegistration { ephemeral: true, ..Default::default() };

        let mk = rand_bytes::<32>();
        let (gone, _, g) = s.register_node_with(t, mk, info("eph-off", mk), eph.clone()).await.unwrap();
        let mk = rand_bytes::<32>();
        let (online, _, _) = s.register_node_with(t, mk, info("eph-on", mk), eph.clone()).await.unwrap();
        let mk = rand_bytes::<32>();
        let (durable, _, dg) = s.register_node(t, mk, info("durable", mk)).await.unwrap();

        s.set_node_offline_if_current(gone, g).await.unwrap();
        s.set_node_offline_if_current(durable, dg).await.unwrap();

        // Within the grace period nothing is swept.
        let swept = s.delete_stale_ephemeral_nodes(chrono::Duration::minutes(5)).await.unwrap();
        assert!(swept.iter().all(|(tid, _)| *tid != t), "{}", b.name);
        assert!(s.get_node_tenant(gone).await.is_some(), "{}", b.name);

        let swept = s.delete_stale_ephemeral_nodes(chrono::Duration::zero()).await.unwrap();
        let ours: Vec<_> = swept.into_iter().filter(|(tid, _)| *tid == t).map(|(_, n)| n).collect();
        assert_eq!(ours, vec![gone], "{}", b.name);
        assert!(s.get_node_tenant(gone).await.is_none(), "{}", b.name);
        assert!(s.get_node_tenant(online).await.is_some(), "{}", b.name);
        assert!(s.get_node_tenant(durable).await.is_some(), "{}", b.name);
    }
}
