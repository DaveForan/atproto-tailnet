import Docker from "dockerode";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config.js";

const docker = new Docker();

export interface TenantInstance {
  slug: string;
  port: number;
  apiKey: string;
  containerId: string;
}

function generateHeadscaleConfig(slug: string, port: number): string {
  const publicProto = config.publicUrl.startsWith("https") ? "https" : "http";
  const serverUrl = `${publicProto}://${slug}.${config.baseDomain}`;
  return `---
server_url: ${serverUrl}
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 0.0.0.0:9090
noise:
  private_key_path: /etc/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: true
  update_frequency: 24h
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

export async function createInstance(
  slug: string,
  port: number,
): Promise<TenantInstance> {
  const dataDir = resolve(config.headscale.dataDir, slug);
  await mkdir(dataDir, { recursive: true });

  const configContent = generateHeadscaleConfig(slug, port);
  await writeFile(join(dataDir, "config.yaml"), configContent);

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

export async function destroyInstance(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    await container.stop();
  } catch {
    // already stopped
  }
  await container.remove();
}

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

export async function startInstance(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.start();
}

export async function stopInstance(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.stop();
}

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
