import dns from "node:dns";
import net, { type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { isSupportedMediaType } from "./media";
const DEFAULT_ALLOWED_PORTS = new Set([80, 443]);
const MAX_REDIRECTS = 5;
const envAllowHosts = (process.env.MEDIA_PROXY_ALLOW_HOSTS || "")
  .split(/[,\s]+/)
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => entry.length > 0);
const envAllowPorts = (process.env.MEDIA_PROXY_ALLOW_PORTS || "")
  .split(/[,\s]+/)
  .map((entry) => Number.parseInt(entry, 10))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);
const ALLOWED_PORTS = envAllowPorts.length ? new Set(envAllowPorts) : DEFAULT_ALLOWED_PORTS;
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "127.0.0.1",
  "::1",
]);
interface GuardedFetchInit extends RequestInit {
  maxRedirects?: number;
}
function maskFromPrefix(prefix: number): number {
  return prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
const BLOCKED_IPV4_RANGES = [
  { base: "0.0.0.0", mask: 8 },
  { base: "10.0.0.0", mask: 8 },
  { base: "100.64.0.0", mask: 10 },
  { base: "127.0.0.0", mask: 8 },
  { base: "169.254.0.0", mask: 16 },
  { base: "172.16.0.0", mask: 12 },
  { base: "192.0.0.0", mask: 24 },
  { base: "192.0.2.0", mask: 24 },
  { base: "192.88.99.0", mask: 24 },
  { base: "192.168.0.0", mask: 16 },
  { base: "198.18.0.0", mask: 15 },
  { base: "198.51.100.0", mask: 24 },
  { base: "203.0.113.0", mask: 24 },
  { base: "224.0.0.0", mask: 4 },
  { base: "240.0.0.0", mask: 4 },
];
const ipV4ToInt = (ip: string): number => {
  const parts = ip.split(".");
  if (parts.length !== 4) return -1;
  let value = 0;
  for (const part of parts) {
    const num = Number.parseInt(part, 10);
    if (!Number.isInteger(num) || num < 0 || num > 255) return -1;
    value = (value << 8) | num;
  }
  return value >>> 0;
};
function isBlockedIpv4(address: string): boolean {
  const value = ipV4ToInt(address);
  if (value === -1) return true;
  for (const range of BLOCKED_IPV4_RANGES) {
    const mask = maskFromPrefix(range.mask);
    if ((value & mask) === (ipV4ToInt(range.base) & mask)) {
      return true;
    }
  }
  return false;
}
function ipv6Bytes(input: string): Uint8Array | null {
  let address = input.toLowerCase().split("%", 1)[0]!;
  if (net.isIP(address) !== 6) return null;

  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    const embedded = address.slice(separator + 1);
    const value = ipV4ToInt(embedded);
    if (value < 0) return null;
    address = `${address.slice(0, separator)}:${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < groups.length; index += 1) {
    const value = Number.parseInt(groups[index]!, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function embeddedIpv4Blocked(bytes: Uint8Array, offset: number): boolean {
  return isBlockedIpv4(`${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`);
}

function isBlockedIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;

  const allZero = bytes.every((value) => value === 0);
  const loopback = bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1;
  if (allZero || loopback) return true;
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // Unique local fc00::/7.
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) >= 0x80) return true; // Link/site local fe80::/10 and fec0::/10.
  if (bytes[0] === 0xff) return true; // Multicast ff00::/8.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2]! <= 0x01) return true; // IETF special-purpose 2001::/23.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (bytes[0] === 0x3f && (bytes[1]! & 0xf0) === 0xf0) return true; // Documentation 3fff::/20.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true; // 6to4 can tunnel embedded IPv4.

  const firstTenZero = bytes.slice(0, 10).every((value) => value === 0);
  if (firstTenZero && (
    (bytes[10] === 0xff && bytes[11] === 0xff) ||
    (bytes[10] === 0 && bytes[11] === 0)
  )) {
    return embeddedIpv4Blocked(bytes, 12);
  }
  return false;
}
async function lookupAll(hostname: string): Promise<Array<{ address: string; family: number }>> {
  if (!hostname) return [];
  try {
    return await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return [];
  }
}
function isHostAllowlisted(hostname: string): boolean {
  if (!envAllowHosts.length) return true;
  const host = normalizeHostname(hostname);
  return envAllowHosts.some((entry) =>
    entry.startsWith("*") ? host.endsWith(entry.slice(1)) : host === entry,
  );
}
function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}
function ensureAllowedPort(url: URL): void {
  const port = url.port ? Number.parseInt(url.port, 10) : undefined;
  if (!port) return;  
  if (!ALLOWED_PORTS.has(port)) {
    throw new Error("Port not allowed");
  }
}
function ensureHostnameAllowed(hostname: string): void {
  const normalized = normalizeHostname(hostname);
  if (!isHostAllowlisted(normalized)) {
    throw new Error("Host is not allowlisted");
  }
  if (BLOCKED_HOSTNAMES.has(normalized)) {
    throw new Error("Host blocked");
  }
}
function ensureResolvedAddressesSafe(addresses: Array<{ address: string; family: number }>): void {
  if (!addresses.length) throw new Error("Unable to resolve host");
  for (const { address, family } of addresses) {
    if (family === 4 && isBlockedIpv4(address)) throw new Error("IPv4 address blocked");
    if (family === 6 && isBlockedIpv6(address)) throw new Error("IPv6 address blocked");
  }
}
async function ensureAddressSafe(url: URL): Promise<void> {
  const hostname = normalizeHostname(url.hostname);
  ensureHostnameAllowed(hostname);
  const hostIsIp = net.isIP(hostname);
  const addresses: Array<{ address: string; family: number }> = hostIsIp
    ? [{ address: hostname, family: hostIsIp }]
    : await lookupAll(hostname);
  ensureResolvedAddressesSafe(addresses);
}
function validateScheme(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported protocol");
  }
  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed");
  }
}
async function ensureRemoteUrlAllowed(rawUrl: string | URL): Promise<URL> {
  const url = typeof rawUrl === "string" ? new URL(rawUrl) : new URL(rawUrl.toString());
  validateScheme(url);
  ensureAllowedPort(url);
  await ensureAddressSafe(url);
  return url;
}
function sanitizeInit(init?: GuardedFetchInit): GuardedFetchInit {
  if (!init) return { redirect: "manual" };
  const requestInit = { ...init };
  delete requestInit.maxRedirects;
  return { ...requestInit, redirect: "manual" };
}
function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}
export async function guardedFetch(rawUrl: string | URL, init?: GuardedFetchInit): Promise<Response> {
  let currentUrl = typeof rawUrl === "string" ? new URL(rawUrl) : new URL(rawUrl.toString());
  let remainingRedirects = init?.maxRedirects ?? MAX_REDIRECTS;
  const baseInit = sanitizeInit(init);
  while (remainingRedirects >= 0) {
    await ensureRemoteUrlAllowed(currentUrl);
    const res = await undiciFetch(currentUrl, {
      ...baseInit,
      dispatcher: GUARDED_DISPATCHER,
    } as Parameters<typeof undiciFetch>[1]);
    if (!isRedirect(res.status)) {
      return res as unknown as Response;
    }
    const location = res.headers.get("location");
    try {
      if (res.body) await res.body.cancel();
    } catch {}
    if (!location) {
      return res as unknown as Response;
    }
    if (remainingRedirects === 0) {
      throw new Error("Too many redirects");
    }
    currentUrl = new URL(location, currentUrl);
    remainingRedirects -= 1;
  }
  throw new Error("Too many redirects");
}
export function isWhitelistedContentType(contentType: string | null | undefined): boolean {
  return isSupportedMediaType(contentType);
}
export function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  try {
    ensureHostnameAllowed(hostname);
  } catch (error) {
    callback(error as NodeJS.ErrnoException, "", 0);
    return;
  }
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    try {
      ensureResolvedAddressesSafe(addresses);
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    } catch (guardError) {
      callback(guardError as NodeJS.ErrnoException, "", 0);
    }
  });
};

const GUARDED_DISPATCHER = new Agent({
  connect: {
    lookup: guardedLookup,
  },
});
