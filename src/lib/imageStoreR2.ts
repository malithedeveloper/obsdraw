import crypto from "node:crypto";
import { r2Enabled, putObject, headObject, getObject, type R2ObjectStream } from "./r2Client.mjs";
import { contentTypeFromId, extensionFromContentType, isSafeMediaId } from "./media";
export type StoredInfo = {
  id: string;
  contentType: string;
  size: number;
  urlPath: string;
};
function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
const MEDIA_PREFIX = process.env.R2_MEDIA_PREFIX?.replace(/\/$/, "") || "media";
function ensureR2Configured(): void {
  if (!r2Enabled()) {
    throw new Error("Cloudflare R2 is not configured");
  }
}
export function isR2Configured(): boolean {
  return r2Enabled();
}
function keyForId(id: string): string {
  if (!isSafeMediaId(id)) throw new Error("Invalid media ID");
  return `${MEDIA_PREFIX}/${id}`;
}
export async function put(buf: Buffer, contentType: string): Promise<StoredInfo> {
  ensureR2Configured();
  const hash = sha256(buf);
  const ext = extensionFromContentType(contentType);
  const id = `${hash}${ext ? `.${ext}` : ""}`;
  const key = keyForId(id);
  const existing = await headObject(key);
  if (!existing) {
    await putObject(key, buf, contentType || "application/octet-stream", "public, max-age=31536000, immutable");
  }
  return {
    id,
    contentType: existing?.ContentType || contentType || "application/octet-stream",
    size: existing?.ContentLength || buf.byteLength,
    urlPath: `/api/media/${encodeURIComponent(id)}`,
  };
}
export async function headByHash(hash: string): Promise<{ id: string; contentType: string } | null> {
  ensureR2Configured();
  const exts = ["png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm", ""];
  const probes = exts.map(ext => (async () => {
    const id = ext ? `${hash}.${ext}` : hash;
    const key = keyForId(id);
    const head = await headObject(key);
    if (!head) throw new Error("not-found");
    const ct = head.ContentType || contentTypeFromId(id);
    return { id, contentType: ct };
  })());
  try {
    return await Promise.any(probes);
  } catch {
    return null;
  }
}
export async function get(id: string, opts: { range?: string } = {}): Promise<R2ObjectStream | null> {
  ensureR2Configured();
  const key = keyForId(id);
  return getObject(key, opts);
}
