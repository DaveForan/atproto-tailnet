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

        // Re-register with the same grant identity keeps approvals; replaces
        // advertised routes when given.
        let same = NodeRegistration {
            owner: Some("alice".into()),
            tags: strs(&["tag:relay"]),
            ephemeral: true,
            advertised_routes: None,
        };
        s.register_node_with(t, mk, info("router", mk), same).await.unwrap();
        let d = s.get_node_info(n1).await.unwrap();
        assert_eq!(d.attrs.approved_routes, strs(&["0.0.0.0/0", "10.0.0.0/24"]), "{}", b.name);
        assert_eq!(d.attrs.advertised_routes, strs(&["0.0.0.0/0"]), "{}", b.name);

        // Re-register with a different grant (re-auth with a new key) replaces
        // owner/tags/ephemeral and drops approvals granted to the old identity.
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
            if let PeerEvent::NodeOffline { node_id, tenant_id } = ev {
                if tenant_id == t {
                    offline.push(node_id);
                }
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

        // Non-consuming key lookup used to refuse registration before validation.
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
            s.delete_stale_ephemeral_nodes(chrono::Duration::zero()).await.unwrap();
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
        };
        s.set_tenant_access(t, access.clone()).await.unwrap();
        assert_eq!(s.get_tenant_access(t).await, access, "{}", b.name);

        // Replaced, not merged
        s.set_tenant_access(t, TenantAccess { mode: AccessMode::Member, rules: vec![] }).await.unwrap();
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
            records: vec![DnsRecord { name: "notes".into(), node: 4, owner: Some("alice".into()), nodes: vec![7] }],
        };
        s.set_tenant_dns(t, dns.clone()).await.unwrap();
        assert_eq!(s.get_tenant_dns(t).await, dns, "{}", b.name);
        assert!(s.set_tenant_dns(TenantId::new(uuid::Uuid::new_v4()), TenantDns::default()).await.is_err(), "{}", b.name);
    }
}

#[tokio::test]
async fn owner_lock_round_trip_and_removal() {
    use coord_core::OwnerLock;
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "lock").await;
        assert_eq!(s.get_owner_lock(t, "alice").await, None, "{}", b.name);
        let lock = OwnerLock { machines: vec!["ab".repeat(32)], allow_one_until: Some(chrono::Utc::now()), refused: vec![] };
        s.set_owner_lock(t, "alice", Some(lock.clone())).await.unwrap();
        let got = s.get_owner_lock(t, "alice").await.unwrap();
        assert_eq!(got.machines, lock.machines, "{}", b.name);
        assert!(got.allow_one_until.is_some(), "{}", b.name);
        assert_eq!(s.get_owner_lock(t, "bob").await, None, "locks are per owner ({})", b.name);
        s.set_owner_lock(t, "alice", None).await.unwrap();
        assert_eq!(s.get_owner_lock(t, "alice").await, None, "{}", b.name);
    }
}

#[tokio::test]
async fn tenant_config_round_trip_list_and_removal() {
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "cfg").await;
        assert!(s.get_tenant_configs(t).await.is_empty(), "{}", b.name);
        s.set_tenant_config(t, "acl", Some(serde_json::json!({"rules": [1, 2]}))).await.unwrap();
        s.set_tenant_config(t, "identity", Some(serde_json::json!({"tailnet_name": "x"}))).await.unwrap();
        s.set_tenant_config(t, "acl", Some(serde_json::json!({"rules": [3]}))).await.unwrap();
        let mut got = s.get_tenant_configs(t).await;
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(got, vec![
            ("acl".to_string(), serde_json::json!({"rules": [3]})),
            ("identity".to_string(), serde_json::json!({"tailnet_name": "x"})),
        ], "{}", b.name);
        assert!(s.list_tenant_configs().await.iter().any(|(tid, k, _)| *tid == t && k == "acl"), "{}", b.name);
        s.set_tenant_config(t, "acl", None).await.unwrap();
        assert_eq!(s.get_tenant_configs(t).await.len(), 1, "{}", b.name);
        s.delete_tenant(t).await.unwrap();
        assert!(s.get_tenant_configs(t).await.is_empty(), "config goes with the tenant ({})", b.name);
    }
}

#[tokio::test]
async fn sign_in_is_decided_once_and_taken_once() {
    use coord_core::SignInDecision;
    for b in backends().await {
        let s = &b.store;
        let t = tenant(s, "signin").await;
        let key = [7u8; 32];
        let id = format!("{}-first", b.name);
        s.sign_in_start(&id, &key, "phone", "iOS").await.unwrap();
        let p = s.sign_in_get(&id).await.unwrap();
        assert_eq!((p.machine_key, p.hostname.as_str(), p.decision), (key, "phone", None), "{}", b.name);
        assert_eq!(s.sign_in_take(&id).await, None, "a pending sign-in cannot be taken ({})", b.name);

        // A new sign-in of the same machine replaces the old one
        let id2 = format!("{}-second", b.name);
        s.sign_in_start(&id2, &key, "phone", "iOS").await.unwrap();
        assert!(s.sign_in_get(&id).await.is_none(), "{}", b.name);

        let yes = SignInDecision::Approved { tenant_id: t, owner: "alice".into() };
        assert!(s.sign_in_decide(&id2, &yes).await, "{}", b.name);
        assert!(!s.sign_in_decide(&id2, &SignInDecision::Denied).await, "decided once ({})", b.name);
        assert!(!s.sign_in_decide("unknown", &yes).await, "{}", b.name);
        assert_eq!(s.sign_in_get(&id2).await.unwrap().decision, Some(yes.clone()), "{}", b.name);
        assert_eq!(s.sign_in_take(&id2).await, Some(yes), "{}", b.name);
        assert_eq!(s.sign_in_take(&id2).await, None, "taken once ({})", b.name);
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
