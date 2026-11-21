//! Streaming `/machine/map`: one long-lived response per device, fed by peer and config events.

use std::sync::Arc;
use std::time::Duration;

use axum::http::{Response, StatusCode};
use bytes::Bytes;
use coord_core::{NodeId, TenantId};
use coord_core::clock;
use coord_store::PeerEvent;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tracing::warn;

use crate::control;
use crate::noise_handler::{frame_map_response, json_error, BoxBody};
use crate::state::{ConfigChange, CoordinatorState};

type Frame = Result<hyper::body::Frame<Bytes>, std::io::Error>;

const KEEPALIVE_PERIOD: Duration = Duration::from_secs(60);

pub(crate) async fn handle_streaming_map(state: Arc<CoordinatorState>, machine_key: [u8; 32], body: String) -> Response<BoxBody> {
    // Subscribe before the snapshot so no event falls between them. Clients merge duplicates.
    let peer_rx = state.store.subscribe();
    let config_rx = state.config_changed.subscribe();

    let initial = match control::handle_map(&state, &machine_key, &body).await {
        Ok(json) => json,
        Err(e) => {
            warn!(error = %e, "streaming map initial response failed");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    let Some(node_id) = state.store.get_node_by_machine_key(&machine_key).await else {
        return json_error(StatusCode::UNAUTHORIZED, "node not registered");
    };
    let Some(tenant_id) = state.store.get_node_tenant(node_id).await else {
        return json_error(StatusCode::NOT_FOUND, "node has no tenant");
    };

    let (tx, rx) = mpsc::channel::<Frame>(32);
    let mut stream = MapStream {
        last_peers: control::peer_ids_in(&initial),
        state,
        machine_key,
        node_id,
        tenant_id,
        tx,
        children: Vec::new(),
    };
    stream.send_json(&initial).await;
    stream.refresh_children().await;
    tokio::spawn(stream.run(peer_rx, config_rx));

    use http_body_util::BodyExt;
    let body = http_body_util::StreamBody::new(tokio_stream::wrappers::ReceiverStream::new(rx));
    Response::builder().status(StatusCode::OK).body(body.boxed()).unwrap()
}

struct MapStream {
    state: Arc<CoordinatorState>,
    machine_key: [u8; 32],
    node_id: NodeId,
    tenant_id: TenantId,
    tx: mpsc::Sender<Frame>,
    last_peers: Vec<i64>,
    /// Child tenants visible to this tenant: their peer events reach this device.
    children: Vec<TenantId>,
}

impl MapStream {
    /// Send one framed message. Returns false when the client is gone.
    async fn send_json(&self, json: &str) -> bool {
        match frame_map_response(json.as_bytes()) {
            Ok(framed) => self.tx.send(Ok(hyper::body::Frame::data(Bytes::from(framed)))).await.is_ok(),
            Err(e) => {
                warn!(error = %e, "map frame compression failed");
                true
            }
        }
    }

    /// Send the device a fresh view of its peers. Returns false when the client is gone.
    async fn send_update(&mut self) -> bool {
        match control::build_map_update(&self.state, &self.machine_key, &mut self.last_peers).await {
            Ok(json) => self.send_json(&json).await,
            Err(e) => {
                warn!(error = %e, "map update failed");
                true
            }
        }
    }

    async fn refresh_children(&mut self) {
        self.children = self
            .state
            .store
            .get_child_tenants(self.tenant_id)
            .await
            .into_iter()
            .filter(coord_core::Tenant::visible_to_parent)
            .map(|t| t.id)
            .collect();
    }

    /// Re-check the stream. When it must end, tell the client to drop its peers first.
    async fn still_valid_or_cut_off(&self) -> bool {
        if stream_still_valid(&self.state, self.tenant_id, self.node_id, &self.machine_key).await {
            return true;
        }
        self.send_cutoff().await;
        false
    }

    /// Drop every peer and deny all traffic. Without this, connected peers keep
    /// talking over their WireGuard sessions after the stream ends.
    async fn send_cutoff(&self) {
        let peers = self.state.store.get_peers_with_children(self.tenant_id, self.node_id).await;
        let cutoff = coord_proto::map::MapResponse {
            peers_removed: Some(peers.iter().map(|p| p.node_id.as_i64()).collect()),
            packet_filter: Some(vec![]),
            control_time: Some(clock::to_rfc3339(clock::now())),
            ..Default::default()
        };
        if let Ok(json) = serde_json::to_string(&cutoff) {
            self.send_json(&json).await;
        }
    }

    /// Handle one peer event. Returns false when the stream must end.
    async fn on_peer_event(&mut self, event: &PeerEvent) -> bool {
        let (event_tenant, event_node) = match event {
            PeerEvent::NodeJoined { tenant_id, node_id }
            | PeerEvent::NodeUpdated { tenant_id, node_id }
            | PeerEvent::NodeOffline { tenant_id, node_id } => (*tenant_id, *node_id),
        };
        if event_tenant != self.tenant_id && !self.children.contains(&event_tenant) {
            return true;
        }
        // Own changes are not sent. A deleted or moved node ends its stream.
        if event_node == self.node_id {
            return self.state.store.get_node_tenant(self.node_id).await == Some(self.tenant_id);
        }
        // Security: each device sees different peers in both access modes (ADR-0036).
        // A tenant-wide delta would show a device to peers that may not see it. So each device gets its own map.
        self.send_update().await
    }

    async fn run(
        mut self,
        mut peer_rx: tokio::sync::broadcast::Receiver<PeerEvent>,
        mut config_rx: tokio::sync::broadcast::Receiver<ConfigChange>,
    ) {
        let mut keepalive = tokio::time::interval_at(tokio::time::Instant::now() + KEEPALIVE_PERIOD, KEEPALIVE_PERIOD);
        // Jittered so the streams of one replica do not all rebuild at once
        let resync_period = self.state.stream_resync_period;
        let max_jitter = u64::try_from(resync_period.as_millis() / 10).unwrap_or(u64::MAX);
        let jitter = Duration::from_millis(rand::random_range(0..=max_jitter));
        let mut resync = tokio::time::interval_at(tokio::time::Instant::now() + resync_period + jitter, resync_period);
        resync.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            let go_on = tokio::select! {
                () = self.tx.closed() => false,
                changed = config_rx.recv() => match changed {
                    Ok(change) if !change.covers(self.tenant_id) => true,
                    Ok(_) | Err(RecvError::Lagged(_)) => self.resend_checked().await,
                    Err(RecvError::Closed) => false,
                },
                event = peer_rx.recv() => match event {
                    Ok(event) => self.on_peer_event(&event).await,
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!(skipped = n, "map stream lagged, sending full update");
                        let sent = self.send_update().await;
                        self.refresh_children().await;
                        sent
                    }
                    Err(RecvError::Closed) => false,
                },
                // Safety net for lost notifications
                _ = resync.tick() => self.resend_checked().await,
                _ = keepalive.tick() => {
                    let sent = self.still_valid_or_cut_off().await
                        && self.send_json(&serde_json::json!({"KeepAlive": true}).to_string()).await;
                    self.refresh_children().await;
                    sent
                }
            };
            if !go_on {
                break;
            }
        }
        tracing::debug!(node = %self.node_id, "streaming map session ended");
    }

    /// Re-check the stream, refresh the children and send a full update.
    async fn resend_checked(&mut self) -> bool {
        if !self.still_valid_or_cut_off().await {
            return false;
        }
        self.refresh_children().await;
        self.send_update().await
    }
}

/// Whether a live map stream may go on: the node exists in the same tenant, the
/// tenant is not suspended, and the owner's machine lock still lists this machine.
/// A store error on the lock keeps the stream, because registration fails closed. A malformed lock ends it.
async fn stream_still_valid(state: &Arc<CoordinatorState>, tenant_id: TenantId, node_id: NodeId, machine_key: &[u8; 32]) -> bool {
    let Some(detail) = state.store.get_node_info(node_id).await else {
        return false;
    };
    if detail.tenant_id != tenant_id || state.store.is_tenant_suspended(tenant_id).await {
        return false;
    }
    let Some(owner) = detail.attrs.owner.as_deref() else {
        return true;
    };
    match state.store.get_owner_lock(tenant_id, owner).await {
        Ok(coord_core::LockRead::Unlocked) => true,
        Ok(coord_core::LockRead::Locked(l)) => l.allows(&hex::encode(machine_key)),
        Ok(coord_core::LockRead::Malformed) => false,
        Err(e) => {
            tracing::warn!(error = %e, "machine lock not readable during stream re-check");
            true
        }
    }
}
