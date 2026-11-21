/**
 * @module orchestrator/headscale
 * Docker lifecycle for per-tenant Headscale containers.
 * Bootstrap (API key and first user) runs through `docker exec`.
 */

import Docker from "dockerode";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config, tenantPublicUrl } from "../config.js";
import type { DerpRegion } from "../db/schema.js";

const docker = new Docker();

/** Port Headscale listens on inside its container. */
export const HEADSCALE_CONTAINER_PORT = 8080;

export function tenantContainerName(slug: string): string {
  return `headscale-${slug}`;
}

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
  const serverUrl = tenantPublicUrl(slug);

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
listen_addr: 0.0.0.0:${HEADSCALE_CONTAINER_PORT}
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

/** Emits a string as a double-quoted YAML scalar (JSON strings are valid YAML). */
function yamlStr(value: string): string {
  return JSON.stringify(String(value));
}

/** Throws for anything that is not a non-negative integer. */
function yamlInt(value: number): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid DERP numeric field: ${String(value)}`);
  }
  return String(value);
}

function derpRegionToYaml(region: DerpRegion): string {
  const id = yamlInt(region.regionId);
  const nodesYaml = region.nodes
    .map(
      (n) =>
        `        - name: ${yamlStr(n.name)}\n          regionid: ${id}\n          hostname: ${yamlStr(n.hostname)}\n          stunport: ${yamlInt(n.stunPort ?? 0)}\n          derpport: ${yamlInt(n.derpPort ?? 0)}`,
    )
    .join("\n");
  return `    ${id}:\n      regionid: ${id}\n      regioncode: ${yamlStr(region.regionCode)}\n      regionname: ${yamlStr(region.regionName)}\n      nodes:\n${nodesYaml}`;
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
 * Splits a non-TTY `docker exec` stream into stdout and stderr.
 * Each frame has an 8-byte header: stream id, three zero bytes, big-endian payload length.
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
      // Not a multiplexed stream, for example a TTY exec
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
  // Some Headscale versions have no health command, so continue after a short wait
  await new Promise((r) => setTimeout(r, 2000));
}

/** Headscale API keys as printed by the CLI: no whitespace or control characters. */
const API_KEY_RE = /^[A-Za-z0-9._-]{16,}$/;

/**
 * Errors: throws when the output is not a key.
 * A bad stored key makes every later API call fail with 401.
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

export async function createInstance(
  slug: string,
  port: number,
): Promise<TenantInstance> {
  const dataDir = resolve(config.headscale.dataDir, slug);
  await mkdir(dataDir, { recursive: true });

  const configContent = generateHeadscaleConfig(slug, port);
  await writeFile(join(dataDir, "config.yaml"), configContent);
  await writeFile(join(dataDir, "derp-custom.yaml"), "regions: {}\n");

  const containerPort = `${HEADSCALE_CONTAINER_PORT}/tcp`;
  const container = await docker.createContainer({
    Image: config.headscale.image,
    name: tenantContainerName(slug),
    Cmd: ["serve"],
    ExposedPorts: {
      [containerPort]: {},
    },
    HostConfig: {
      Binds: [`${dataDir}:/etc/headscale`],
      PortBindings: {
        [containerPort]: [{ HostIp: "127.0.0.1", HostPort: String(port) }],
      },
      RestartPolicy: { Name: "unless-stopped" },
      // On the shared network Caddy reaches the container by name.
      ...(config.headscale.network
        ? { NetworkMode: config.headscale.network }
        : {}),
    },
  });

  await container.start();
  await waitForReady(container);

  const apiKey = await createApiKeyInContainer(container.id);

  await execInContainer(container, ["headscale", "users", "create", "owner"]);

  return {
    slug,
    port,
    apiKey,
    containerId: container.id,
  };
}

/**
 * Takes over a container left by a failed provisioning attempt and issues a fresh API key.
 * Returns null when the tenant has no container.
 */
export async function adoptInstance(
  slug: string,
  port: number,
): Promise<TenantInstance | null> {
  const container = docker.getContainer(tenantContainerName(slug));
  let info: Docker.ContainerInspectInfo;
  try {
    info = await container.inspect();
  } catch {
    return null;
  }

  await ensureOnTenantNetwork(info.Id);
  if (!info.State.Running) await container.start();
  await waitForReady(container);

  const apiKey = await createApiKeyInContainer(info.Id);
  // Does nothing if the first attempt already created the user
  await execInContainer(container, ["headscale", "users", "create", "owner"]);

  return { slug, port, apiKey, containerId: info.Id };
}

/** Containers created before `HEADSCALE_NETWORK` was set are not on the shared network. */
export async function ensureOnTenantNetwork(containerId: string): Promise<void> {
  const network = config.headscale.network;
  if (!network) return;
  const info = await docker.getContainer(containerId).inspect();
  if (info.NetworkSettings.Networks[network]) return;
  await docker.getNetwork(network).connect({ Container: info.Id });
}

/** Safe to call when the container is already stopped. */
export async function destroyInstance(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop();
  } catch {
    // already stopped
  }
  await container.remove();
}

export async function startInstance(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.start();
  } catch (err) {
    // Docker answers 304 when the container already runs
    if (isNotModified(err)) return;
    throw err;
  }
}

export async function stopInstance(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop();
  } catch (err) {
    // Docker answers 304 when the container is already stopped
    if (isNotModified(err)) return;
    throw err;
  }
}

function isNotModified(err: unknown): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === 304;
}

