import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import next from "next";
import nextEnv from "@next/env";
import { Server as SocketServer } from "socket.io";
import {
  basePath as webDavBasePath,
  ensureDirectory as ensureWebDavDirectory,
  readFile as readWebDavFile,
  writeFileAtomic as writeWebDavFileAtomic,
} from "./src/lib/webdavClient.mjs";
import {
  r2Enabled,
  readText as readR2Text,
  writeText as writeR2Text,
} from "./src/lib/r2Client.mjs";
import {
  AUTH_COOKIE_NAME,
  verifyAuthToken,
  verifySocketToken,
} from "./src/lib/authCore.mjs";
import { fingerprintHistory } from "./src/lib/historyProtocol.mjs";
import { compactHistory } from "./src/server/history.mjs";
import { guardClientMessage } from "./src/server/messageGuard.mjs";
import {
  clientIp,
  envInteger,
  FixedWindowRateLimiter,
  parseCookieHeader,
  requestOriginAllowed,
} from "./src/server/security.mjs";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const development = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST?.trim() || "0.0.0.0";
const port = envInteger("PORT", 3000, { max: 65_535 });
const boardName = (process.env.BOARD_NAME || "anonymous").trim() || "anonymous";
const roomName = `board:${boardName}`;
const maxHistory = envInteger("MAX_HISTORY", 5_000, { max: 50_000 });
const persistFlushMs = envInteger("PERSIST_FLUSH_MS", 1_500, { min: 100, max: 60_000 });
const persistFlushEvents = envInteger("PERSIST_FLUSH_EVENTS", 100, { max: 5_000 });
const snapshotChunkSize = envInteger("SNAPSHOT_CHUNK_SIZE", 500, { max: 5_000 });
const maxSocketMessageBytes = envInteger("SOCKET_MAX_MESSAGE_BYTES", 64 * 1024, { min: 1_024, max: 1024 * 1024 });
const socketMessagesPerWindow = envInteger("SOCKET_RATE_LIMIT_MESSAGES", 1_500, { min: 100, max: 20_000 });
const socketBytesPerWindow = envInteger("SOCKET_RATE_LIMIT_BYTES", 8 * 1024 * 1024, { min: 64 * 1024, max: 100 * 1024 * 1024 });
const socketRateWindowMs = envInteger("SOCKET_RATE_LIMIT_WINDOW_MS", 10_000, { min: 1_000, max: 60_000 });
const socketConnectionsPerIp = envInteger("SOCKET_MAX_CONNECTIONS_PER_IP", 12, { max: 1_000 });
const loginAttempts = envInteger("LOGIN_RATE_LIMIT_ATTEMPTS", 20, { max: 1_000 });
const loginWindowMs = envInteger("LOGIN_RATE_LIMIT_WINDOW_MS", 10 * 60_000, { min: 10_000, max: 24 * 60 * 60_000 });

const app = next({ dev: development, hostname, port });
const handleNextRequest = app.getRequestHandler();

const loginLimiter = new FixedWindowRateLimiter(loginAttempts, loginWindowMs);
const socketConnectionLimiter = new FixedWindowRateLimiter(socketConnectionsPerIp * 5, 60_000);
const socketMessageLimiter = new FixedWindowRateLimiter(socketMessagesPerWindow, socketRateWindowMs);
const socketByteLimiter = new FixedWindowRateLimiter(socketBytesPerWindow, socketRateWindowMs);
const activeConnections = new Map();
const roster = new Map();

function webDavConfigured() {
  return Boolean(
    process.env.WEBDAV_URL &&
    process.env.WEBDAV_USERNAME &&
    (process.env.WEBDAV_PASSWORD || process.env.WEBDAV_TOKEN),
  );
}

function storageKind() {
  if (r2Enabled()) return "r2";
  if (webDavConfigured()) return "webdav";
  return "local";
}

function encodedBoardName() {
  return encodeURIComponent(boardName);
}

function r2SnapshotKey() {
  const prefix = (process.env.R2_HISTORY_PREFIX || "boards").trim().replace(/^\/+|\/+$/g, "") || "boards";
  return `${prefix}/snapshot-${encodedBoardName()}.json`;
}

function webDavSnapshotPath() {
  return `${webDavBasePath()}/boards/snapshot-${encodedBoardName()}.json`;
}

function localSnapshotPath() {
  const base = (process.env.LOCAL_STORE_DIR || "./server-data").trim() || "./server-data";
  return path.join(base, "boards", `snapshot-${encodedBoardName()}.json`);
}

function parseSnapshot(text) {
  if (!text || text.length > 50 * 1024 * 1024) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((event) => typeof event === "string").slice(-maxHistory);
  } catch {
    return [];
  }
}

async function readPersistedHistory() {
  const kind = storageKind();
  try {
    if (kind === "r2") return parseSnapshot(await readR2Text(r2SnapshotKey()));
    if (kind === "webdav") {
      const data = await readWebDavFile(webDavSnapshotPath());
      return parseSnapshot(data ? Buffer.from(data).toString("utf8") : "");
    }
    const data = await fs.readFile(localSnapshotPath()).catch(() => null);
    return parseSnapshot(data ? data.toString("utf8") : "");
  } catch (error) {
    console.error(`[persistence] failed to read ${kind} snapshot`, error);
    return [];
  }
}

async function writeLocalAtomic(targetPath, data) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, data, { mode: 0o600 });
  try {
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function writePersistedHistory(events) {
  const serialized = JSON.stringify(events);
  const kind = storageKind();
  if (kind === "r2") {
    await writeR2Text(r2SnapshotKey(), serialized);
    return;
  }
  if (kind === "webdav") {
    const targetPath = webDavSnapshotPath();
    const directory = targetPath.split("/").slice(0, -1).join("/") || "/";
    await ensureWebDavDirectory(directory);
    await writeWebDavFileAtomic(targetPath, serialized);
    return;
  }
  await writeLocalAtomic(localSnapshotPath(), serialized);
}

let persistedHistory = [];
let historyLoaded = false;
let historyLoadPromise;
let pendingHistory = [];
let flushTimer;
let flushQueue = Promise.resolve();

async function ensureHistoryLoaded() {
  if (historyLoaded) return;
  if (!historyLoadPromise) {
    historyLoadPromise = readPersistedHistory().then((events) => {
      persistedHistory = compactHistory(events).slice(-maxHistory);
      historyLoaded = true;
      console.info(`[persistence] loaded ${persistedHistory.length} events from ${storageKind()}`);
    });
  }
  await historyLoadPromise;
}

async function currentHistory() {
  await ensureHistoryLoaded();
  return compactHistory([...persistedHistory, ...pendingHistory].slice(-maxHistory));
}

function flushHistory(reason = "scheduled") {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  flushQueue = flushQueue.then(async () => {
    await ensureHistoryLoaded();
    if (!pendingHistory.length) return;
    const capturedCount = pendingHistory.length;
    const compacted = compactHistory(
      [...persistedHistory, ...pendingHistory.slice(0, capturedCount)].slice(-maxHistory),
    );
    await writePersistedHistory(compacted);
    persistedHistory = compacted;
    pendingHistory.splice(0, capturedCount);
    console.info(`[persistence] wrote ${compacted.length} events to ${storageKind()} (${reason})`);
  }).catch((error) => {
    console.error("[persistence] flush failed", error);
  });
  return flushQueue;
}

function scheduleHistoryFlush(reason) {
  if (pendingHistory.length >= persistFlushEvents) {
    void flushHistory(reason);
    return;
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushHistory(reason), persistFlushMs);
}

function appendHistory(raw, reason) {
  pendingHistory.push(raw);
  scheduleHistoryFlush(reason);
}

function socketIdentity(socket) {
  const auth = socket.handshake?.auth || {};
  const requestedRole = auth.role === "viewer" ? "viewer" : "editor";
  const verifiedSocket = verifySocketToken(typeof auth.token === "string" ? auth.token : "");
  if (verifiedSocket && (verifiedSocket.role === requestedRole || verifiedSocket.role === "editor")) {
    return { role: verifiedSocket.role, name: verifiedSocket.name };
  }

  const cookies = parseCookieHeader(socket.handshake?.headers?.cookie || "");
  const session = verifyAuthToken(cookies[AUTH_COOKIE_NAME] || "");
  return session ? { role: "editor", name: session.name } : null;
}

function rosterMembers() {
  return Array.from(roster.values());
}

function firstDifference(clientKeys, serverKeys) {
  let commonSuffix = 0;
  const count = Math.min(clientKeys.length, serverKeys.length);
  for (let offset = 1; offset <= count; offset += 1) {
    if (clientKeys[clientKeys.length - offset] !== serverKeys[serverKeys.length - offset]) break;
    commonSuffix += 1;
  }
  return {
    clientCount: clientKeys.length,
    serverCount: serverKeys.length,
    lastCommonSuffix: commonSuffix,
    clientFirstDiff: clientKeys[clientKeys.length - commonSuffix - 1],
    serverFirstDiff: serverKeys[serverKeys.length - commonSuffix - 1],
  };
}

async function sendSnapshot(socket) {
  const events = await currentHistory();
  const totalChunks = Math.ceil(events.length / snapshotChunkSize);
  socket.emit("message", JSON.stringify({ type: "snapshot_meta", totalEvents: events.length, totalChunks }));
  for (let index = 0; index < totalChunks; index += 1) {
    socket.emit("message", JSON.stringify({
      type: "snapshot_chunk",
      index,
      total: totalChunks,
      events: events.slice(index * snapshotChunkSize, (index + 1) * snapshotChunkSize),
    }));
  }
  socket.emit("message", JSON.stringify({ type: "snapshot_done" }));
}

async function respondToPing(socket, message, receivedAt) {
  const history = await currentHistory();
  const { fp } = fingerprintHistory(history);
  const serverTs = Date.now();
  const response = {
    type: "ping",
    id: message.id,
    name: message.name,
    fp,
    serverTs,
    processMs: Math.max(0, serverTs - receivedAt),
  };
  if (typeof message.seq === "number") response.seq = message.seq;
  if (typeof message.clientTs === "number") response.clientTs = message.clientTs;
  socket.emit("message", JSON.stringify(response));
}

async function respondToDriftRequest(socket, message) {
  const history = await currentHistory();
  const { fp, keys } = fingerprintHistory(history);
  const clientKeys = Array.isArray(message.client?.keys)
    ? message.client.keys.filter((key) => typeof key === "string").slice(-500)
    : [];
  const analysis = clientKeys.length ? { compare: firstDifference(clientKeys, keys) } : undefined;
  socket.emit("message", JSON.stringify({
    type: "drift_reply",
    for: message.id,
    server: { fp, keys, totalPersisted: history.length, source: storageKind() },
    analysis,
  }));
}

function isLoginRequest(request) {
  if (request.method !== "POST") return false;
  try {
    return new URL(request.url || "/", "http://localhost").pathname === "/";
  } catch {
    return false;
  }
}

function rejectRateLimited(response, retryAfterMs) {
  response.writeHead(429, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  });
  response.end(JSON.stringify({ error: "rate_limited" }));
}

await app.prepare();
await ensureHistoryLoaded();

const httpServer = http.createServer((request, response) => {
  if (isLoginRequest(request)) {
    const result = loginLimiter.consume(clientIp(request));
    if (!result.allowed) {
      rejectRateLimited(response, result.retryAfterMs);
      return;
    }
  }
  handleNextRequest(request, response);
});

const io = new SocketServer(httpServer, {
  allowRequest: (request, callback) => callback(null, requestOriginAllowed(request)),
  maxHttpBufferSize: maxSocketMessageBytes,
  pingInterval: envInteger("SOCKET_PING_INTERVAL_MS", 10_000, { min: 1_000, max: 60_000 }),
  pingTimeout: envInteger("SOCKET_PING_TIMEOUT_MS", 15_000, { min: 1_000, max: 120_000 }),
  serveClient: false,
  transports: ["websocket"],
});

io.use((socket, nextMiddleware) => {
  const ip = clientIp(socket.request);
  const connectionResult = socketConnectionLimiter.consume(ip);
  if (!connectionResult.allowed || (activeConnections.get(ip) || 0) >= socketConnectionsPerIp) {
    const error = new Error("rate_limited");
    error.data = { code: "rate_limited" };
    nextMiddleware(error);
    return;
  }
  const identity = socketIdentity(socket);
  if (!identity) {
    const error = new Error("unauthorized");
    error.data = { code: "unauthorized" };
    nextMiddleware(error);
    return;
  }
  socket.data.identity = identity;
  socket.data.ip = ip;
  nextMiddleware();
});

io.on("connection", (socket) => {
  const identity = socket.data.identity;
  const ip = socket.data.ip;
  activeConnections.set(ip, (activeConnections.get(ip) || 0) + 1);
  socket.join(roomName);
  console.info(`[socket] connected ${socket.id} as ${identity.role}`);

  let quietPresence = false;
  void sendSnapshot(socket).catch((error) => console.error("[socket] snapshot failed", error));

  socket.on("message", (data) => {
    const receivedAt = Date.now();
    const rawSize = typeof data === "string" ? Buffer.byteLength(data, "utf8") : maxSocketMessageBytes;
    const messageRate = socketMessageLimiter.consume(ip);
    const byteRate = socketByteLimiter.consume(ip, rawSize);
    if (!messageRate.allowed || !byteRate.allowed) {
      socket.emit("message", JSON.stringify({ type: "error", code: "rate_limited" }));
      socket.disconnect(true);
      return;
    }

    const guarded = guardClientMessage(data, identity, maxSocketMessageBytes);
    if (!guarded) return;
    const { message } = guarded;
    let suppressBroadcast = false;

    if (message.type === "presence") {
      if (message.kind === "quiet") {
        quietPresence = true;
        suppressBroadcast = true;
      } else if (message.kind === "join") {
        const normalizedName = identity.name.normalize("NFKC").toLocaleLowerCase("en-US");
        const duplicate = rosterMembers().some((member) =>
          member.name.normalize("NFKC").toLocaleLowerCase("en-US") === normalizedName,
        );
        if (duplicate) {
          socket.emit("message", JSON.stringify({
            type: "presence",
            kind: "error",
            code: "name_taken",
            message: "That display name is already in use",
          }));
          socket.disconnect(true);
          return;
        }
        roster.set(socket.id, { id: message.id, name: identity.name });
        message.name = identity.name;
        guarded.raw = JSON.stringify(message);
        if (quietPresence) suppressBroadcast = true;
      } else if (message.kind === "leave") {
        roster.delete(socket.id);
        if (quietPresence) suppressBroadcast = true;
      } else if (message.kind === "roster") {
        socket.emit("message", JSON.stringify({ type: "presence", kind: "roster", members: rosterMembers() }));
        return;
      }
    }

    if (message.type === "ping") {
      void respondToPing(socket, message, receivedAt).catch(() => {
        socket.emit("message", JSON.stringify({ type: "ping", fp: { v: 1, c: 0, u: 0, h: 0 } }));
      });
      return;
    }
    if (message.type === "drift_request") {
      void respondToDriftRequest(socket, message).catch(() => {
        socket.emit("message", JSON.stringify({
          type: "drift_reply",
          for: message.id,
          server: { fp: { v: 1, c: 0, u: 0, h: 0 }, keys: [], totalPersisted: 0, source: "unknown" },
          note: "Unable to calculate the server fingerprint",
        }));
      });
      return;
    }

    if (!suppressBroadcast && identity.role === "editor") {
      socket.to(roomName).emit("message", guarded.raw);
      socket.emit("message", guarded.raw);
    }
    if (guarded.persistable) appendHistory(guarded.raw, message.type);
  });

  socket.on("disconnect", (reason) => {
    console.info(`[socket] disconnected ${socket.id}: ${reason}`);
    activeConnections.set(ip, Math.max(0, (activeConnections.get(ip) || 1) - 1));
    if (activeConnections.get(ip) === 0) activeConnections.delete(ip);
    const member = roster.get(socket.id);
    roster.delete(socket.id);
    if (member && !quietPresence) {
      socket.to(roomName).emit("message", JSON.stringify({
        type: "presence",
        kind: "leave",
        id: member.id,
        name: member.name,
      }));
    }
  });
});

httpServer.listen(port, hostname, () => {
  console.info(`[obsdraw] listening on http://${hostname}:${port}`);
  console.info(`[obsdraw] persistence: ${storageKind()}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[obsdraw] received ${signal}; flushing data`);
  clearTimeout(flushTimer);
  const forcedExit = setTimeout(() => process.exit(1), 10_000);
  forcedExit.unref();
  io.close();
  await flushHistory("shutdown");
  const flushFailed = pendingHistory.length > 0;
  await new Promise((resolve) => httpServer.close(resolve));
  clearTimeout(forcedExit);
  process.exit(flushFailed ? 1 : 0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
