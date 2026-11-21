use std::sync::Arc;
use tracing::{info, warn};

use coord_core::{sanitize, NodeId, NodeInfo, NodeRegistration, TenantId};
use coord_proto::register::{RegisterRequest, RegisterResponse, User, Login};
use coord_proto::map::MapRequest;
use coord_store::PeerEvent;

use crate::state::CoordinatorState;

/// `client_ip` is the address the Noise connection came from (see
/// `client_ip::TrustedProxies`); it is only recorded on a new interactive
/// sign-in, for the approval page.
pub async fn handle_register(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    body: &str,
    client_ip: Option<std::net::IpAddr>,
) -> Result<(String, Option<u64>), Box<dyn std::error::Error + Send + Sync>> {
    let req: RegisterRequest = serde_json::from_str(body)?;

    let auth_key = req
        .auth
        .as_ref()
        .and_then(|a| a.auth_key.as_deref());

    let node_key_bytes = coord_core::keys::parse_node_key(&req.node_key)?;
    let advertised = advertised_routes_from(req.hostinfo.as_ref());

    // A known machine re-registering with its current (or rotated-from) node key
    // is already authorized; tailscaled does this on every restart without an auth key.
    let mut known_tenant = None;
    if let Some(existing) = state.store.get_node_by_machine_key(machine_key).await {
        if let Some(detail) = state.store.get_node_info(existing).await {
            known_tenant = Some(detail.tenant_id);
            let old_key = req
                .old_node_key
                .as_deref()
                .and_then(|k| coord_core::keys::parse_node_key(k).ok())
                .filter(|k| *k != [0u8; 32]);
            // A suspended tenant's machine may not re-authorize itself. With an auth
            // key it falls through to the key path (which checks that key's tenant).
            if auth_key.is_none() && state.store.is_tenant_suspended(detail.tenant_id).await {
                info!(node_id = existing.as_i64(), "re-register refused: tenant suspended");
                return Ok((serde_json::to_string(&error_response(TENANT_SUSPENDED_MSG))?, None));
            }
            let suspended = state.store.is_tenant_suspended(detail.tenant_id).await;
            let current = detail.info.node_key.as_slice();
            // Same node key: nothing to re-authorize. An auth key sent alongside
            // (tailscaled re-sends its configured --authkey / TS_AUTHKEY on restart)
            // is deliberately ignored and NOT consumed — burning a single-use key
            // here would change nothing and break the key's next legitimate use.
            // A real re-auth (`tailscale up --force-reauth`) generates a new node
            // key and takes the key path below.
            let identity_resp = authorized_response(state, detail.tenant_id, detail.attrs.owner.as_deref());
            let same_key = !suspended && current == node_key_bytes.as_slice();
            // Key rotation without an auth key keeps the node's identity. With an
            // auth key the machine is re-authenticating: fall through so the new
            // key's owner/tags/ephemeral replace the old ones (the key path
            // checks the machine lock of the key's owner).
            let rotation = old_key.filter(|k| auth_key.is_none() && !suspended && current == k.as_slice());
            if same_key || rotation.is_some() {
                // ADR-0035 §2: a locked owner's machine outside the lock is refused
                // also when it was registered before (a node that survived the lock
                // being set, or one whose machine was taken out of the set).
                if let Err(resp) = enforce_owner_lock(
                    state,
                    detail.tenant_id,
                    detail.attrs.owner.as_deref(),
                    machine_key,
                    &detail.info.hostname,
                    &detail.info.os,
                )
                .await
                {
                    return Ok((serde_json::to_string(&resp)?, None));
                }
            }
            if same_key {
                sync_node_routes(state, existing, advertised).await;
                return Ok((serde_json::to_string(&identity_resp)?, None));
            }
            if let Some(old) = rotation {
                state.store.rotate_node_key(machine_key, &old, &node_key_bytes).await?;
                info!(node_id = existing.as_i64(), "node key rotated on re-register");
                sync_node_routes(state, existing, advertised).await;
                return Ok((serde_json::to_string(&identity_resp)?, None));
            }
        }
    }

    // Check suspension (and tenant mismatch) before validating so a single-use
    // key isn't consumed by a registration that is going to be refused.
    if let Some(key) = auth_key {
        if let Some(tid) = state.store.preauth_key_tenant(key).await {
            if state.store.is_tenant_suspended(tid).await {
                info!(tenant = %tid, "register refused: tenant suspended");
                return Ok((serde_json::to_string(&error_response(TENANT_SUSPENDED_MSG))?, None));
            }
            if known_tenant.is_some_and(|known| known != tid) {
                info!(tenant = %tid, "register refused: machine belongs to another tailnet");
                return Ok((serde_json::to_string(&error_response("this machine is registered to a different tailnet"))?, None));
            }
        }
    }

    let grant = match auth_key {
        Some(key) => match state.store.validate_preauth_key(key).await {
            Some(grant) => grant,
            None => {
                // Never log the key or its start: only a short tag of its hash.
                warn!(auth_key_hash = %coord_store::preauth_key_log_id(key), "invalid pre-auth key");
                return Ok((serde_json::to_string(&error_response("invalid or expired pre-auth key"))?, None));
            }
        },
        // No key: interactive sign-in (ADR-0032)
        None => match interactive_sign_in(state, machine_key, &req, known_tenant, client_ip).await {
            Ok(grant) => grant,
            Err(resp) => return Ok((serde_json::to_string(&resp)?, None)),
        },
    };

    if let Some(ref old_key_str) = req.old_node_key {
        if let Ok(old_key) = coord_core::keys::parse_node_key(old_key_str) {
            if old_key != [0u8; 32] {
                if let Err(e) = state.store.rotate_node_key(machine_key, &old_key, &node_key_bytes).await {
                    tracing::warn!(error = %e, "rotate_node_key failed");
                }
                info!(
                    old_key = hex::encode(&old_key[..8]),
                    new_key = hex::encode(&node_key_bytes[..8]),
                    "node key rotated"
                );
            }
        }
    }

    // Client-supplied hostname, reduced to one DNS label (never a dotted name
    // that could spoof another node's FQDN). Unusable names become node-<id>.
    let hostname = req
        .hostinfo
        .as_ref()
        .and_then(|h| h.hostname.as_deref())
        .and_then(sanitize::dns_label);
    let node_info = NodeInfo {
        node_key: node_key_bytes.to_vec(),
        machine_key: machine_key.to_vec(),
        disco_key: None,
        endpoints: vec![],
        hostname: hostname.clone().unwrap_or_else(|| HOSTNAME_PLACEHOLDER.into()),
        os: sanitize::os(req.hostinfo.as_ref().and_then(|h| h.os.as_deref())),
        ipv4: None,
        ipv6: None,
    };

    let tenant_id = grant.tenant_id;
    let owner = grant.owner.clone();

    // Machine lock (ADR-0035): an owner locked to a set of machines cannot add
    // another one, whatever credential it presents.
    if let Err(resp) = enforce_owner_lock(state, tenant_id, owner.as_deref(), machine_key, &node_info.hostname, &node_info.os).await {
        return Ok((serde_json::to_string(&resp)?, None));
    }
    let registration = NodeRegistration {
        owner: grant.owner,
        tags: grant.tags,
        ephemeral: grant.ephemeral,
        advertised_routes: advertised,
    };
    let (node_id, ipv4, generation) = state
        .store
        .register_node_with(tenant_id, *machine_key, node_info, registration)
        .await?;
    if hostname.is_none() {
        let fallback = sanitize::node_dns_label("", node_id.as_i64());
        if let Err(e) = state.store.rename_node(node_id, fallback).await {
            warn!(error = %e, node_id = node_id.as_i64(), "fallback hostname failed");
        }
    }
    // Advertised routes were stored with the node; apply auto-approvers now
    // (re-evaluated against the new key's tags on re-auth; the store already
    // dropped approvals if owner/tags changed).
    sync_node_routes(state, node_id, None).await;
    if known_tenant.is_some() {
        // Re-auth may have changed tags/owner, which feed ACLs and auto-approval;
        // the node's own stream ignores its own events, so push fresh snapshots.
        state.notify_tenant_changed(tenant_id);
    }

    info!(
        node_id = node_id.as_i64(),
        ipv4 = %ipv4,
        hostname = hostname.as_deref().unwrap_or(HOSTNAME_PLACEHOLDER),
        reauth = known_tenant.is_some(),
        "node registered"
    );

    let resp = authorized_response(state, tenant_id, owner.as_deref());
    Ok((serde_json::to_string(&resp)?, Some(generation)))
}

/// Apply the owner's machine lock (ADR-0035 §2) to a registering machine, in
/// one atomic store step (the "allow one" window admits exactly one machine,
/// and a refusal is recorded). Fails closed: a store error or a malformed lock
/// refuses the registration with a clean error.
async fn enforce_owner_lock(
    state: &Arc<CoordinatorState>,
    tenant_id: TenantId,
    owner: Option<&str>,
    machine_key: &[u8; 32],
    hostname: &str,
    os: &str,
) -> Result<(), RegisterResponse> {
    let Some(owner) = owner else {
        return Ok(());
    };
    let fingerprint = crate::device_auth::fingerprint(machine_key);
    match state.store.check_owner_lock(tenant_id, owner, machine_key, hostname, os, &fingerprint).await {
        Ok(None) | Ok(Some(coord_core::LockOutcome::Allowed)) => Ok(()),
        Ok(Some(coord_core::LockOutcome::AllowedNew)) => {
            info!(tenant = %tenant_id, "new machine admitted by the machine lock's window");
            Ok(())
        }
        Ok(Some(coord_core::LockOutcome::Refused)) => {
            warn!(tenant = %tenant_id, "register refused: owner is locked to other machines");
            Err(error_response(MACHINE_LOCKED_MSG))
        }
        Err(e) => {
            tracing::error!(tenant = %tenant_id, error = %e, "register refused: machine lock could not be checked");
            Err(error_response(LOCK_UNAVAILABLE_MSG))
        }
    }
}

/// Interactive sign-in: the device gets a URL, the user approves it on the
/// dashboard, and the device's follow-up request then receives the grant.
/// `Err` carries the response to send while there is no grant yet.
async fn interactive_sign_in(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    req: &RegisterRequest,
    known_tenant: Option<TenantId>,
    client_ip: Option<std::net::IpAddr>,
) -> Result<coord_core::PreAuthGrant, RegisterResponse> {
    use crate::device_auth::{self, Decision};
    let Some(base) = state.device_auth_url.as_deref() else {
        return Err(error_response("this server needs an auth key: run `tailscale up --authkey <key>`"));
    };
    let sign_in_url = |id: &str| RegisterResponse {
        user: User::default(),
        login: Login::default(),
        node_key_expired: false,
        machine_authorized: false,
        auth_url: format!("{}/{}", base.trim_end_matches('/'), id),
        error: String::new(),
    };

    if let Some(id) = req.followup.as_deref().and_then(device_auth::id_from_url) {
        match state.device_auth.wait(&state.store, id, machine_key, state.device_auth_wait).await {
            Some(Decision::Approved { tenant_id, owner }) => {
                if state.store.is_tenant_suspended(tenant_id).await {
                    return Err(error_response(TENANT_SUSPENDED_MSG));
                }
                if known_tenant.is_some_and(|known| known != tenant_id) {
                    return Err(error_response("this machine is registered to a different tailnet"));
                }
                info!(tenant = %tenant_id, "device sign-in approved");
                return Ok(coord_core::PreAuthGrant { tenant_id, owner: Some(owner), tags: vec![], ephemeral: false });
            }
            // Still waiting: the device asks again with the same URL
            Some(Decision::Pending) => return Err(sign_in_url(id)),
            Some(Decision::Denied) => return Err(error_response("device sign-in was refused")),
            // Unknown or expired: start again below
            None => {}
        }
    }

    let hostinfo = req.hostinfo.as_ref();
    let hostname = hostinfo
        .and_then(|h| h.hostname.as_deref())
        .and_then(sanitize::dns_label)
        .unwrap_or_else(|| HOSTNAME_PLACEHOLDER.into());
    let os = sanitize::os(hostinfo.and_then(|h| h.os.as_deref()));
    match state.device_auth.start(&state.store, *machine_key, &hostname, &os, client_ip, state.sign_in_limits).await {
        Ok(id) => Err(sign_in_url(&id)),
        Err(device_auth::StartError::TooManyFromAddress) => Err(error_response(SIGN_INS_FROM_ADDRESS_MSG)),
        Err(device_auth::StartError::Full) => Err(error_response(SIGN_INS_FULL_MSG)),
        Err(device_auth::StartError::Unavailable) => Err(error_response("sign-in is not available right now; try again")),
    }
}

/// Stored briefly when a client sends no usable hostname; replaced by node-<id>.
const HOSTNAME_PLACEHOLDER: &str = "node";

pub(crate) const MACHINE_LOCKED_MSG: &str =
    "this account only allows its current devices; allow a new device in the dashboard first";

pub(crate) const LOCK_UNAVAILABLE_MSG: &str =
    "this account's device lock could not be checked right now; try again in a moment";

pub(crate) const SIGN_INS_FROM_ADDRESS_MSG: &str =
    "too many device sign-ins are waiting from your network; finish one or wait 10 minutes, then try again";

pub(crate) const SIGN_INS_FULL_MSG: &str = "too many device sign-ins are waiting on this server; try again in a few minutes";

pub(crate) const TENANT_SUSPENDED_MSG: &str = "this tailnet is suspended by the instance operator";

/// Unauthorized RegisterResponse carrying a user-visible error (tailscaled
/// surfaces `Error` to the user and stops the login attempt).
fn error_response(msg: &str) -> RegisterResponse {
    RegisterResponse {
        user: User::default(),
        login: Login::default(),
        node_key_expired: false,
        machine_authorized: false,
        auth_url: String::new(),
        error: msg.into(),
    }
}

/// Authorized RegisterResponse naming the node's owner as the TS service
/// pushed it (Bluesky handle), or the legacy placeholder user when unknown.
fn authorized_response(state: &CoordinatorState, tenant: TenantId, owner: Option<&str>) -> RegisterResponse {
    let profile = state.caches.identity.profile(tenant, owner);
    RegisterResponse {
        user: User {
            id: profile.id,
            display_name: profile.display_name.clone(),
        },
        login: Login {
            id: profile.id,
            provider: "atproto".into(),
            login_name: profile.login_name,
            display_name: profile.display_name,
        },
        node_key_expired: false,
        machine_authorized: true,
        auth_url: String::new(),
        error: String::new(),
    }
}

pub async fn handle_map(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    body: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let req: MapRequest = serde_json::from_str(body)?;

    if let Some(node_id) = state.store.get_node_by_machine_key(machine_key).await {
        if req.hostinfo.is_some() {
            sync_node_routes(state, node_id, advertised_routes_from(req.hostinfo.as_ref())).await;
        }
        // The relay region the device chose as its home; peers reach it there
        let preferred = req.hostinfo.as_ref().and_then(|h| h.net_info.as_ref()).map(|n| n.preferred_derp);
        if let Some(region) = preferred.filter(|r| (1..=999).contains(r)) {
            if let Err(e) = state.store.set_home_relay(node_id, region).await {
                tracing::warn!(error = %e, "set_home_relay failed");
            }
        }
        // Endpoints and disco key are relayed verbatim to every peer: bound them.
        let endpoints = sanitize::endpoints(req.endpoints.as_deref().unwrap_or_default());
        let disco_key = req.disco_key.as_deref().and_then(sanitize::disco_key);
        if !endpoints.is_empty() || disco_key.is_some() {
            if let Err(e) = state.store.update_endpoints(node_id, endpoints, disco_key).await {
                tracing::warn!(error = %e, "update_endpoints failed");
            }
        }
    }

    build_map_snapshot(state, machine_key).await
}

pub async fn build_map_snapshot(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let resp = state.netmap.build_snapshot(machine_key).await?;
    Ok(serde_json::to_string(&resp)?)
}

/// A full snapshot for a streaming session. `last_peers` holds the peer ids
/// of the previous snapshot: a client treats a snapshot without peers as "no
/// change", so when the list becomes empty the old peers are removed by id.
pub async fn build_map_update(
    state: &Arc<CoordinatorState>,
    machine_key: &[u8; 32],
    last_peers: &mut Vec<i64>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let mut resp = state.netmap.build_snapshot(machine_key).await?;
    let current: Vec<i64> = resp.peers.as_ref().map(|p| p.iter().map(|n| n.id).collect()).unwrap_or_default();
    if current.is_empty() && !last_peers.is_empty() {
        resp.peers_removed = Some(std::mem::take(last_peers));
    }
    *last_peers = current;
    Ok(serde_json::to_string(&resp)?)
}

/// Peer ids in a serialized map response (the initial snapshot of a stream).
pub fn peer_ids_in(map_json: &str) -> Vec<i64> {
    serde_json::from_str::<serde_json::Value>(map_json)
        .ok()
        .and_then(|v| v.get("Peers").and_then(|p| p.as_array()).map(|a| a.iter().filter_map(|n| n.get("ID")?.as_i64()).collect()))
        .unwrap_or_default()
}

/// The delta for a device of tenant `viewer` (`None` when the event is not
/// for it or does not check out against the store).
pub async fn build_delta_response(
    state: &Arc<CoordinatorState>,
    viewer: TenantId,
    event: &PeerEvent,
) -> Option<String> {
    let resp = state.netmap.build_delta(viewer, event).await?;
    serde_json::to_string(&resp).ok()
}

/// Normalised advertised routes from a client's Hostinfo. `None` when the request
/// carried no Hostinfo (leave stored routes alone); a Hostinfo without
/// RoutableIPs means "advertises nothing".
fn advertised_routes_from(hostinfo: Option<&coord_proto::register::Hostinfo>) -> Option<Vec<String>> {
    hostinfo.map(|h| coord_core::routes::normalize_routes_lossy(h.routable_ips.as_deref().unwrap_or(&[])))
}

/// Persist a node's advertised routes (if given), apply the tenant's
/// auto-approvers, and push a fresh netmap to the tenant if anything changed.
/// Nodes can only *advertise*; approval comes from the admin API or auto-approvers.
pub(crate) async fn sync_node_routes(
    state: &Arc<CoordinatorState>,
    node_id: NodeId,
    advertised: Option<Vec<String>>,
) {
    let Some(before) = state.store.get_node_info(node_id).await else {
        return;
    };
    let mut changed = false;
    if let Some(routes) = advertised {
        match state.store.set_advertised_routes(node_id, routes).await {
            Ok(c) => changed |= c,
            Err(e) => warn!(error = %e, node_id = node_id.as_i64(), "set_advertised_routes failed"),
        }
    }
    changed |= apply_auto_approvers(state, node_id).await;
    if !changed {
        return;
    }
    // Peers already get a NodeUpdated delta from the store; the node's own stream
    // ignores its own events, so push a full snapshot when its served routes change.
    let Some(after) = state.store.get_node_info(node_id).await else {
        return;
    };
    let served = |a: &coord_core::NodeAttrs| coord_core::routes::effective_routes(&a.advertised_routes, &a.approved_routes);
    if served(&before.attrs) != served(&after.attrs) {
        state.notify_tenant_changed(after.tenant_id);
    }
}

/// Add any advertised routes the tenant's auto-approvers cover to the node's
/// approved set. Never removes approvals. Returns true if the set changed.
pub(crate) async fn apply_auto_approvers(state: &Arc<CoordinatorState>, node_id: NodeId) -> bool {
    let Some(detail) = state.store.get_node_info(node_id).await else {
        return false;
    };
    let policy = state.caches.auto_approvers.get_tenant(detail.tenant_id);
    let auto = policy.approvable(&detail.attrs.tags, &detail.attrs.advertised_routes);
    if auto.iter().all(|r| detail.attrs.approved_routes.contains(r)) {
        return false;
    }
    let mut approved = detail.attrs.approved_routes.clone();
    approved.extend(auto);
    approved.sort();
    approved.dedup();
    match state.store.set_approved_routes(node_id, approved).await {
        Ok(changed) => {
            if changed {
                info!(node_id = node_id.as_i64(), "routes auto-approved");
            }
            changed
        }
        Err(e) => {
            warn!(error = %e, node_id = node_id.as_i64(), "auto-approve failed");
            false
        }
    }
}
