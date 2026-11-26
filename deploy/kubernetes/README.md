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
| Network policies | NetworkPolicy | — | Deny all traffic, then allow only what each component needs. See [Network policies](#network-policies). |
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
4. A PostgreSQL database and its connection URL, and its address range for
   the network policy.
5. A network plugin that enforces NetworkPolicy (for example Calico or
   Cilium). Without one, the policies do nothing.
6. Two images, built from this repository and pushed to your registry:

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
  --from-literal=RELAY_DATABASE_URL='postgresql://tailnet_relay:RELAY_PASSWORD@HOST:5432/DB' \
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
- `RELAY_DATABASE_URL` is for the relays. It uses a separate database role
  with few privileges. See [Database role of the relays](#database-role-of-the-relays).

## Database role of the relays

The relays are the pods that the internet reaches most directly. They do not
get `DATABASE_URL`. They use their own role, which can only:

- read the columns of `coord_nodes` and `coord_tenants` that admission needs
  (is the device registered, and is its tailnet not suspended),
- read, add and update rows of `coord_relays` (each relay reports itself
  there every 20 seconds),
- read the list of applied migrations of the coordinator.

It cannot read keys, sign-ins, configuration, federation data or any table
of the TS service, and it cannot change nodes or tenants.
`scripts/relay-db-role.sql` creates the role and explains each grant.
The relays of these manifests run no gateway. A relay with a gateway needs
`-v gateway=1` in the command below (ADR-0038).

The coordinator must have created its tables first. Thus the order for a
new instance is:

1. Create the Secret with `RELAY_DATABASE_URL` and a password that you choose.
2. Apply the overlay (see [Deploy](#deploy)). The control pods create the
   tables. The relay pods fail until the next step.
3. Create the role, as the owner of the tables (the user of `DATABASE_URL`),
   with the same password:

   ```sh
   psql "$DATABASE_URL" -v relay_role=tailnet_relay \
        -v relay_password='RELAY_PASSWORD' -f scripts/relay-db-role.sql
   ```

4. The relay pods start again by themselves and then work.

Run the script again after an upgrade (it can run more than one time). After
an upgrade with a new coordinator migration, a relay that starts before the
control pods cannot apply it. It stops, and Kubernetes starts it again
after the control pods applied it.

Why the script makes a schema for the relay: at start the coordinator runs
`CREATE TABLE IF NOT EXISTS _sqlx_migrations`, and PostgreSQL requires the
CREATE privilege on the schema even when the table exists. The relay gets a
schema of its own, first in its search path, with a read-only view of that
table. The relay can create objects only in that schema, and no other role
uses it.

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

### A version that removes database columns

The four commands replace the app pods one by one while the Job migrates.
That is safe when a migration only adds things. A migration that removes
columns or tables breaks the old app pods that still run: they read the
removed columns and answer errors until Kubernetes replaces them.

Migration `0045_remove_headscale_mode` (ADR-0040) is such a migration. For a
version that contains one, stop the old app pods first. The dashboard and the
API are down for the time of the migration. Devices that are connected stay
connected, because the coordinator and the relays keep running.

```sh
kubectl -n atproto-tailnet scale deploy/tailnet-app --replicas=0
kubectl -n atproto-tailnet rollout status deploy/tailnet-app
kubectl -n atproto-tailnet delete job tailnet-migrate --ignore-not-found
kubectl apply -k deploy/kubernetes/overlays/mine
kubectl -n atproto-tailnet wait --for=condition=complete job/tailnet-migrate --timeout=5m
kubectl -n atproto-tailnet rollout status deploy/tailnet-app deploy/tailnet-control statefulset/tailnet-relay
```

`kubectl apply` sets the replica count of the overlay again.

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

## Network policies

`base/networkpolicy.yaml` first denies all traffic to and from the pods of
the namespace. Then it allows:

| From | To | Port |
|---|---|---|
| the ingress controller | `tailnet-app` | TCP 3000 |
| the ingress controller | `tailnet-control` | TCP 9443 |
| the ingress controller | `tailnet-relay` | TCP 9443 |
| any address | `tailnet-relay` | UDP 3478 (STUN) |
| `tailnet-app` | `tailnet-control` | TCP 9443 |
| all pods | cluster DNS (`kube-system`, `k8s-app: kube-dns`) | UDP and TCP 53 |
| `tailnet-app`, `tailnet-control`, `tailnet-relay`, `tailnet-migrate` | PostgreSQL | TCP 5432 |
| `tailnet-app` | public addresses (not private, not link-local) | any |

The control pods serve the device paths and the admin API on one port. A
network policy cannot tell paths apart. The Ingress routes only `/key` and
`/ts2021` to them, and the admin API also needs `COORDINATOR_API_KEY`.

PostgreSQL is outside these manifests, so its policy is an egress rule to an
address range. The base has a placeholder (`192.0.2.10/32`) that matches
nothing: set the range of your database in your overlay, as the example
overlay does. If PostgreSQL runs in the cluster (for example with
CloudNativePG), change the rule to a `namespaceSelector` and `podSelector`
for its pods, and give PostgreSQL its own ingress policy.

Change the policies in your overlay when:

- your ingress controller is not ingress-nginx in the namespace
  `ingress-nginx` (the policies select pods with
  `app.kubernetes.io/name: ingress-nginx`),
- your cluster uses NodeLocal DNSCache (also allow its address, often
  `169.254.20.10/32`),
- you set `WEBHOOK_ALLOW_PRIVATE=true` (allow the private range of your
  webhooks for `tailnet-app`).

The kubelet probes (`/health`) come from the node. Most network plugins
allow them with no policy. If yours does not, allow the node addresses.

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

## Requester addresses for device sign-in

The coordinator records the address that starts a device sign-in and shows it on the approval page. Behind an ingress controller, the coordinator sees the controller pod as the peer. Set `COORD_TRUSTED_PROXIES` on the control deployment to the CIDR of your ingress controller pods (comma-separated if more than one). The coordinator then reads `X-Forwarded-For` only from those addresses. Without it, the page shows the controller address.
