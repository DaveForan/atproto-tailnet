/**
 * @module orchestrator/headscale
 * Docker lifecycle management for per-tenant Headscale containers.
 * Handles container creation with generated config, bootstrap via `docker exec`
 * (API key + initial user), and start/stop/destroy operations.
 */

import Docker from "dockerode";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config.js";
import type { DerpRegion } from "../db/schema.js";

const docker = new Docker();

/** Result of provisioning a new Headscale container for a tenant. */
export interface TenantInstance {
  slug: string;
  port: number;
  apiKey: string;
  containerId: string;
}

export interface DerpConfigOptions {
  embeddedDerpEnabled?: boolean;
  usePublicDerp?: boolean;
  hasCustomRegions?: boolean;
}

export interface HeadscaleConfigOptions {
  derp?: DerpConfigOptions;
  ipv4Prefix?: string;
  ipv6Prefix?: string;
  ipAllocation?: string;
}

function generateHeadscaleConfig(
  slug: string,
  port: number,
  opts: HeadscaleConfigOptions = {},
): string {
  const publicProto = config.publicUrl.startsWith("https") ? "https" : "http";
  const serverUrl = `${publicProto}://${slug}.${config.baseDomain}`;

  const derp = opts.derp ?? {};
  const urlsLine = derp.usePublicDerp === false
    ? "  urls: []"
    : "  urls:\n    - https://controlplane.tailscale.com/derpmap/default";

  const pathsLine = derp.hasCustomRegions
    ? "  paths:\n    - /etc/headscale/derp-custom.yaml"
    : "";

  const updateFreq = derp.hasCustomRegions ? "5m" : "24h";

  const v4 = opts.ipv4Prefix || "100.64.0.0/10";
  const v6 = opts.ipv6Prefix || "fd7a:115c:a1e0::/48";
  const alloc = opts.ipAllocation || "sequential";

  return `---
server_url: ${serverUrl}
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 0.0.0.0:9090
noise:
  private_key_path: /etc/headscale/noise_private.key
prefixes:
  v4: ${v4}
  v6: ${v6}
  allocation: ${alloc}
derp:
  server:
    enabled: ${derp.embeddedDerpEnabled ? "true" : "false"}
${urlsLine}
${pathsLine ? pathsLine + "\n" : ""}  auto_update_enabled: true
  update_frequency: ${updateFreq}
database:
  type: sqlite
  sqlite:
    path: /etc/headscale/db.sqlite
dns:
  magic_dns: true
  base_domain: ${slug}.tailnet.local
  nameservers:
    global:
      - 1.1.1.1
      - 8.8.8.8
log:
  level: info
policy:
  mode: database
`;
}

function derpRegionToYaml(region: DerpRegion): string {
  const nodesYaml = region.nodes
    .map(
      (n) =>
        `        - name: ${n.name}\n          regionid: ${region.regionId}\n          hostname: ${n.hostname}\n          stunport: ${n.stunPort ?? 0}\n          derpport: ${n.derpPort ?? 0}`,
    )
    .join("\n");
  return `    ${region.regionId}:\n      regionid: ${region.regionId}\n      regioncode: ${region.regionCode}\n      regionname: ${region.regionName}\n      nodes:\n${nodesYaml}`;
}

export async function writeDerpRegionsFile(
  slug: string,
  regions: DerpRegion[],
): Promise<void> {
  const dataDir = resolve(config.headscale.dataDir, slug);
  await mkdir(dataDir, { recursive: true });
  if (regions.length === 0) {
    await writeFile(join(dataDir, "derp-custom.yaml"), "regions: {}\n");
    return;
  }
  const body = regions.map(derpRegionToYaml).join("\n");
  await writeFile(
    join(dataDir, "derp-custom.yaml"),
    `regions:\n${body}\n`,
  );
}

export async function updateInstanceConfig(
  slug: string,
  port: number,
  opts: HeadscaleConfigOptions,
  regions?: DerpRegion[],
): Promise<void> {
  const dataDir = resolve(config.headscale.dataDir, slug);
  await mkdir(dataDir, { recursive: true });
  const cfgContent = generateHeadscaleConfig(slug, port, opts);
  await writeFile(join(dataDir, "config.yaml"), cfgContent);
  if (regions !== undefined) {
    await writeDerpRegionsFile(slug, regions);
  }
}

async function waitForReady(
  container: Docker.Container,
  timeoutMs = 30000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const exec = await container.exec({
        Cmd: ["headscale", "health"],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({});
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      const output = Buffer.concat(chunks).toString();
      if (output.includes("ok") || output.includes("healthy")) {
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Give it one more second and proceed anyway — some versions don't have health
  await new Promise((r) => setTimeout(r, 2000));
}

async function execInContainer(
  container: Docker.Container,
  cmd: string[],
): Promise<string> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(chunks).toString().trim();
}

/**
 * Provision a new Headscale container for a tenant.
 * Writes config to the data directory, creates and starts the container,
 * waits for readiness, then bootstraps an API key and default "owner" user via CLI exec.
 */
export async function createInstance(
  slug: string,
  port: number,
): Promise<TenantInstance> {
  const dataDir = resolve(config.headscale.dataDir, slug);
  await mkdir(dataDir, { recursive: true });

  const configContent = generateHeadscaleConfig(slug, port);
  await writeFile(join(dataDir, "config.yaml"), configContent);
  await writeFile(join(dataDir, "derp-custom.yaml"), "regions: {}\n");

  const container = await docker.createContainer({
    Image: config.headscale.image,
    name: `headscale-${slug}`,
    Cmd: ["serve"],
    ExposedPorts: {
      "8080/tcp": {},
    },
    HostConfig: {
      Binds: [`${dataDir}:/etc/headscale`],
      PortBindings: {
        "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }],
      },
      RestartPolicy: { Name: "unless-stopped" },
    },
  });

  await container.start();
  await waitForReady(container);

  const apiKeyOutput = await execInContainer(container, [
    "headscale",
    "apikeys",
    "create",
    "--expiration",
    "9999d",
  ]);

  // The output typically contains the key on the last non-empty line
  const lines = apiKeyOutput.split("\n").filter((l) => l.trim());
  const apiKey = lines[lines.length - 1].trim();

  // Create a default user for the tenant owner
  await execInContainer(container, ["headscale", "users", "create", "owner"]);

  return {
    slug,
    port,
    apiKey,
    containerId: container.id,
  };
}

/** Stop and remove a Headscale container. Safe to call if already stopped. */
export async function destroyInstance(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop();
  } catch {
    // already stopped
  }
  await container.remove();
}

/** Check whether a container is running, stopped, or gone entirely. */
export async function getInstanceStatus(
  containerId: string,
): Promise<"running" | "stopped" | "missing"> {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    return info.State.Running ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

/** Start a previously stopped Headscale container. */
export async function startInstance(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.start();
}

/** Stop a running Headscale container. */
export async function stopInstance(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.stop();
}

/** Create a Headscale user inside a running container via `headscale users create`. */
export async function createUserInInstance(
  containerId: string,
  username: string,
): Promise<void> {
  const container = docker.getContainer(containerId);
  await execInContainer(container, [
    "headscale",
    "users",
    "create",
    username,
  ]);
}

/** Generate a 24-hour pre-auth key for a user via `headscale preauthkeys create`. */
export async function createPreAuthKeyInInstance(
  containerId: string,
  username: string,
): Promise<string> {
  const container = docker.getContainer(containerId);
  const output = await execInContainer(container, [
    "headscale",
    "preauthkeys",
    "create",
    "--user",
    username,
    "--expiration",
    "24h",
  ]);
  const lines = output.split("\n").filter((l) => l.trim());
  return lines[lines.length - 1].trim();
}
