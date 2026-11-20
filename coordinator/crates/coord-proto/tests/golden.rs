//! Golden JSON: the field names on the wire must be Tailscale's (tailcfg).
//! Each golden document uses tailcfg's exact names; it must decode into our
//! types and encode back to the same document, so a renamed or mis-cased
//! field fails here instead of in a real client.

use coord_proto::map::{FilterRule, MapNode, NetPortRange, PortRange};
use coord_proto::{MapRequest, MapResponse, RegisterRequest, RegisterResponse};
use serde_json::{json, Value};

fn round_trip<T: serde::de::DeserializeOwned + serde::Serialize>(golden: Value) {
    let decoded: T = serde_json::from_value(golden.clone()).expect("golden JSON decodes");
    assert_eq!(serde_json::to_value(&decoded).unwrap(), golden);
}

fn keys(v: &Value) -> Vec<&str> {
    let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    k.sort();
    k
}

#[test]
fn register_request_uses_tailcfg_names() {
    let golden = json!({
        "Version": 106,
        "NodeKey": "nodekey:0101010101010101010101010101010101010101010101010101010101010101",
        "OldNodeKey": "nodekey:0202020202020202020202020202020202020202020202020202020202020202",
        "Auth": { "AuthKey": "tskey-auth-x" },
        "Hostinfo": {
            "Hostname": "laptop",
            "OS": "linux",
            "IPNVersion": "1.80.0",
            "BackendLogID": "abc",
            "RequestTags": ["tag:server"],
            "RoutableIPs": ["10.0.0.0/24", "0.0.0.0/0"],
            "NetInfo": { "PreferredDERP": 1 }
        },
        "Followup": "https://dash.example/device/0123456789abcdef0123456789abcdef",
        "Ephemeral": false,
        "Timestamp": "2026-11-20T12:00:00Z"
    });
    round_trip::<RegisterRequest>(golden);
}

#[test]
fn register_response_uses_tailcfg_names() {
    let golden = json!({
        "User": { "ID": 42, "DisplayName": "Alice" },
        "Login": { "ID": 42, "Provider": "atproto", "LoginName": "alice.bsky.social", "DisplayName": "Alice" },
        "NodeKeyExpired": false,
        "MachineAuthorized": true,
        "AuthURL": "https://dash.example/device/0123",
        "Error": ""
    });
    round_trip::<RegisterResponse>(golden.clone());
    assert_eq!(keys(&golden), ["AuthURL", "Error", "Login", "MachineAuthorized", "NodeKeyExpired", "User"]);
}

#[test]
fn map_request_uses_tailcfg_names() {
    let req: MapRequest = serde_json::from_value(json!({
        "Version": 106,
        "NodeKey": "nodekey:01",
        "DiscoKey": "discokey:02",
        "Endpoints": ["192.0.2.1:41641"],
        "Stream": true,
        "Compress": "zstd",
        "KeepAlive": true,
        "OmitPeers": false,
        "ReadOnly": false,
        "Hostinfo": { "Hostname": "laptop", "OS": "linux", "NetInfo": { "PreferredDERP": 3 } }
    }))
    .unwrap();
    assert_eq!(req.disco_key.as_deref(), Some("discokey:02"));
    assert_eq!(req.endpoints.as_deref(), Some(&["192.0.2.1:41641".to_string()][..]));
    assert_eq!((req.stream, req.keep_alive, req.omit_peers, req.read_only), (Some(true), Some(true), Some(false), Some(false)));
    assert_eq!(req.compress.as_deref(), Some("zstd"));
    assert_eq!(req.hostinfo.unwrap().net_info.unwrap().preferred_derp, 3);
    let back = serde_json::to_value(serde_json::from_value::<MapRequest>(json!({ "Version": 1, "NodeKey": "k", "Stream": true })).unwrap()).unwrap();
    assert_eq!(back["Stream"], true);
    assert_eq!(back["NodeKey"], "k");
}

fn node() -> MapNode {
    MapNode {
        id: 7,
        stable_id: "n7".into(),
        name: "router.example.ts.net.".into(),
        user: 42,
        key: "nodekey:07".into(),
        machine: "mkey:07".into(),
        disco_key: Some("discokey:07".into()),
        addresses: vec!["100.64.0.7/32".into()],
        allowed_ips: vec!["100.64.0.7/32".into(), "10.0.0.0/24".into()],
        primary_routes: vec!["10.0.0.0/24".into()],
        endpoints: vec!["192.0.2.7:41641".into()],
        derp: Some("127.3.3.40:1".into()),
        home_derp: Some(1),
        hostinfo: None,
        online: Some(true),
        last_seen: None,
        machine_authorized: Some(true),
        key_expiry: None,
    }
}

#[test]
fn map_node_uses_tailcfg_names() {
    let v = serde_json::to_value(node()).unwrap();
    for (k, want) in [
        ("ID", json!(7)),
        ("StableID", json!("n7")),
        ("Name", json!("router.example.ts.net.")),
        ("User", json!(42)),
        ("Key", json!("nodekey:07")),
        ("Machine", json!("mkey:07")),
        ("DiscoKey", json!("discokey:07")),
        ("Addresses", json!(["100.64.0.7/32"])),
        ("AllowedIPs", json!(["100.64.0.7/32", "10.0.0.0/24"])),
        ("PrimaryRoutes", json!(["10.0.0.0/24"])),
        ("Endpoints", json!(["192.0.2.7:41641"])),
        ("DERP", json!("127.3.3.40:1")),
        ("HomeDERP", json!(1)),
        ("Online", json!(true)),
        ("MachineAuthorized", json!(true)),
    ] {
        assert_eq!(v[k], want, "field {k}");
    }
}

#[test]
fn map_response_uses_tailcfg_names() {
    let resp = MapResponse {
        node: Some(node()),
        peers: Some(vec![node()]),
        peers_changed: Some(vec![node()]),
        peers_removed: Some(vec![3, 4]),
        packet_filter: Some(vec![FilterRule {
            src_ips: vec!["100.64.0.1".into()],
            dst_ports: vec![NetPortRange { ip: "100.64.0.7".into(), ports: PortRange { first: 22, last: 22 } }],
            ip_proto: Some(vec![6]),
        }]),
        domain: Some("example.ts.net".into()),
        keep_alive: Some(true),
        control_time: Some("2026-11-20T12:00:00Z".into()),
        ..Default::default()
    };
    let v = serde_json::to_value(&resp).unwrap();
    for k in ["Node", "Peers", "PeersChanged", "PeersRemoved", "PacketFilter", "Domain", "KeepAlive", "ControlTime"] {
        assert!(v.get(k).is_some(), "missing {k} in {v}");
    }
    assert_eq!(v["PeersRemoved"], json!([3, 4]));
    assert_eq!(
        v["PacketFilter"],
        json!([{ "SrcIPs": ["100.64.0.1"], "DstPorts": [{ "IP": "100.64.0.7", "Ports": { "First": 22, "Last": 22 } }], "IPProto": [6] }])
    );
    assert_eq!(v["Node"]["PrimaryRoutes"], json!(["10.0.0.0/24"]));
    // A Hostinfo that advertises routes keeps tailcfg's name for them
    let mut n = node();
    n.hostinfo = serde_json::from_value(json!({ "Hostname": "router", "RoutableIPs": ["10.0.0.0/24"] })).unwrap();
    assert_eq!(serde_json::to_value(n).unwrap()["Hostinfo"]["RoutableIPs"], json!(["10.0.0.0/24"]));
    // And the response decodes back
    let back: MapResponse = serde_json::from_value(v).unwrap();
    assert_eq!(back.peers_removed, Some(vec![3, 4]));
    assert_eq!(back.packet_filter.unwrap()[0].dst_ports[0].ports.last, 22);
}

#[test]
fn an_empty_packet_filter_is_sent_as_an_empty_list() {
    // tailscaled treats a missing PacketFilter as "unchanged" and [] as "deny all"
    let v = serde_json::to_value(MapResponse { packet_filter: Some(vec![]), ..Default::default() }).unwrap();
    assert_eq!(v["PacketFilter"], json!([]));
}
