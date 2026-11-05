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

export function generateHeadscaleConfig(
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

/**
 * Split a non-TTY `docker exec` stream into stdout and stderr. Docker
 * multiplexes both onto one connection as frames with an 8-byte header
 * (stream id, three zero bytes, big-endian payload length). Read as text
 * without this, the header bytes — including NULs — end up in the output.
 */
export function demuxDockerStream(raw: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;

  while (offset + 8 <= raw.length) {
    const type = raw[offset];
    const framed =
      type <= 2 && raw[offset + 1] === 0 && raw[offset + 2] === 0 && raw[offset + 3] === 0;
    const size = framed ? raw.readUInt32BE(offset + 4) : -1;
    if (!framed || offset + 8 + size > raw.length) {
      // Not a multiplexed stream (e.g. the exec was started with a TTY).
      return { stdout: raw.toString(), stderr: "" };
    }
    (type === 2 ? err : out).push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }

  if (offset !== raw.length) {
    return { stdout: raw.toString(), stderr: "" };
  }
  return { stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

/** Run a command in a container and return its stdout/stderr and exit code. */
async function execInContainer(
  container: Docker.Container,
  cmd: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
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
  const { stdout, stderr } = demuxDockerStream(Buffer.concat(chunks));
  const { ExitCode } = await exec.inspect();
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: ExitCode };
}

async function waitForReady(
  container: Docker.Container,
  timeoutMs = 30000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { stdout, stderr } = await execInContainer(container, ["headscale", "health"]);
      const output = stdout + stderr;
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

/** Headscale API keys as printed by the CLI: no whitespace or control characters. */
const API_KEY_RE = /^[A-Za-z0-9._-]{16,}$/;

/**
 * Create an API key inside a running Headscale container and return it.
 * Throws rather than returning something that is not a key — a bad key is
 * stored on the tenant and every later API call fails with 401.
 */
export async function createApiKeyInContainer(containerId: string): Promise<string> {
  const { stdout, stderr, exitCode } = await execInContainer(
    docker.getContainer(containerId),
    ["headscale", "apikeys", "create", "--expiration", "9999d"],
  );

  // The key is the last non-empty line of stdout.
  const apiKey = stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (exitCode !== 0 || !API_KEY_RE.test(apiKey)) {
    throw new Error(
      `headscale apikeys create failed (exit ${exitCode}): ${stderr || "unexpected output"}`,
    );
  }
  return apiKey;
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

  const apiKey = await createApiKeyInContainer(container.id);

  // Create a default user for the tenant owner
  await execInContainer(container, ["headscale", "users", "create", "owner"]);

  return {
    slug,
    port,
    apiKey,
    containerId: container.id,
  };
}

/**
 * Take over the tenant's existing Headscale container, if there is one —
 * left by a provisioning attempt that failed after the container started.
 * Starts it if stopped and issues a fresh API key. Returns null when the
 * tenant has no container yet.
 */
export async function adoptInstance(
  slug: string,
  port: number,
): Promise<TenantInstance | null> {
  const container = docker.getContainer(`headscale-${slug}`);
  let info: Docker.ContainerInspectInfo;
  try {
    info = await container.inspect();
  } catch {
    return null;
  }

  if (!info.State.Running) await container.start();
  await waitForReady(container);

  const apiKey = await createApiKeyInContainer(info.Id);
  // No-op if the first attempt got as far as creating it.
  await execInContainer(container, ["headscale", "users", "create", "owner"]);

  return { slug, port, apiKey, containerId: info.Id };
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
  const { stdout, stderr, exitCode } = await execInContainer(container, [
    "headscale",
    "preauthkeys",
    "create",
    "--user",
    username,
    "--expiration",
    "24h",
  ]);
  const key = stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (exitCode !== 0 || !key) {
    throw new Error(
      `headscale preauthkeys create failed (exit ${exitCode}): ${stderr || "no output"}`,
    );
  }
  return key;
}
