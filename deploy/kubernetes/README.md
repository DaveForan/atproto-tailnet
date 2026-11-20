# Kubernetes

These manifests run atproto-tailnet with more than one replica of each
component (ADR-0034). Docker Compose stays the simple way to run one replica
of each on one machine.

**State of this deployment:** the manifests render with `kubectl kustomize`,
and the replica behavior has tests with a real PostgreSQL. Nobody has applied
the manifests to a cluster yet. Test them on a cluster that you can lose
before you use them for real devices.

## What runs

| Component | Kind | Replicas | Notes |
|---|---|---|---|
| `tailnet-app` | Deployment | 2 | Dashboard and API. Background work runs on one replica at a time. |
| `tailnet-control` | Deployment | 2 | Coordinator, `COORD_ROLE=control`: control protocol and admin API. |
| `tailnet-relay` | StatefulSet | 2 | Coordinator, `COORD_ROLE=relay`: DERP relay and STUN. Each replica is its own region. |
| `tailnet-migrate` | Job | — | Database migrations of the TS service. |
| PostgreSQL | not included | — | Use a managed service or an operator (for example CloudNativePG). |

PostgreSQL is the one place that holds state. It must be highly available
itself. The control replicas use `LISTEN/NOTIFY`, which needs a direct
connection: do not put a transaction-mode pooler (PgBouncer) between the
coordinator and PostgreSQL.

## Before you start

1. A cluster with an ingress controller. The Ingress is written for
   **ingress-nginx**. The controller must pass HTTP `Upgrade` requests
   through and keep connections open for a long time.
2. **cert-manager** with a `ClusterIssuer` named `letsencrypt` (change the
   annotation in the overlay if yours has another name).
3. A load balancer that supports **UDP** (for STUN).
4. A PostgreSQL database and its connection URL.
5. Two images, built from this repository and pushed to your registry:

   ```sh
   docker build -t registry.example.com/atproto-tailnet/app:1 .
   docker build -t registry.example.com/atproto-tailnet/coordinator:1 coordinator
   ```

## DNS

| Name | Points to |
|---|---|
| `tailnets.example.com` | the ingress controller |
| `control.example.com` | the ingress controller |
| `relay-0.relay.example.com`, `relay-1.relay.example.com` | the ingress controller |

Each relay also has a LoadBalancer Service for STUN
(`tailnet-relay-N-stun`, UDP 3478). STUN and HTTPS of one relay must use the
same name, so either use one address for both (a load balancer that carries
TCP 443 and UDP 3478), or give each relay name the address of its STUN
Service and route HTTPS for that name there too. If you cannot do this, set
`COORD_STUN_LISTEN=off` on the relays: devices then find their public address
through the relay connection only, and direct paths are found less often.

`BASE_DOMAIN` (for example `ts.example.com`) needs no public DNS record. Names
under it exist inside tailnets only.

## Secrets

The manifests never contain secrets. Create the Secret yourself:

```sh
kubectl create namespace atproto-tailnet
kubectl -n atproto-tailnet create secret generic tailnet-secrets \
  --from-literal=DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DB' \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=COORDINATOR_API_KEY="$(openssl rand -hex 32)" \
  --from-literal=FEDERATION_KEY_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  --from-literal=CONTROL_KEY="$(openssl rand -hex 32)" \
  --from-file=ATPROTO_PRIVATE_KEY=./atproto-private-key.pem
```

- `CONTROL_KEY` is the Noise key of the control plane. Devices pin it. All
  control replicas use it. **Keep a copy.** If it changes, every device must
  sign in again. To move an existing instance, use the contents of its
  `control.key` file.
- `ATPROTO_PRIVATE_KEY` is the key of the sign-in client. `deploy/digitalocean/AGENT.md`
  shows how to make one.

## Deploy

```sh
cp -r deploy/kubernetes/overlays/example deploy/kubernetes/overlays/mine
# edit deploy/kubernetes/overlays/mine/kustomization.yaml: images, domains, operator DIDs

kubectl -n atproto-tailnet delete job tailnet-migrate --ignore-not-found
kubectl apply -k deploy/kubernetes/overlays/mine
kubectl -n atproto-tailnet wait --for=condition=complete job/tailnet-migrate --timeout=5m
kubectl -n atproto-tailnet rollout status deploy/tailnet-app deploy/tailnet-control statefulset/tailnet-relay
```

For a new version: push new images, change the tags in the overlay, and run
the same four commands. The coordinator applies its own migrations at start
and takes a lock, so its replicas can start together.

## Check

```sh
curl -s https://tailnets.example.com/health
curl -s https://control.example.com/key              # the control key, as JSON
curl -s -o /dev/null -w '%{http_code}\n' https://relay-0.relay.example.com/derp/probe   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://control.example.com/api/nodes          # 404: the admin API is not public
```

Then connect two devices and stop one pod of each component in turn. A
connected device must reconnect by itself in some seconds.

## More relays

Each relay replica is one DERP region (`COORD_DERP_REGION_ID` = ordinal + 1,
allowed 1 to 899). Relays report themselves in the database, and the control
replicas put the live relays in the DERP map of every device. To add one:

1. Raise `replicas` of the StatefulSet.
2. Copy the Services `tailnet-relay-1` and `tailnet-relay-1-stun` for the new ordinal.
3. Add the host to the Ingress (rule and certificate) and to DNS.

There is no link between relays. A device sends to a peer through the home
relay of that peer, so two devices on different relays reach each other.

## Limits to know

- Rate limits are counted in each replica. With N replicas, a limit lets up
  to N times the configured number through.
- A lost event notification delays an update on another control replica
  until the next change or reconnect of that device.
- Per-tailnet control hostnames (`<name>.<BASE_DOMAIN>`) are not routed here.
  Devices use the shared control URL (`CONTROL_DOMAIN`), which is required.
- The federation broker of the coordinator (`COORD_FEDERATION_ENABLED`) is
  not made for more than one replica. Leave it off: the TS service is the
  federation endpoint.
