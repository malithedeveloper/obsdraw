const MEDIA_TYPE_TO_EXTENSION = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
]);

const EXTENSION_TO_MEDIA_TYPE = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["mp4", "video/mp4"],
  ["m4v", "video/mp4"],
  ["webm", "video/webm"],
]);

const SAFE_MEDIA_ID = /^(?:[a-f0-9]{24}|[a-f0-9]{64}(?:\.(?:png|jpe?g|gif|webp|avif|mp4|webm))?)$/i;

export class MediaLimitError extends Error {
  constructor(message = "Media exceeds the configured size limit") {
    super(message);
    this.name = "MediaLimitError";
  }
}

export function normalizeContentType(contentType: string | null | undefined): string {
  return (contentType || "").split(";", 1)[0]!.trim().toLowerCase();
}

export function isSupportedMediaType(contentType: string | null | undefined): boolean {
  return MEDIA_TYPE_TO_EXTENSION.has(normalizeContentType(contentType));
}

export function extensionFromContentType(contentType: string): string {
  return MEDIA_TYPE_TO_EXTENSION.get(normalizeContentType(contentType)) || "";
}

export function contentTypeFromId(id: string): string {
  const match = id.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? EXTENSION_TO_MEDIA_TYPE.get(match[1]!) || "application/octet-stream" : "application/octet-stream";
}

export function guessContentTypeFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? EXTENSION_TO_MEDIA_TYPE.get(match[1]!) || null : null;
  } catch {
    return null;
  }
}

export function isSafeMediaId(id: string): boolean {
  return SAFE_MEDIA_ID.test(id);
}

export function sniffMediaType(buffer: Uint8Array): string | null {
  if (buffer.length < 12) return null;
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61
  ) return "image/gif";
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return "image/webp";
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "video/webm";
  }
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    const brand = Buffer.from(buffer.subarray(8, 12)).toString("ascii").toLowerCase();
    if (brand === "avif" || brand === "avis" || brand === "av01") return "image/avif";
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return null;
    return "video/mp4";
  }
  return null;
}

export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  declaredLength?: number | null,
): Promise<Buffer> {
  if (!body) throw new Error("Response body is empty");
  if (declaredLength && declaredLength > maxBytes) throw new MediaLimitError();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MediaLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export type ByteRange = { start: number; end: number };

export function parseByteRange(rangeHeader: string | null, total: number): ByteRange | null | "invalid" {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2]) || total <= 0) return "invalid";

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2]!, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "invalid";
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
    end = Math.min(end, total - 1);
  }
  return start < 0 || start > end || start >= total ? "invalid" : { start, end };
}
