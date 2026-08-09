import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { imageStore } from "@/lib/imageStore";
import * as webDavStore from "@/lib/imageStoreWebdav";
import * as r2Store from "@/lib/imageStoreR2";
import { guardedFetch } from "@/lib/remoteUrlGuard";
import {
  isSupportedMediaType,
  MediaLimitError,
  normalizeContentType,
  readBodyWithLimit,
  sniffMediaType,
} from "@/lib/media";
import { hasRequestRole, unauthorizedResponse } from "@/lib/requestAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function configuredMaxBytes(): number {
  const parsed = Number.parseInt(process.env.MEDIA_MAX_FILE_BYTES || "", 10);
  return Number.isFinite(parsed) ? Math.max(1024, Math.min(100 * 1024 * 1024, parsed)) : 20 * 1024 * 1024;
}

function declaredLength(headers: Headers): number | null {
  const parsed = Number.parseInt(headers.get("content-length") || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function webDavConfigured(): boolean {
  return Boolean(
    process.env.WEBDAV_URL &&
    process.env.WEBDAV_USERNAME &&
    (process.env.WEBDAV_PASSWORD || process.env.WEBDAV_TOKEN),
  );
}

async function readUpload(req: NextRequest, maxBytes: number): Promise<Buffer> {
  const contentType = normalizeContentType(req.headers.get("content-type"));
  if (contentType === "application/json") {
    const encoded = await readBodyWithLimit(req.body, 8 * 1024, declaredLength(req.headers));
    const body = (() => {
      try {
        return JSON.parse(encoded.toString("utf8")) as { url?: unknown };
      } catch {
        return null;
      }
    })();
    const remoteUrl = typeof body?.url === "string" ? body.url.trim() : "";
    if (!remoteUrl || remoteUrl.length > 2_048) throw new Error("A valid media URL is required");
    const response = await guardedFetch(remoteUrl, {
      method: "GET",
      headers: { accept: "image/*,video/*;q=0.9" },
    });
    if (!response.ok || !response.body) throw new Error("The remote media could not be downloaded");
    return readBodyWithLimit(response.body, maxBytes, declaredLength(response.headers));
  }

  if (contentType !== "application/octet-stream" && !contentType.startsWith("image/") && !contentType.startsWith("video/")) {
    throw new TypeError("Unsupported request content type");
  }
  return readBodyWithLimit(req.body, maxBytes, declaredLength(req.headers));
}

async function validateAndOptimize(input: Buffer, contentType: string): Promise<{ buffer: Buffer; contentType: string }> {
  if (!contentType.startsWith("image/")) return { buffer: input, contentType };

  const maxPixels = Number.parseInt(process.env.MEDIA_MAX_INPUT_PIXELS || "", 10) || 40_000_000;
  await sharp(input, { failOn: "warning", limitInputPixels: maxPixels }).metadata();
  if (process.env.MEDIA_COMPRESS !== "1" || !["image/jpeg", "image/avif"].includes(contentType)) {
    return { buffer: input, contentType };
  }

  const quality = Math.max(35, Math.min(95, Number.parseInt(process.env.MEDIA_COMPRESS_QUALITY || "82", 10)));
  const format = (process.env.MEDIA_COMPRESS_FORMAT || "").trim().toLowerCase();
  const pipeline = sharp(input, { failOn: "warning", limitInputPixels: maxPixels }).rotate();
  if (format === "webp") {
    return { buffer: await pipeline.webp({ quality, smartSubsample: true }).toBuffer(), contentType: "image/webp" };
  }
  if (format === "avif") {
    return { buffer: await pipeline.avif({ quality: Math.min(70, quality), effort: 4 }).toBuffer(), contentType: "image/avif" };
  }
  return { buffer: await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer(), contentType: "image/jpeg" };
}

export async function POST(req: NextRequest) {
  if (!hasRequestRole(req, "editor")) return unauthorizedResponse();

  const maxBytes = configuredMaxBytes();
  if ((declaredLength(req.headers) || 0) > maxBytes) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  try {
    const uploaded = await readUpload(req, maxBytes);
    if (!uploaded.length) return NextResponse.json({ error: "empty_payload" }, { status: 400 });
    const detectedType = sniffMediaType(uploaded);
    if (!detectedType || !isSupportedMediaType(detectedType)) {
      return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
    }

    const optimized = await validateAndOptimize(uploaded, detectedType);
    if (optimized.buffer.byteLength > maxBytes) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }

    const useR2 = r2Store.isR2Configured();
    const useWebDav = !useR2 && webDavConfigured();
    let stored: { id: string; size: number; contentType: string; urlPath?: string; ttlMs?: number };
    let storage: "memory" | "webdav" | "r2";

    if (useR2) {
      stored = await r2Store.put(optimized.buffer, optimized.contentType);
      storage = "r2";
    } else if (useWebDav) {
      stored = await webDavStore.put(optimized.buffer, optimized.contentType);
      storage = "webdav";
    } else {
      stored = imageStore.put(optimized.buffer, optimized.contentType);
      storage = "memory";
    }

    const mediaPath = stored.urlPath || `/api/media/${encodeURIComponent(stored.id)}`;
    return NextResponse.json({
      id: stored.id,
      path: mediaPath,
      url: mediaPath,
      size: stored.size,
      contentType: stored.contentType,
      storage,
      ttlMs: storage === "memory" && stored.ttlMs !== Infinity ? stored.ttlMs ?? null : null,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof MediaLimitError) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ error: "unsupported_content_type" }, { status: 415 });
    }
    console.error("[media] upload failed", error);
    return NextResponse.json({ error: "upload_failed" }, { status: 400 });
  }
}
