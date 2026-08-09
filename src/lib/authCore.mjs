import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "obsdraw_session";
export const AUTH_MAX_AGE_SECONDS = 60 * 60 * 8;
const SOCKET_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 8;

const AUTH_TOKEN_VERSION = 3;
const SOCKET_TOKEN_VERSION = 2;
const MAX_TOKEN_LENGTH = 4096;
const MAX_ENCODED_PAYLOAD_LENGTH = 2048;

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function hmacHex(secret, value) {
  return createHmac("sha256", String(secret)).update(String(value), "utf8").digest("hex");
}

function safeEqualText(left, right) {
  const leftHash = createHash("sha256").update(String(left), "utf8").digest();
  const rightHash = createHash("sha256").update(String(right), "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

function safeEqualHex(left, right) {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) {
    safeEqualText(a, b);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function trimEnv(value) {
  return String(value || "").trim();
}

function verifyInputAgainstSecret(input, rawSecret, hashSecret) {
  const candidate = String(input || "");
  const expectedHash = trimEnv(hashSecret);
  if (expectedHash) {
    return SHA256_HEX.test(expectedHash) && safeEqualHex(sha256Hex(candidate), expectedHash);
  }

  const expected = trimEnv(rawSecret);
  if (!expected) return false;
  if (SHA256_HEX.test(expected)) {
    return safeEqualHex(sha256Hex(candidate), expected);
  }
  return safeEqualText(candidate, expected);
}

function authSecret() {
  return trimEnv(process.env.AUTH_SECRET || process.env.ACCESS_KEY);
}

function socketSecret() {
  return trimEnv(
    process.env.SOCKET_AUTH_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.ACCESS_KEY ||
    process.env.VIEW_KEY
  );
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encoded) {
  if (typeof encoded !== "string" || encoded.length > MAX_ENCODED_PAYLOAD_LENGTH) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(String(encoded), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function verifySignedPayload(token, secret, maxAgeSeconds) {
  const raw = String(token || "");
  if (!raw || raw.length > MAX_TOKEN_LENGTH) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!safeEqualHex(sig, hmacHex(secret, payload))) return null;

  const decoded = decodePayload(payload);
  if (!decoded || typeof decoded !== "object") return null;
  const iat = Number(decoded.iat || 0);
  if (!Number.isFinite(iat) || iat <= 0) return null;
  if (Date.now() - iat > maxAgeSeconds * 1000) return null;
  if (iat - Date.now() > 60_000) return null;
  return decoded;
}

export function sanitizeDisplayName(value) {
  let name = "Guest";
  try {
    name = String(value || "").normalize("NFKC").replace(CONTROL_CHARS, "").trim();
  } catch {
    name = String(value || "").replace(CONTROL_CHARS, "").trim();
  }
  if (!name) return "Guest";
  return name.slice(0, 40);
}

export function verifyAccessKey(candidate) {
  return verifyInputAgainstSecret(
    candidate,
    process.env.ACCESS_KEY,
    process.env.ACCESS_KEY_HASH || process.env.ACCESS_KEY_SHA256
  );
}

export function verifyViewKey(candidate) {
  return verifyInputAgainstSecret(
    candidate,
    process.env.VIEW_KEY,
    process.env.VIEW_KEY_HASH || process.env.VIEW_KEY_SHA256
  );
}

export function createAuthToken(name) {
  const secret = authSecret();
  if (!secret) return null;
  const payload = encodePayload({
    v: AUTH_TOKEN_VERSION,
    kind: "session",
    name: sanitizeDisplayName(name),
    iat: Date.now(),
  });
  return `${payload}.${hmacHex(secret, payload)}`;
}

export function verifyAuthToken(token) {
  const secret = authSecret();
  if (!secret) return null;
  const current = verifySignedPayload(token, secret, AUTH_MAX_AGE_SECONDS);
  if (current?.v === AUTH_TOKEN_VERSION && current.kind === "session") {
    return {
      name: sanitizeDisplayName(current.name),
      iat: Number(current.iat),
    };
  }
  return null;
}

export function createSocketToken(role, name) {
  const secret = socketSecret();
  if (!secret) return null;
  const normalizedRole = role === "viewer" ? "viewer" : "editor";
  const payload = encodePayload({
    v: SOCKET_TOKEN_VERSION,
    kind: "socket",
    role: normalizedRole,
    name: sanitizeDisplayName(name),
    iat: Date.now(),
    nonce: randomBytes(8).toString("hex"),
  });
  return `${payload}.${hmacHex(secret, payload)}`;
}

export function verifySocketToken(token) {
  const secret = socketSecret();
  if (!secret) return null;
  const payload = verifySignedPayload(token, secret, SOCKET_TOKEN_MAX_AGE_SECONDS);
  if (payload?.v !== SOCKET_TOKEN_VERSION || payload.kind !== "socket") return null;
  const role = payload.role === "viewer" ? "viewer" : payload.role === "editor" ? "editor" : null;
  if (!role) return null;
  return {
    role,
    name: sanitizeDisplayName(payload.name),
    iat: Number(payload.iat),
  };
}
