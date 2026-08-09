const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function envInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function parseCookieHeader(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name || name in cookies) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

function trustProxy() {
  return TRUE_VALUES.has(String(process.env.TRUST_PROXY || "").trim().toLowerCase());
}

export function clientIp(request) {
  if (trustProxy()) {
    const forwarded = String(request?.headers?.["x-forwarded-for"] || "").split(",", 1)[0].trim();
    if (forwarded) return forwarded;
  }
  return request?.socket?.remoteAddress || "unknown";
}

export function requestOriginAllowed(request) {
  const origin = String(request?.headers?.origin || "").trim();
  if (!origin) return true;

  const configured = String(process.env.ALLOWED_ORIGINS || "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length) return configured.includes(origin);

  const forwardedHost = trustProxy()
    ? String(request?.headers?.["x-forwarded-host"] || "").split(",", 1)[0].trim()
    : "";
  const host = forwardedHost || String(request?.headers?.host || "").trim();
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export class FixedWindowRateLimiter {
  #entries = new Map();

  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  consume(key, cost = 1, now = Date.now()) {
    const current = this.#entries.get(key);
    const entry = !current || now >= current.resetAt
      ? { used: 0, resetAt: now + this.windowMs }
      : current;
    entry.used += cost;
    this.#entries.set(key, entry);
    if (this.#entries.size > 10_000) this.prune(now);
    return { allowed: entry.used <= this.limit, retryAfterMs: Math.max(0, entry.resetAt - now) };
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.#entries) {
      if (now >= entry.resetAt) this.#entries.delete(key);
    }
  }
}
