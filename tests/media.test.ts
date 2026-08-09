import assert from "node:assert/strict";
import test from "node:test";
import {
  contentTypeFromId,
  extensionFromContentType,
  isSafeMediaId,
  isSupportedMediaType,
  MediaLimitError,
  parseByteRange,
  readBodyWithLimit,
  sniffMediaType,
} from "../src/lib/media";
import { guardedFetch, isWhitelistedContentType } from "../src/lib/remoteUrlGuard";

test("media identifiers and MIME mappings use an explicit allowlist", () => {
  const hash = "a".repeat(64);
  assert.equal(isSafeMediaId(`${hash}.webp`), true);
  assert.equal(isSafeMediaId("../../secret"), false);
  assert.equal(isSafeMediaId(`${hash}.svg`), false);
  assert.equal(contentTypeFromId(`${hash}.jpeg`), "image/jpeg");
  assert.equal(extensionFromContentType("image/jpeg; charset=binary"), "jpg");
  assert.equal(isSupportedMediaType("image/svg+xml"), false);
});

test("media type detection trusts signatures instead of filenames", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
  const svgText = new TextEncoder().encode("<svg><script>alert(1)</script></svg>");
  assert.equal(sniffMediaType(png), "image/png");
  assert.equal(sniffMediaType(webm), "video/webm");
  assert.equal(sniffMediaType(svgText), null);
});

test("byte ranges include suffix ranges and reject invalid requests", () => {
  assert.deepEqual(parseByteRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(parseByteRange("bytes=100-101", 100), "invalid");
  assert.equal(parseByteRange("items=0-1", 100), "invalid");
});

test("streamed media bodies stop at the configured limit", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3]));
      controller.close();
    },
  });
  assert.deepEqual([...await readBodyWithLimit(body, 3)], [1, 2, 3]);

  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3, 4]));
      controller.close();
    },
  });
  await assert.rejects(readBodyWithLimit(oversized, 3), MediaLimitError);
});

test("remote media blocks local and metadata-service destinations before connecting", async () => {
  await assert.rejects(guardedFetch("http://127.0.0.1/private"), /blocked/i);
  await assert.rejects(guardedFetch("http://169.254.169.254/latest/meta-data"), /blocked/i);
  await assert.rejects(guardedFetch("http://[::1]/private"), /blocked/i);
  await assert.rejects(guardedFetch("http://[::ffff:127.0.0.1]/private"), /blocked/i);
  await assert.rejects(guardedFetch("file:///etc/passwd"), /unsupported protocol/i);
  await assert.rejects(guardedFetch("https://user:password@example.com/media.png"), /credentials/i);
  assert.equal(isWhitelistedContentType("image/webp; charset=binary"), true);
  assert.equal(isWhitelistedContentType("text/html"), false);
});
