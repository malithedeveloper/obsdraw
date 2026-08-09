import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthToken,
  createSocketToken,
  sanitizeDisplayName,
  verifyAccessKey,
  verifyAuthToken,
  verifySocketToken,
  verifyViewKey,
} from "../src/lib/authCore.mjs";
import { compactHistory } from "../src/server/history.mjs";
import { guardClientMessage } from "../src/server/messageGuard.mjs";
import {
  FixedWindowRateLimiter,
  parseCookieHeader,
  requestOriginAllowed,
} from "../src/server/security.mjs";

process.env.ACCESS_KEY = "editor-test-key";
process.env.VIEW_KEY = "viewer-test-key";
process.env.AUTH_SECRET = "auth-secret-used-only-by-tests";
process.env.SOCKET_AUTH_SECRET = "socket-secret-used-only-by-tests";

test("authentication tokens are role-bound and cannot be confused", () => {
  const session = createAuthToken(" Alice ");
  const viewerSocket = createSocketToken("viewer", "Viewer");
  const editorSocket = createSocketToken("editor", "Alice");

  assert.equal(verifyAuthToken(session)?.name, "Alice");
  assert.equal(verifySocketToken(viewerSocket)?.role, "viewer");
  assert.equal(verifySocketToken(editorSocket)?.role, "editor");
  assert.equal(verifyAuthToken(viewerSocket), null);
  assert.equal(verifySocketToken(session), null);
  assert.equal(verifyAuthToken(`${session}tampered`), null);
  assert.equal(verifyAccessKey("editor-test-key"), true);
  assert.equal(verifyAccessKey("wrong"), false);
  assert.equal(verifyViewKey("viewer-test-key"), true);
});

test("display names are normalized and bounded", () => {
  assert.equal(sanitizeDisplayName("\u0000  Alice  "), "Alice");
  assert.equal(sanitizeDisplayName(""), "Guest");
  assert.equal(sanitizeDisplayName("x".repeat(100)).length, 40);
});

test("message guard enforces roles, fields, identity, and size", () => {
  const editor = { role: "editor", name: "Alice" };
  const chat = guardClientMessage(JSON.stringify({
    type: "chat",
    id: "client-1",
    name: "Mallory",
    text: "Hello",
    ignored: "removed",
  }), editor);
  assert.ok(chat);
  assert.equal(chat.message.name, "Alice");
  assert.equal("ignored" in chat.message, false);
  assert.equal(chat.persistable, false);

  const stroke = JSON.stringify({
    type: "stroke",
    id: "client-1",
    strokeId: "stroke-1",
    phase: "start",
    mode: "draw",
    x: 0.2,
    y: 0.4,
    size: 5,
    color: "#fff",
  });
  assert.equal(guardClientMessage(stroke, { role: "viewer", name: "Viewer" }), null);
  assert.equal(guardClientMessage(stroke, editor)?.persistable, true);
  assert.equal(guardClientMessage(stroke, editor, 10), null);
  assert.equal(guardClientMessage('{"type":"unknown"}', editor), null);
  assert.equal(guardClientMessage(JSON.stringify({ type: "presence", kind: "join", id: "viewer-1" }), { role: "viewer", name: "Viewer" }), null);

  const image = {
    type: "image_commit",
    id: "client-1",
    imageId: "image-1",
    strokeId: "stroke-2",
    src: `/api/media/${"a".repeat(64)}.png`,
    x: 0.5,
    y: 0.5,
    width: 0.2,
    height: 0.2,
    filter: "none",
  };
  assert.equal(guardClientMessage(JSON.stringify(image), editor)?.persistable, true);
  assert.equal(guardClientMessage(JSON.stringify({ ...image, src: "file:///etc/passwd" }), editor), null);
  assert.equal(guardClientMessage(JSON.stringify({ ...image, width: -1 }), editor), null);
  assert.equal(guardClientMessage(JSON.stringify({ ...image, filter: "url(https://evil.example/filter)" }), editor), null);
});

test("history compaction keeps current entity state and undo semantics", () => {
  const compacted = compactHistory([
    JSON.stringify({ type: "stroke", id: "a", strokeId: "stroke-1", phase: "end" }),
    JSON.stringify({ type: "undo", by: "Alice", strokeId: "stroke-1" }),
    JSON.stringify({ type: "redo", by: "Alice", strokeId: "stroke-1" }),
    JSON.stringify({ type: "text_commit", id: "a", textId: "text-1", strokeId: "text-stroke-1", text: "Old", width: 100 }),
    JSON.stringify({ type: "text_update", id: "a", textId: "text-1", text: "New", width: 200, dvdEnabled: true, dvdVx: 1 }),
    JSON.stringify({ type: "text_update", id: "a", textId: "text-1", dvdVy: -1, zIndex: 7 }),
  ]).map((value) => JSON.parse(value));

  assert.equal(compacted.some((event) => event.type === "stroke" && event.strokeId === "stroke-1"), true);
  const commit = compacted.find((event) => event.type === "text_commit");
  assert.equal(commit.text, "New");
  assert.equal(commit.width, 200);
  assert.equal(commit.zIndex, 7);
  const state = compacted.find((event) => event.type === "text_update");
  assert.equal(state.dvdEnabled, true);
  assert.equal(state.dvdVx, 1);
  assert.equal(state.dvdVy, -1);
});

test("origin, cookie, and rate-limit helpers use conservative defaults", () => {
  delete process.env.TRUST_PROXY;
  delete process.env.ALLOWED_ORIGINS;
  assert.deepEqual(parseCookieHeader("a=one%20two; b=3; a=ignored"), { a: "one two", b: "3" });
  assert.equal(requestOriginAllowed({ headers: { origin: "https://draw.example", host: "draw.example" } }), true);
  assert.equal(requestOriginAllowed({ headers: { origin: "https://evil.example", host: "draw.example" } }), false);

  const limiter = new FixedWindowRateLimiter(2, 1000);
  assert.equal(limiter.consume("client", 1, 0).allowed, true);
  assert.equal(limiter.consume("client", 1, 1).allowed, true);
  assert.equal(limiter.consume("client", 1, 2).allowed, false);
  assert.equal(limiter.consume("client", 1, 1000).allowed, true);
});
