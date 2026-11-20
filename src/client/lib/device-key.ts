/**
 * This browser's device key (ADR-0035): an ECDSA P-256 key pair created with
 * WebCrypto as *non-extractable* and kept in IndexedDB. Pages can ask the
 * browser to sign with it, but cannot read the private key, so it cannot be
 * copied out by a script or sent to a server.
 */

const DB_NAME = "tailnet-device";
const STORE = "keys";
const RECORD = "device-key";

export interface DeviceKeyRecord {
  /** Id of the trusted device on the server, once enrolled. */
  deviceId: string | null;
  privateKey: CryptoKey;
  publicJwk: { kty: string; crv: string; x: string; y: string };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB is not available"));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
  } finally {
    db.close();
  }
}

/** True when this browser can hold a device key. */
export function deviceKeysSupported(): boolean {
  return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;
}

export async function loadDeviceKey(): Promise<DeviceKeyRecord | null> {
  if (!deviceKeysSupported()) return null;
  try {
    return (await run<DeviceKeyRecord | undefined>("readonly", (s) => s.get(RECORD))) ?? null;
  } catch {
    return null;
  }
}

async function save(record: DeviceKeyRecord): Promise<void> {
  await run("readwrite", (s) => s.put(record, RECORD));
}

/** The device key of this browser, created on first use. */
export async function ensureDeviceKey(): Promise<DeviceKeyRecord> {
  const existing = await loadDeviceKey();
  if (existing) return existing;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const record: DeviceKeyRecord = {
    deviceId: null,
    privateKey: pair.privateKey,
    publicJwk: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! },
  };
  await save(record);
  return record;
}

export async function setDeviceId(deviceId: string | null): Promise<void> {
  const record = await loadDeviceKey();
  if (record) await save({ ...record, deviceId });
}

export async function forgetDeviceKey(): Promise<void> {
  await run("readwrite", (s) => s.delete(RECORD)).catch(() => {});
}

/** Sign a server challenge; base64url of the raw signature. */
export async function signChallenge(record: DeviceKeyRecord, challenge: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, record.privateKey, new TextEncoder().encode(challenge));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A readable default name for this browser, e.g. "Safari on macOS". */
export function suggestedDeviceName(ua: string = navigator.userAgent): string {
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "this device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${os}`;
}

/**
 * Coarse traits of this browser, sent with a device proof. The service only
 * uses them to warn when a trusted key appears on a machine that looks
 * different; they never decide access.
 */
export function deviceTraits(): Record<string, string | number | boolean> {
  const traits: Record<string, string | number | boolean> = {
    touch: navigator.maxTouchPoints > 0,
    cores: navigator.hardwareConcurrency || 0,
    language: navigator.language,
    screen: `${screen.width}x${screen.height}`,
  };
  try {
    traits.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // not available: left out
  }
  return traits;
}
