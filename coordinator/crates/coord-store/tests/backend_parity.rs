//! The same scenarios run against every storage backend so Memory, SQLite and
//! Postgres stay behaviourally identical. Memory and SQLite (temp file) always
//! run; Postgres runs only when TEST_DATABASE_URL is set.

use std::sync::Arc;

use coord_core::{NodeInfo, NodeRegistration, PreAuthKeyOptions, TenantId};
use coord_core::clock::{self, Duration};
use coord_store::{PeerEvent, Store};
use rand::RngCore;

struct Backend {
    name: &'static str,
    store: Arc<Store>,
    /// Direct SQL access, for tests that plant rows the store would never write.
    raw: Option<RawDb>,
    _cleanup: Option<TempDb>,
}

enum RawDb {
    Sqlite(sqlx::SqlitePool),
    Pg(sqlx::PgPool),
}

impl RawDb {
    async fn put_raw_lock(&self, t: TenantId, owner: &str, json: &str) {
        match self {
            RawDb::Sqlite(p) => {
                sqlx::query("INSERT INTO coord_owner_locks (tenant_id, owner, lock) VALUES (?1, ?2, ?3)")
                    .bind(t.as_uuid().to_string())
                    .bind(owner)
                    .bind(json)
                    .execute(p)
                    .await
                    .unwrap();
            }
            RawDb::Pg(p) => {
                sqlx::query("INSERT INTO coord_owner_locks (tenant_id, owner, lock) VALUES ($1, $2, $3::jsonb)")
                    .bind(t.as_uuid())
                    .bind(owner)
                    .bind(json)
                    .execute(p)
                    .await
                    .unwrap();
            }
        }
    }

    async fn stored_key_columns(&self, t: TenantId) -> Vec<(String, String)> {
        match self {
            RawDb::Sqlite(p) => sqlx::query_as("SELECT key, key_prefix FROM coord_preauth_keys WHERE tenant_id = ?1")
                .bind(t.as_uuid().to_string())
                .fetch_all(p)
                .await
                .unwrap(),
            RawDb::Pg(p) => sqlx::query_as("SELECT key, key_prefix FROM coord_preauth_keys WHERE tenant_id = $1")
                .bind(t.as_uuid())
                .fetch_all(p)
                .await
                .unwrap(),
        }
    }
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
        raw: None,
        _cleanup: None,
    }];

    let path = std::env::temp_dir().join(format!("coord-parity-{}.db", hex::encode(rand_bytes::<8>())));
    let pool = coord_store::create_sqlite_pool(path.to_str().unwrap()).await.unwrap();
    let sqlite = coord_store::SqliteStore::new(pool.clone()).await.unwrap();
    out.push(Backend { name: "sqlite", store: Arc::new(Store::Sqlite(sqlite)), raw: Some(RawDb::Sqlite(pool)), _cleanup: Some(TempDb(path)) });

    if let Some(url) = test_database_url() {
        let pool = sqlx::PgPool::connect(&url).await.expect("connect to test DB");
        let pg = coord_store::PgStore::new(pool.clone()).await.expect("PgStore::new");
        out.push(Backend { name: "postgres", store: Arc::new(Store::Pg(pg)), raw: Some(RawDb::Pg(pool)), _cleanup: None });
    }
    out
}

/// TEST_DATABASE_URL, or `None` to skip PostgreSQL. In CI (env `CI` set) a
/// missing URL is a failure, so the PostgreSQL tests cannot silently skip.
fn test_database_url() -> Option<String> {
    match std::env::var("TEST_DATABASE_URL") {
        Ok(url) if !url.is_empty() => Some(url),
        _ if std::env::var_os("CI").is_some() => {
            panic!("CI is set but TEST_DATABASE_URL is not: the PostgreSQL tests must run in CI")
        }
        _ => {
            eprintln!("NOTICE: TEST_DATABASE_URL not set; PostgreSQL backend skipped in backend_parity");
            None
        }
    }
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
        let past = clock::from_unix(clock::now().unix_timestamp() - 10);
        let future = clock::from_unix(clock::now().unix_timestamp() + 3600);
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
                    hold: coord_core::Hold::None,
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

        // The setters return true only when the routes change.
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

        // Re-registering with the same grant identity keeps approvals.
        // Given advertised routes replace the old ones.
        let same = NodeRegistration {
            owner: Some("alice".into()),
            tags: strs(&["tag:relay"]),
            ephemeral: true,
            advertised_routes: None,
            hold: coord_core::Hold::None,
        };
        s.register_node_with(t, mk, info("router", mk), same).await.unwrap();
        let d = s.get_node_info(n1).await.unwrap();
        assert_eq!(d.attrs.approved_routes, strs(&["0.0.0.0/0", "10.0.0.0/24"]), "{}", b.name);
        assert_eq!(d.attrs.advertised_routes, strs(&["0.0.0.0/0"]), "{}", b.name);

        // Re-registering with a different grant replaces owner, tags and ephemeral.
        // It drops approvals granted to the old identity.
        s.register_node_with(
            t,
            mk,
            info("router", mk),
            NodeRegistration {
                owner: Some("mallory".into()),
                tags: vec![],
                ephemeral: false,
                advertised_routes: Some(strs(&["192.168.1.0/24"])),
                hold: coord_core::Hold::None,
            },
        )
        .await
        .unwrap();
        let d = s.get_node_info(n1).await.unwrap();
        assert_eq!(d.attrs.owner.as_deref(), Some("mallory"), "{}", b.name);
        assert!(d.attrs.tags.is_empty(), "{}", b.name);
        assert!(!d.attrs.ephemeral, "{}", b.name);
        assert!(d.attrs.approved_routes.is_empty(), "{}: approvals must not survive re-auth", b.name);
        assert_eq!(d.attrs.advertised_routes, strs(&["192.168.1.0/24"]), "{}", b.name);
        assert_eq!(d.ipv4, ip1, "{}: re-auth keeps the address", b.name);

        let summaries = s.list_nodes_for_tenant(t).await;
        let sum = summaries.iter().find(|n| n.id == n1).unwrap();
        assert_eq!(sum.attrs, d.attrs, "{}", b.name);
    }
}

#[tokio::test]
async fn a_held_node_is_no_peer_until_it_is_admitted() {
    use coord_core::Hold;
    let held = |owner: &str, hold| NodeRegistration { owner: Some(owner.into()), hold, ..Default::default() };
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "hold").await;
        let (first_key, new_key) = (rand_bytes::<32>(), rand_bytes::<32>());
        let (first, _, _) = s.register_node_with(t, first_key, info("first", first_key), held("alice", Hold::None)).await.unwrap();
        let (new, _, _) = s.register_node_with(t, new_key, info("new", new_key), held("alice", Hold::Owner)).await.unwrap();
        let hold_of = |id| async move { s.get_node_info(id).await.unwrap().attrs.hold };
        let peers_of = |id| async move { s.get_peers(t, id).await.into_iter().map(|p| p.node_id).collect::<Vec<_>>() };

        assert_eq!(hold_of(new).await, Hold::Owner, "{}", b.name);
        assert!(peers_of(first).await.is_empty(), "{}: a held node is no peer", b.name);
        assert!(s.get_peers_with_children(t, first).await.is_empty(), "{}", b.name);
        let listed = s.list_nodes_for_tenant(t).await;
        let summary = listed.iter().find(|n| n.id == new).unwrap();
        assert_eq!((summary.attrs.hold, summary.machine_key.as_slice()), (Hold::Owner, &new_key[..]), "{}", b.name);

        // A step applies only from the hold that the caller saw.
        assert!(!s.set_node_hold(new, Hold::Approver, Hold::None).await.unwrap(), "{}", b.name);
        assert!(s.set_node_hold(new, Hold::Owner, Hold::Approver).await.unwrap(), "{}", b.name);
        assert!(peers_of(first).await.is_empty(), "{}: the approver step is still a hold", b.name);

        // The same owner keeps the steps done. A key cannot move the node forward or back.
        s.register_node_with(t, new_key, info("new", new_key), held("alice", Hold::Owner)).await.unwrap();
        assert_eq!(hold_of(new).await, Hold::Approver, "{}", b.name);

        assert!(s.set_node_hold(new, Hold::Approver, Hold::None).await.unwrap(), "{}", b.name);
        assert_eq!(peers_of(first).await, vec![new], "{}", b.name);
        s.register_node_with(t, new_key, info("new", new_key), held("alice", Hold::Owner)).await.unwrap();
        assert_eq!(hold_of(new).await, Hold::None, "{}: an admitted machine of the same owner stays admitted", b.name);

        // Another owner on the same machine starts again.
        s.register_node_with(t, new_key, info("new", new_key), held("mallory", Hold::Owner)).await.unwrap();
        assert_eq!(hold_of(new).await, Hold::Owner, "{}", b.name);
        assert!(peers_of(first).await.is_empty(), "{}", b.name);
        assert!(s.set_node_hold(rnode(), Hold::Owner, Hold::None).await.is_err(), "{}: unknown node", b.name);
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
            // On PostgreSQL the channel also carries events of other replicas
            // (other tests on the same database): look at this tenant only.
            if let PeerEvent::NodeOffline { node_id, tenant_id } = ev
                && tenant_id == t {
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
        let swept = s.delete_stale_ephemeral_nodes(Duration::minutes(5)).await.unwrap();
        assert!(swept.iter().all(|(tid, _)| *tid != t), "{}", b.name);
        assert!(s.get_node_tenant(gone).await.is_some(), "{}", b.name);

        let swept = s.delete_stale_ephemeral_nodes(Duration::ZERO).await.unwrap();
        let ours: Vec<_> = swept.into_iter().filter(|(tid, _)| *tid == t).map(|(_, n)| n).collect();
        assert_eq!(ours, vec![gone], "{}", b.name);
        assert!(s.get_node_tenant(gone).await.is_none(), "{}", b.name);
        assert!(s.get_node_tenant(online).await.is_some(), "{}", b.name);
        assert!(s.get_node_tenant(durable).await.is_some(), "{}", b.name);
    }
}

#[tokio::test]
async fn map_session_marks_online_and_owns_the_generation() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "session").await;
        let mk = rand_bytes::<32>();
        let (id, _, g1) = s.register_node(t, mk, info("laptop", mk)).await.unwrap();
        let online = |nodes: Vec<coord_core::NodeSummary>| nodes.into_iter().find(|n| n.id == id).unwrap().online;

        s.set_node_offline_if_current(id, g1).await.unwrap();
        assert!(!online(s.list_nodes_for_tenant(t).await), "{}", b.name);

        // A reconnect opens a map stream without registering again.
        let g2 = s.begin_node_session(id).await.unwrap();
        assert!(g2 > g1, "{}", b.name);
        assert!(online(s.list_nodes_for_tenant(t).await), "{}", b.name);

        // The old connection's late disconnect must not undo it.
        s.set_node_offline_if_current(id, g1).await.unwrap();
        assert!(online(s.list_nodes_for_tenant(t).await), "{}", b.name);
        s.set_node_offline_if_current(id, g2).await.unwrap();
        assert!(!online(s.list_nodes_for_tenant(t).await), "{}", b.name);

        assert!(s.begin_node_session(coord_core::NodeId::new(i64::MAX)).await.is_err(), "{}", b.name);
    }
}

#[tokio::test]
async fn tenant_suspension_round_trip() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "susp").await;
        let other = tenant(s, "susp-other").await;
        let key = s.create_preauth_key(t, false).await.unwrap();

        assert!(!s.get_tenant(t).await.unwrap().suspended, "{}: default unsuspended", b.name);
        assert!(!s.is_tenant_suspended(t).await, "{}", b.name);

        let updated = s.set_tenant_suspended(t, true).await.unwrap();
        assert!(updated.suspended, "{}", b.name);
        assert_eq!(updated.id, t, "{}", b.name);
        assert!(s.get_tenant(t).await.unwrap().suspended, "{}", b.name);
        assert!(s.is_tenant_suspended(t).await, "{}", b.name);
        assert!(!s.is_tenant_suspended(other).await, "{}: other tenant untouched", b.name);
        let listed = s.list_tenants().await;
        assert!(listed.iter().find(|x| x.id == t).unwrap().suspended, "{}", b.name);
        assert!(!listed.iter().find(|x| x.id == other).unwrap().suspended, "{}", b.name);

        // The non-consuming key lookup lets registration refuse before validation.
        assert_eq!(s.preauth_key_tenant(&key).await, Some(t), "{}", b.name);
        assert_eq!(s.preauth_key_tenant("tskey-auth-nope").await, None, "{}", b.name);
        assert!(s.validate_preauth_key(&key).await.is_some(), "{}: lookup must not consume", b.name);

        let restored = s.set_tenant_suspended(t, false).await.unwrap();
        assert!(!restored.suspended, "{}", b.name);
        assert!(!s.is_tenant_suspended(t).await, "{}", b.name);

        let missing = TenantId::generate();
        assert!(
            matches!(s.set_tenant_suspended(missing, true).await, Err(coord_core::CoordError::TenantNotFound(_))),
            "{}: unknown tenant",
            b.name
        );
        assert!(!s.is_tenant_suspended(missing).await, "{}", b.name);
    }
}

#[tokio::test]
async fn sqlite_tenant_suspension_persists_across_reopen() {
    let path = std::env::temp_dir().join(format!("coord-susp-{}.db", hex::encode(rand_bytes::<8>())));
    let _cleanup = TempDb(path.clone());
    let t = {
        let pool = coord_store::create_sqlite_pool(path.to_str().unwrap()).await.unwrap();
        let s = Store::Sqlite(coord_store::SqliteStore::new(pool.clone()).await.unwrap());
        let t = tenant(&s, "susp-persist").await;
        s.set_tenant_suspended(t, true).await.unwrap();
        pool.close().await;
        t
    };
    let pool = coord_store::create_sqlite_pool(path.to_str().unwrap()).await.unwrap();
    let s = Store::Sqlite(coord_store::SqliteStore::new(pool).await.unwrap());
    assert!(s.get_tenant(t).await.unwrap().suspended);
}

/// Register `n` fresh nodes in `t`, returning (node id, address) pairs.
async fn register_many(s: &Store, t: TenantId, n: usize) -> Vec<(coord_core::NodeId, std::net::Ipv4Addr)> {
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let mk = rand_bytes::<32>();
        let (id, ip, _) = s.register_node(t, mk, info(&format!("churn-{i}"), mk)).await.unwrap();
        out.push((id, ip));
    }
    out
}

/// No two live nodes (across all tenants) may share an address.
async fn assert_live_addresses_unique(s: &Store, name: &str) {
    let nodes = s.list_nodes().await;
    let mut seen = std::collections::HashSet::new();
    for n in &nodes {
        assert!(seen.insert(n.ipv4), "{name}: duplicate live address {}", n.ipv4);
    }
}

#[tokio::test]
async fn ipv4_addresses_reused_after_delete_and_never_duplicated() {
    for b in backends().await {
        let s = &b.store;
        // Postgres shares one database with concurrently running tests, so
        // exact "lowest free" assertions only hold for the private backends.
        let exact = b.name != "postgres";
        let t = tenant(s, "churn").await;
        let eph = tenant(s, "churn-eph").await;

        let first = register_many(s, t, 20).await;
        let mut freed = Vec::new();
        for (id, ip) in first.iter().step_by(2) {
            s.delete_node(*id).await.unwrap();
            freed.push(*ip);
        }
        let refill = register_many(s, t, freed.len()).await;
        if exact {
            let mut got: Vec<_> = refill.iter().map(|(_, ip)| *ip).collect();
            got.sort();
            freed.sort();
            assert_eq!(got, freed, "{}: freed addresses are reused lowest-first", b.name);
        }
        assert_live_addresses_unique(s, b.name).await;

        // Sustained churn (incl. ephemeral sweep) must not walk the address space.
        let mut distinct = std::collections::HashSet::new();
        for _ in 0..20 {
            let batch = register_many(s, t, 10).await;
            for (id, ip) in &batch {
                distinct.insert(*ip);
                s.delete_node(*id).await.unwrap();
            }
            let mk = rand_bytes::<32>();
            let (_, ip, g) = s
                .register_node_with(eph, mk, info("eph", mk), NodeRegistration { ephemeral: true, ..Default::default() })
                .await
                .unwrap();
            distinct.insert(ip);
            let id = s.get_node_by_machine_key(&mk).await.unwrap();
            s.set_node_offline_if_current(id, g).await.unwrap();
            s.delete_stale_ephemeral_nodes(Duration::ZERO).await.unwrap();
        }
        // 220 registrations; a never-reusing allocator would hand out 220 addresses.
        let bound = if exact { 11 } else { 120 };
        assert!(distinct.len() <= bound, "{}: churn used {} distinct addresses", b.name, distinct.len());
        assert_live_addresses_unique(s, b.name).await;

        // Concurrent registrations never collide.
        let handles: Vec<_> = (0..24)
            .map(|i| {
                let s = b.store.clone();
                tokio::spawn(async move {
                    let mk = rand_bytes::<32>();
                    s.register_node(t, mk, info(&format!("par-{i}"), mk)).await.unwrap().1
                })
            })
            .collect();
        let mut ips = std::collections::HashSet::new();
        for h in handles {
            assert!(ips.insert(h.await.unwrap()), "{}: concurrent registrations got the same address", b.name);
        }
        assert_live_addresses_unique(s, b.name).await;

        for n in s.list_nodes_for_tenant(t).await {
            s.delete_node(n.id).await.unwrap();
        }
    }
}

#[tokio::test]
async fn node_lookup_by_node_key() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "nodekey").await;
        let mk = rand_bytes::<32>();
        let node_info = info("relay-client", mk);
        let node_key: [u8; 32] = node_info.node_key.clone().try_into().unwrap();
        let (id, _, _) = s
            .register_node_with(t, mk, node_info, NodeRegistration::default())
            .await
            .unwrap();
        assert_eq!(s.get_node_by_node_key(&node_key).await, Some(id), "{}", b.name);
        assert_eq!(s.get_node_by_node_key(&rand_bytes::<32>()).await, None, "{}", b.name);
    }
}

#[tokio::test]
async fn tenant_access_round_trip_and_default() {
    use coord_core::{AccessMode, AccessPort, AccessProto, AccessRule, TenantAccess};
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "access").await;
        assert_eq!(s.get_tenant_access(t).await, TenantAccess::default(), "{}", b.name);

        let access = TenantAccess {
            mode: AccessMode::Member,
            rules: vec![AccessRule {
                src_owner: Some("alice".into()),
                src_nodes: vec![],
                dst_node: 7,
                ports: vec![AccessPort { proto: AccessProto::Tcp, first: 3000, last: 3000 }],
            }],
            open_owners: vec!["bob".into()],
            unheld_owners: vec!["carol".into()],
        };
        s.set_tenant_access(t, access.clone()).await.unwrap();
        assert_eq!(s.get_tenant_access(t).await, access, "{}", b.name);

        // Replaced, not merged
        s.set_tenant_access(t, TenantAccess { mode: AccessMode::Member, ..Default::default() }).await.unwrap();
        assert!(s.get_tenant_access(t).await.rules.is_empty(), "{}", b.name);

        let missing = TenantId::new(uuid::Uuid::new_v4());
        assert!(s.set_tenant_access(missing, TenantAccess::default()).await.is_err(), "{}", b.name);
    }
}

#[tokio::test]
async fn tenant_dns_round_trip_and_default() {
    use coord_core::{DnsRecord, TenantDns};
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "dns").await;
        assert_eq!(s.get_tenant_dns(t).await, TenantDns::default(), "{}", b.name);
        let dns = TenantDns {
            base_domain: Some("ts.example.com".into()),
            tailnet_label: Some("harbor".into()),
            upstream: vec!["1.1.1.1".into()],
            records: vec![DnsRecord { name: "notes".into(), node: 4, owner: Some("alice".into()), nodes: vec![7], port: None }],
        };
        s.set_tenant_dns(t, dns.clone()).await.unwrap();
        assert_eq!(s.get_tenant_dns(t).await, dns, "{}", b.name);
        assert!(s.set_tenant_dns(TenantId::new(uuid::Uuid::new_v4()), TenantDns::default()).await.is_err(), "{}", b.name);
    }
}

#[tokio::test]
async fn owner_lock_round_trip_and_removal() {
    use coord_core::{LockRead, OwnerLock};
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "lock").await;
        assert_eq!(s.get_owner_lock(t, "alice").await.unwrap(), LockRead::Unlocked, "{}", b.name);
        let lock = OwnerLock { machines: vec!["ab".repeat(32)], allow_one_until: Some(clock::now()), refused: vec![], max_machines: Some(3) };
        s.set_owner_lock(t, "alice", Some(lock.clone())).await.unwrap();
        let got = s.get_owner_lock(t, "alice").await.unwrap();
        let got = got.lock().unwrap();
        assert_eq!(got.machines, lock.machines, "{}", b.name);
        assert!(got.allow_one_until.is_some(), "{}", b.name);
        assert_eq!(got.max_machines, Some(3), "{}", b.name);
        assert!(s.list_owner_locks().await.iter().any(|(tid, o, l)| *tid == t && o == "alice" && l.max_machines == Some(3)), "{}", b.name);
        assert_eq!(s.get_owner_lock(t, "bob").await.unwrap(), LockRead::Unlocked, "locks are per owner ({})", b.name);
        s.set_owner_lock(t, "alice", None).await.unwrap();
        assert_eq!(s.get_owner_lock(t, "alice").await.unwrap(), LockRead::Unlocked, "{}", b.name);
        assert!(s.set_owner_lock(TenantId::new(uuid::Uuid::new_v4()), "alice", None).await.is_err(), "{}", b.name);
    }
}

#[tokio::test]
async fn owner_lock_check_records_and_consumes_the_window_atomically() {
    use coord_core::{LockOutcome, OwnerLock};
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "lockchk").await;
        let known = [1u8; 32];
        assert_eq!(s.check_owner_lock(t, "alice", &known, "h", "linux", "f").await.unwrap(), None, "unlocked ({})", b.name);
        let lock = OwnerLock { machines: vec![hex::encode(known)], ..Default::default() };
        s.set_owner_lock(t, "alice", Some(lock)).await.unwrap();
        assert_eq!(s.check_owner_lock(t, "alice", &known, "h", "linux", "f").await.unwrap(), Some(LockOutcome::Allowed), "{}", b.name);
        assert_eq!(s.check_owner_lock(t, "alice", &[2u8; 32], "evil", "linux", "f").await.unwrap(), Some(LockOutcome::Refused), "{}", b.name);
        let stored = s.get_owner_lock(t, "alice").await.unwrap();
        assert_eq!(stored.lock().unwrap().refused.len(), 1, "the refusal is persisted ({})", b.name);

        // Open the window, then race many new machines: exactly one gets in.
        s.update_owner_lock(t, "alice", |read| {
            let mut l = read.lock().unwrap().clone();
            l.allow_one_until = Some(clock::now() + Duration::minutes(10));
            (coord_core::LockWrite::Set(l), ())
        })
        .await
        .unwrap();
        let mut tasks = Vec::new();
        for i in 10u8..18 {
            let s = b.store.clone();
            tasks.push(tokio::spawn(async move { s.check_owner_lock(t, "alice", &[i; 32], "new", "linux", "f").await.unwrap() }));
        }
        let mut admitted = 0;
        for task in tasks {
            if task.await.unwrap() == Some(LockOutcome::AllowedNew) {
                admitted += 1;
            }
        }
        assert_eq!(admitted, 1, "one window admits exactly one machine ({})", b.name);
        let after = s.get_owner_lock(t, "alice").await.unwrap();
        let after = after.lock().unwrap();
        assert_eq!(after.machines.len(), 2, "{}", b.name);
        assert_eq!(after.allow_one_until, None, "{}", b.name);
        assert_eq!(after.refused.len(), 1 + 7, "every loser is recorded, none lost to a stale write ({})", b.name);
    }
}

#[tokio::test]
async fn a_malformed_stored_lock_refuses_every_machine() {
    use coord_core::{LockOutcome, LockRead};
    for b in backends().await {
        let Some(raw) = &b.raw else { continue };
        let s = &b.store;
        let t = tenant(s, "lockbad").await;
        raw.put_raw_lock(t, "alice", "{\"machines\": 42}").await;
        assert_eq!(s.get_owner_lock(t, "alice").await.unwrap(), LockRead::Malformed, "{}", b.name);
        assert_eq!(s.check_owner_lock(t, "alice", &[1u8; 32], "h", "linux", "f").await.unwrap(), Some(LockOutcome::Refused), "{}", b.name);
        assert_eq!(s.get_owner_lock(t, "alice").await.unwrap(), LockRead::Malformed, "left for an admin to fix ({})", b.name);
        // An admin can replace or remove it
        s.set_owner_lock(t, "alice", None).await.unwrap();
        assert_eq!(s.check_owner_lock(t, "alice", &[1u8; 32], "h", "linux", "f").await.unwrap(), None, "{}", b.name);
    }
}

#[tokio::test]
async fn preauth_keys_are_stored_hashed_and_listed_by_prefix() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "keyhash").await;
        let created = s.create_preauth_key_with(t, PreAuthKeyOptions { reusable: true, ..Default::default() }).await.unwrap();
        let listed = s.list_preauth_keys(t).await;
        assert_eq!(listed.len(), 1, "{}", b.name);
        assert_eq!(listed[0].prefix, coord_core::preauth_key_prefix(&created.key), "{}", b.name);
        assert!(!created.key.starts_with(&listed[0].prefix) || listed[0].prefix.len() < created.key.len(), "{}", b.name);
        assert_eq!(s.preauth_key_tenant(&created.key).await, Some(t), "{}", b.name);
        assert!(s.validate_preauth_key(&created.key).await.is_some(), "{}", b.name);
        // The digest itself is not a credential
        let digest = coord_store::hash_preauth_key(&created.key);
        assert!(s.validate_preauth_key(&digest).await.is_none(), "{}", b.name);
        assert_eq!(s.preauth_key_tenant(&digest).await, None, "{}", b.name);
        if let Some(raw) = &b.raw {
            let stored = raw.stored_key_columns(t).await;
            assert_eq!(stored, vec![(digest.clone(), listed[0].prefix.clone())], "only the hash is at rest ({})", b.name);
        }
    }
}

#[tokio::test]
async fn tenant_config_round_trip_list_and_removal() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "cfg").await;
        assert!(s.get_tenant_configs(t).await.unwrap().is_empty(), "{}", b.name);
        s.set_tenant_config(t, "acl", Some(serde_json::json!({"rules": [1, 2]}))).await.unwrap();
        s.set_tenant_config(t, "identity", Some(serde_json::json!({"tailnet_name": "x"}))).await.unwrap();
        s.set_tenant_config(t, "acl", Some(serde_json::json!({"rules": [3]}))).await.unwrap();
        let mut got = s.get_tenant_configs(t).await.unwrap();
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(got, vec![
            ("acl".to_string(), serde_json::json!({"rules": [3]})),
            ("identity".to_string(), serde_json::json!({"tailnet_name": "x"})),
        ], "{}", b.name);
        assert!(s.list_tenant_configs().await.unwrap().iter().any(|(tid, k, _)| *tid == t && k == "acl"), "{}", b.name);
        s.set_tenant_config(t, "acl", None).await.unwrap();
        assert_eq!(s.get_tenant_configs(t).await.unwrap().len(), 1, "{}", b.name);
        s.delete_tenant(t).await.unwrap();
        assert!(s.get_tenant_configs(t).await.unwrap().is_empty(), "config goes with the tenant ({})", b.name);
    }
}

#[tokio::test]
async fn sign_in_is_decided_once_and_taken_once() {
    use coord_core::{SignInDecision, SignInLimits, SignInStart};
    const LIMITS: SignInLimits = SignInLimits { per_ip: 20, total: 10_000 };
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "signin").await;
        let key = [7u8; 32];
        let id = format!("{}-first", b.name);
        let before = clock::now().unix_timestamp();
        assert_eq!(s.sign_in_start(&id, &key, "phone", "iOS", Some("203.0.113.7"), LIMITS).await.unwrap(), SignInStart::Started);
        let p = s.sign_in_get(&id).await.unwrap();
        assert_eq!((p.machine_key, p.hostname.as_str(), p.decision.clone()), (key, "phone", None), "{}", b.name);
        assert_eq!(p.requester_ip.as_deref(), Some("203.0.113.7"), "{}", b.name);
        let at = p.requested_at.unix_timestamp();
        assert!(at >= before && at <= clock::now().unix_timestamp(), "{}", b.name);
        assert_eq!(s.sign_in_take(&id).await, None, "a pending sign-in cannot be taken ({})", b.name);

        // A new sign-in of the same machine replaces the old one
        let id2 = format!("{}-second", b.name);
        s.sign_in_start(&id2, &key, "phone", "iOS", None, LIMITS).await.unwrap();
        assert!(s.sign_in_get(&id).await.is_none(), "{}", b.name);
        assert_eq!(s.sign_in_get(&id2).await.unwrap().requester_ip, None, "{}", b.name);

        let yes = SignInDecision::Approved { tenant_id: t, owner: "alice".into(), hold: coord_core::Hold::Approver };
        assert!(s.sign_in_decide(&id2, &yes).await, "{}", b.name);
        assert!(!s.sign_in_decide(&id2, &SignInDecision::Denied).await, "decided once ({})", b.name);
        assert!(!s.sign_in_decide("unknown", &yes).await, "{}", b.name);
        assert_eq!(s.sign_in_get(&id2).await.unwrap().decision, Some(yes.clone()), "{}", b.name);
        assert_eq!(s.sign_in_take(&id2).await, Some(yes), "{}", b.name);
        assert_eq!(s.sign_in_take(&id2).await, None, "taken once ({})", b.name);
    }
}

#[tokio::test]
async fn full_sign_in_caps_refuse_new_sign_ins_and_keep_pending_ones() {
    use coord_core::{SignInLimits, SignInStart};
    let limits = SignInLimits { per_ip: 2, total: 10_000 };
    for b in backends().await {
        let s = &b.store;
        // The PostgreSQL table is shared with other tests: use an address no other test uses
        let r = rand_bytes::<3>();
        let ip = format!("10.{}.{}.{}", r[0], r[1], r[2]);
        let other_ip = format!("10.{}.{}.{}", r[0], r[1], r[2].wrapping_add(1));
        let id = |n: &str| format!("{}-cap-{}-{}", b.name, hex::encode(r), n);
        let start = |n: u8, ip: Option<String>| {
            let id = id(&n.to_string());
            async move { s.sign_in_start(&id, &[n; 32], "x", "linux", ip.as_deref(), limits).await.unwrap() }
        };

        assert_eq!(start(1, Some(ip.clone())).await, SignInStart::Started, "{}", b.name);
        assert_eq!(start(2, Some(ip.clone())).await, SignInStart::Started, "{}", b.name);
        assert_eq!(start(3, Some(ip.clone())).await, SignInStart::TooManyFromAddress, "{}", b.name);
        assert!(s.sign_in_get(&id("1")).await.is_some(), "a refused start evicts nothing ({})", b.name);
        assert!(s.sign_in_get(&id("2")).await.is_some(), "{}", b.name);
        assert!(s.sign_in_get(&id("3")).await.is_none(), "{}", b.name);
        // A machine that starts again replaces its own sign-in, so it is not refused
        assert_eq!(start(2, Some(ip.clone())).await, SignInStart::Started, "{}", b.name);
        // Other addresses and unknown addresses have their own budget
        assert_eq!(start(4, Some(other_ip)).await, SignInStart::Started, "{}", b.name);
        assert_eq!(start(5, None).await, SignInStart::Started, "{}", b.name);

        // The global cap refuses everyone and evicts nothing
        let none = SignInLimits { per_ip: 2, total: 0 };
        let full = s.sign_in_start(&id("6"), &[6; 32], "x", "linux", None, none).await.unwrap();
        assert_eq!(full, SignInStart::Full, "{}", b.name);
        assert!(s.sign_in_get(&id("6")).await.is_none(), "{}", b.name);
        assert!(s.sign_in_get(&id("1")).await.is_some(), "{}", b.name);
    }
}

#[tokio::test]
async fn relays_are_listed_while_fresh_and_home_relays_are_recorded() {
    use coord_core::RelayInfo;
    for b in backends().await {
        let s = &b.store;
        // Region ids are instance-wide: use ids that other tests do not use
        let base = 300 + (rand_bytes::<1>()[0] as i32) * 2;
        let one = RelayInfo { region_id: base, hostname: format!("relay-{base}.example.com"), stun_port: 3478 };
        let two = RelayInfo { region_id: base + 1, hostname: "old-name.example.com".into(), stun_port: 0 };
        s.relay_heartbeat(&one).await.unwrap();
        s.relay_heartbeat(&two).await.unwrap();
        let renamed = RelayInfo { hostname: "new-name.example.com".into(), ..two.clone() };
        s.relay_heartbeat(&renamed).await.unwrap();
        let mine: Vec<_> = s.list_relays(60).await.into_iter().filter(|r| r.region_id == base || r.region_id == base + 1).collect();
        assert_eq!(mine, vec![one.clone(), renamed], "{}", b.name);
        assert!(s.list_relays(-1).await.iter().all(|r| r.region_id != base), "a stale relay is not listed ({})", b.name);

        let t = tenant(s, "home-relay").await;
        let mk = rand_bytes::<32>();
        let (node, _, _) = s.register_node_with(t, mk, info("homer", mk), NodeRegistration::default()).await.unwrap();
        let mk2 = rand_bytes::<32>();
        let (other, _, _) = s.register_node_with(t, mk2, info("no-home", mk2), NodeRegistration::default()).await.unwrap();
        assert!(s.home_relays(&[node, other]).await.is_empty(), "{}", b.name);
        let mut rx = s.subscribe();
        assert!(s.set_home_relay(node, 7).await.unwrap(), "{}", b.name);
        assert!(!s.set_home_relay(node, 7).await.unwrap(), "the same region again is not a change ({})", b.name);
        assert!(s.set_home_relay(node, 9).await.unwrap(), "{}", b.name);
        assert_eq!(s.home_relays(&[node, other]).await, std::collections::HashMap::from([(node, 9)]), "{}", b.name);
        let mut updates = 0;
        while let Ok(ev) = rx.try_recv() {
            if matches!(ev, PeerEvent::NodeUpdated { node_id, .. } if node_id == node) {
                updates += 1;
            }
        }
        assert_eq!(updates, 2, "peers hear about each change once ({})", b.name);
    }
}

#[tokio::test]
async fn sqlite_hashes_plain_keys_stored_before_the_migration() {
    let path = std::env::temp_dir().join(format!("coord-keymig-{}.db", hex::encode(rand_bytes::<8>())));
    let _cleanup = TempDb(path.clone());
    let pool = coord_store::create_sqlite_pool(path.to_str().unwrap()).await.unwrap();
    let store = Store::Sqlite(coord_store::SqliteStore::new(pool.clone()).await.unwrap());
    let t = tenant(&store, "legacy").await;
    // A row as an older version wrote it: the key in plain text, no prefix
    let plain = format!("tskey-auth-{}", hex::encode(rand_bytes::<32>()));
    sqlx::query("INSERT INTO coord_preauth_keys (key, id, tenant_id, reusable, key_prefix) VALUES (?1, ?2, ?3, 1, '')")
        .bind(&plain)
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(t.as_uuid().to_string())
        .execute(&pool)
        .await
        .unwrap();
    // Opening the store again finishes the migration
    let store = Store::Sqlite(coord_store::SqliteStore::new(pool.clone()).await.unwrap());
    let (key, prefix): (String, String) = sqlx::query_as("SELECT key, key_prefix FROM coord_preauth_keys WHERE tenant_id = ?1")
        .bind(t.as_uuid().to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(key, coord_store::hash_preauth_key(&plain));
    assert_eq!(prefix, coord_core::preauth_key_prefix(&plain));
    assert_eq!(store.list_preauth_keys(t).await[0].prefix, prefix);
    assert!(store.validate_preauth_key(&plain).await.is_some(), "the old key keeps working");
}

async fn reg(s: &Store, t: TenantId, name: &str) -> (coord_core::NodeId, [u8; 32]) {
    let mk = rand_bytes::<32>();
    (s.register_node(t, mk, info(name, mk)).await.unwrap().0, mk)
}

async fn hostname_of(s: &Store, id: coord_core::NodeId) -> String {
    s.get_node_info(id).await.unwrap().info.hostname
}

#[tokio::test]
async fn device_names_are_unique_per_tenant() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "names").await;
        let other = tenant(s, "names-other").await;

        let (a, a_mk) = reg(s, t, "laptop").await;
        let (bb, _) = reg(s, t, "laptop").await;
        let (c, _) = reg(s, t, "Laptop").await;
        let (elsewhere, _) = reg(s, other, "laptop").await;
        assert_eq!(hostname_of(s, a).await, "laptop", "{}: the first keeps its name", b.name);
        assert_eq!(hostname_of(s, bb).await, "laptop-1", "{}", b.name);
        assert_eq!(hostname_of(s, c).await, "laptop-2", "{}: names compare as DNS labels", b.name);
        assert_eq!(hostname_of(s, elsewhere).await, "laptop", "{}: another tenant is separate", b.name);

        // Re-registering keeps a node's own name; the others stay stable
        s.register_node(t, a_mk, info("laptop", a_mk)).await.unwrap();
        assert_eq!(hostname_of(s, a).await, "laptop", "{}", b.name);
        assert_eq!(hostname_of(s, bb).await, "laptop-1", "{}", b.name);

        // A freed suffix is reused lowest-first
        s.delete_node(bb).await.unwrap();
        let (d, _) = reg(s, t, "laptop").await;
        assert_eq!(hostname_of(s, d).await, "laptop-1", "{}", b.name);

        // Renames follow the same rule
        s.rename_node(c, "laptop".into()).await.unwrap();
        assert_eq!(hostname_of(s, c).await, "laptop-2", "{}", b.name);
        s.rename_node(c, "desk".into()).await.unwrap();
        assert_eq!(hostname_of(s, c).await, "desk", "{}", b.name);
        s.rename_node(d, "desk".into()).await.unwrap();
        assert_eq!(hostname_of(s, d).await, "desk-1", "{}", b.name);

        // Only the gateway node gets the gateway's name
        let (squatter, _) = reg(s, t, "gateway").await;
        assert_eq!(hostname_of(s, squatter).await, "gateway-1", "{}", b.name);
        let gw_mk = rand_bytes::<32>();
        let gw_reg = NodeRegistration { tags: vec![coord_core::GATEWAY_TAG.into()], ..Default::default() };
        let (gw, _, _) = s.register_node_with(t, gw_mk, info("gateway", gw_mk), gw_reg.clone()).await.unwrap();
        assert_eq!(hostname_of(s, gw).await, "gateway", "{}", b.name);
        s.register_node_with(t, gw_mk, info("gateway", gw_mk), gw_reg).await.unwrap();
        assert_eq!(hostname_of(s, gw).await, "gateway", "{}: the gateway keeps it on restart", b.name);
        s.rename_node(squatter, "gateway".into()).await.unwrap();
        assert_eq!(hostname_of(s, squatter).await, "gateway-1", "{}", b.name);

        // Concurrent registrations with one name all get different names
        let handles: Vec<_> = (0..12)
            .map(|_| {
                let s = b.store.clone();
                tokio::spawn(async move {
                    let mk = rand_bytes::<32>();
                    s.register_node(t, mk, info("phone", mk)).await.unwrap().0
                })
            })
            .collect();
        let mut names = std::collections::HashSet::new();
        for h in handles {
            let id = h.await.unwrap();
            assert!(names.insert(hostname_of(s, id).await), "{}: concurrent registrations got the same name", b.name);
        }
        assert!(names.contains("phone") && names.contains("phone-11"), "{}: {names:?}", b.name);

        for t in [t, other] {
            for n in s.list_nodes_for_tenant(t).await {
                s.delete_node(n.id).await.unwrap();
            }
        }
    }
}

#[tokio::test]
async fn tenant_parent_can_be_set_moved_and_cleared() {
    use coord_core::CoordError;
    for b in backends().await {
        let s = &b.store;
        let p1 = tenant(s, "par1").await;
        let p2 = tenant(s, "par2").await;
        let child = tenant(s, "kid").await;
        let grandchild = tenant(s, "grandkid").await;

        let (t, old) = s.set_tenant_parent(child, Some(p1)).await.unwrap();
        assert_eq!((t.parent_id, old), (Some(p1), None), "{}", b.name);
        assert_eq!(s.get_tenant(child).await.unwrap().parent_id, Some(p1), "{}", b.name);
        assert_eq!(s.get_child_tenants(p1).await.len(), 1, "{}", b.name);

        let (_, old) = s.set_tenant_parent(child, Some(p2)).await.unwrap();
        assert_eq!(old, Some(p1), "{}: the previous parent is reported", b.name);
        assert!(s.get_child_tenants(p1).await.is_empty(), "{}", b.name);

        // Refused: itself, a descendant, a second level, missing tenants
        assert!(matches!(s.set_tenant_parent(child, Some(child)).await, Err(CoordError::Protocol(_))), "{}", b.name);
        assert!(matches!(s.set_tenant_parent(p2, Some(child)).await, Err(CoordError::Protocol(_))), "{}: a descendant", b.name);
        assert!(matches!(s.set_tenant_parent(grandchild, Some(child)).await, Err(CoordError::Protocol(_))), "{}: parent is a child", b.name);
        assert!(matches!(s.set_tenant_parent(p2, Some(p1)).await, Err(CoordError::Protocol(_))), "{}: p2 has children", b.name);
        let ghost = TenantId::generate();
        assert!(matches!(s.set_tenant_parent(child, Some(ghost)).await, Err(CoordError::TenantNotFound(g)) if g == ghost), "{}", b.name);
        assert!(matches!(s.set_tenant_parent(ghost, None).await, Err(CoordError::TenantNotFound(g)) if g == ghost), "{}", b.name);
        assert_eq!(s.get_tenant(child).await.unwrap().parent_id, Some(p2), "{}: refusals change nothing", b.name);

        let (t, old) = s.set_tenant_parent(child, None).await.unwrap();
        assert_eq!((t.parent_id, old), (None, Some(p2)), "{}", b.name);
        assert_eq!(s.get_tenant(child).await.unwrap().parent_id, None, "{}", b.name);

        // Two tenants made each other's parent at once: at most one wins
        let x = tenant(s, "x").await;
        let y = tenant(s, "y").await;
        let (s1, s2) = (b.store.clone(), b.store.clone());
        let (r1, r2) = tokio::join!(
            tokio::spawn(async move { s1.set_tenant_parent(x, Some(y)).await.is_ok() }),
            tokio::spawn(async move { s2.set_tenant_parent(y, Some(x)).await.is_ok() }),
        );
        assert!(!(r1.unwrap() && r2.unwrap()), "{}: a parent cycle was created", b.name);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn create_with_parent_races_parent_change_without_second_level() {
    for b in backends().await {
        for round in 0..20 {
            let x = tenant(&b.store, "rx").await;
            let y = tenant(&b.store, "ry").await;
            let (s1, s2) = (b.store.clone(), b.store.clone());
            let slug = unique("rkid");
            let (created, moved) = tokio::join!(
                tokio::spawn(async move { s1.create_tenant(slug, Some(x), None).await.is_ok() }),
                tokio::spawn(async move { s2.set_tenant_parent(x, Some(y)).await.is_ok() }),
            );
            let (created, moved) = (created.unwrap(), moved.unwrap());
            assert!(created || moved, "{} round {round}: one side must win", b.name);
            assert!(!(created && moved), "{} round {round}: both won, so a second level exists", b.name);

            // Only this round's tenants: a shared PostgreSQL database holds rows of other runs.
            let tenants = b.store.list_tenants().await;
            let ours = [x, y];
            let parent_of = |id: TenantId| tenants.iter().find(|t| t.id == id).and_then(|t| t.parent_id);
            for t in tenants.iter().filter(|t| ours.contains(&t.id) || t.parent_id.is_some_and(|p| ours.contains(&p))) {
                if let Some(p) = t.parent_id {
                    assert_ne!(p, t.id, "{}: a tenant is its own parent", b.name);
                    assert_eq!(parent_of(p), None, "{} round {round}: {} sits two levels deep", b.name, t.slug);
                }
            }
        }
    }
}

#[tokio::test]
async fn a_gateway_offer_is_one_row_per_tenant_and_goes_with_the_tenant() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "gw-offer").await;
        assert_eq!(s.get_gateway_offer(t).await, None, "{}", b.name);
        let first = coord_core::GatewayOffer { node_key: [1; 32], machine_key: [2; 32], disco_key: [3; 32], region_id: 1, endpoints: vec![] };
        s.offer_gateway(t, &first).await.unwrap();
        assert_eq!(s.get_gateway_offer(t).await, Some(first), "{}", b.name);
        let endpoints = vec!["203.0.113.7:41641".parse().unwrap(), "[2001:db8::7]:41641".parse().unwrap()];
        let second = coord_core::GatewayOffer { node_key: [4; 32], machine_key: [5; 32], disco_key: [6; 32], region_id: 7, endpoints };
        s.offer_gateway(t, &second).await.unwrap();
        assert_eq!(s.get_gateway_offer(t).await, Some(second.clone()), "{}: a new offer replaces the old one", b.name);
        let many = coord_core::GatewayOffer { endpoints: (1..=20u16).map(|p| std::net::SocketAddr::from(([203, 0, 113, 7], p))).collect(), ..second.clone() };
        s.offer_gateway(t, &many).await.unwrap();
        let kept = s.get_gateway_offer(t).await.unwrap().endpoints;
        assert_eq!(kept, many.endpoints[..coord_core::MAX_GATEWAY_ENDPOINTS], "{}: an offer keeps a bounded number of endpoints", b.name);
        s.offer_gateway(t, &second).await.unwrap();

        let missing = coord_core::TenantId::new(uuid::Uuid::new_v4());
        assert!(s.offer_gateway(missing, &second).await.is_err(), "{}: no offer for an unknown tenant", b.name);
        s.delete_tenant(t).await.unwrap();
        assert_eq!(s.get_gateway_offer(t).await, None, "{}", b.name);
    }
}
