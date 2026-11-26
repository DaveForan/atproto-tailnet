/**
 * @module orchestrator/relay
 * Docker lifecycle for federation relay halves (ADR-0020). Each link has two halves.
 * A half is a tailscale container in one collective that advertises the peer's CIDRs.
 */

import Docker from "dockerode";
import { logger } from "../logger.js";
import { config, tenantPublicUrl } from "../config.js";

const docker = new Docker();

export const RELAY_IMAGE = "tailscale/tailscale:v1.82.5";
const RELAY_NETWORK_PREFIX = "fed-link-";

export interface RelayHalfConfig {
  tenantSlug: string;
  loginServer: string;
  authKey: string;
  advertisedRoutes: string[];
  localCidrs: string[];
  peerCidrs: string[];
  linkId: string;
  side: "local" | "peer";
}

export function relayContainerName(linkId: string, side: string): string {
  return `relay-${linkId.slice(0, 8)}-${side}`;
}

export function relayNetworkName(linkId: string): string {
  return `${RELAY_NETWORK_PREFIX}${linkId.slice(0, 12)}`;
}

/** Starts a relay half. Its iptables rules forward only the agreed CIDRs. */
export async function createRelayHalf(cfg: RelayHalfConfig): Promise<string> {
  const name = relayContainerName(cfg.linkId, cfg.side);

  const advertiseRoutes = cfg.advertisedRoutes.join(",");
  const forwardRules = buildForwardRules(cfg.localCidrs, cfg.peerCidrs);

  const entrypoint = [
    "/bin/sh",
    "-c",
    [
      "sysctl -w net.ipv4.ip_forward=1",
      "sysctl -w net.ipv6.conf.all.forwarding=1",
      `tailscaled --state=/var/lib/tailscale/tailscaled.state --tun=tailscale0 &`,
      "sleep 2",
      `tailscale up --login-server=${cfg.loginServer} --authkey=${cfg.authKey} --advertise-routes=${advertiseRoutes} --snat-subnet-routes=false --netfilter-mode=off --accept-routes`,
      ...forwardRules,
      "wait",
    ].join(" && "),
  ];

  const container = await docker.createContainer({
    Image: RELAY_IMAGE,
    name,
    Entrypoint: entrypoint,
    HostConfig: {
      CapAdd: ["NET_ADMIN"],
      Devices: [{ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun", CgroupPermissions: "rwm" }],
      Sysctls: {
        "net.ipv4.ip_forward": "1",
        "net.ipv6.conf.all.forwarding": "1",
      },
      RestartPolicy: { Name: "unless-stopped" },
      ...(config.federationRelayNetwork ? { NetworkMode: config.federationRelayNetwork } : {}),
    },
  });

  await container.start();
  logger.info({ name, linkId: cfg.linkId, side: cfg.side }, "relay half container started");

  return container.id;
}

/** Default-drop FORWARD rules that allow only the agreed CIDRs in each direction. */
export function buildForwardRules(localCidrs: string[], peerCidrs: string[]): string[] {
  const rules: string[] = [
    "iptables -P FORWARD DROP",
  ];

  for (const local of localCidrs) {
    for (const peer of peerCidrs) {
      rules.push(
        `iptables -A FORWARD -i tailscale0 -s ${local} -d ${peer} -j ACCEPT`,
        `iptables -A FORWARD -i tailscale0 -s ${peer} -d ${local} -j ACCEPT`,
      );
    }
  }

  rules.push(
    "iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT",
  );

  return rules;
}

export async function destroyRelayHalf(containerId: string): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    if (info.State.Running) {
      await container.stop({ t: 5 });
    }
    await container.remove({ force: true });
    logger.info({ containerId }, "relay half container destroyed");
  } catch (err: any) {
    if (err.statusCode === 404) {
      logger.debug({ containerId }, "relay half container already gone");
    } else {
      throw err;
    }
  }
}

export async function isRelayHalfRunning(containerId: string): Promise<boolean> {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    return info.State.Running;
  } catch {
    return false;
  }
}
