import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { imageStore } from "@/lib/imageStore";
import * as r2Store from "@/lib/imageStoreR2";
import {
  basePath,
  createReadStream,
  getWebDavClient,
  readFile as readWebDavFile,
} from "@/lib/webdavClient.mjs";
import {
  contentTypeFromId,
  isSafeMediaId,
  parseByteRange,
} from "@/lib/media";
import { hasRequestRole, unauthorizedResponse } from "@/lib/requestAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function webDavConfigured(): boolean {
  return Boolean(
    process.env.WEBDAV_URL &&
    process.env.WEBDAV_USERNAME &&
    (process.env.WEBDAV_PASSWORD || process.env.WEBDAV_TOKEN),
  );
}

function baseHeaders(id: string, contentType: string): Headers {
  return new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "content-disposition": `inline; filename="${id}"`,
    "content-type": contentType,
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  });
}

function rangeError(total?: number): NextResponse {
  return new NextResponse("range not satisfiable", {
    status: 416,
    headers: {
      "cache-control": "no-store",
      ...(typeof total === "number" ? { "content-range": `bytes */${total}` } : {}),
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!hasRequestRole(req, "viewer")) return unauthorizedResponse();
  const { id } = await params;
  if (!isSafeMediaId(id)) return new NextResponse("not found", { status: 404 });

  if (r2Store.isR2Configured()) {
    try {
      const object = await r2Store.get(id, req.headers.get("range") ? { range: req.headers.get("range")! } : {});
      if (!object) return new NextResponse("not found", { status: 404, headers: { "cache-control": "no-store" } });
      const headers = baseHeaders(id, object.contentType || contentTypeFromId(id));
      if (object.contentRange) headers.set("content-range", object.contentRange);
      if (typeof object.contentLength === "number") headers.set("content-length", String(object.contentLength));
      if (object.lastModified) headers.set("last-modified", object.lastModified.toUTCString());
      return new NextResponse(object.stream, {
        status: req.headers.has("range") && object.contentRange ? 206 : 200,
        headers,
      });
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      return status === 416 ? rangeError() : new NextResponse("media read failed", { status: 502 });
    }
  }

  if (webDavConfigured()) {
    const remotePath = `${basePath()}/media/${id}`;
    try {
      const stat = await getWebDavClient().stat(remotePath);
      const total = Number(stat?.size || 0);
      if (!total) return new NextResponse("not found", { status: 404, headers: { "cache-control": "no-store" } });
      const parsedRange = parseByteRange(req.headers.get("range"), total);
      if (parsedRange === "invalid") return rangeError(total);
      const headers = baseHeaders(id, contentTypeFromId(id));

      if (parsedRange) {
        const { start, end } = parsedRange;
        headers.set("content-range", `bytes ${start}-${end}/${total}`);
        headers.set("content-length", String(end - start + 1));
        try {
          const stream = createReadStream(remotePath, { start, end });
          const webStream = stream instanceof Readable
            ? Readable.toWeb(stream) as ReadableStream<Uint8Array>
            : stream as unknown as ReadableStream<Uint8Array>;
          return new NextResponse(webStream, { status: 206, headers });
        } catch {
          const buffer = await readWebDavFile(remotePath);
          if (!buffer) return new NextResponse("not found", { status: 404 });
          return new NextResponse(new Uint8Array(buffer.subarray(start, end + 1)), { status: 206, headers });
        }
      }

      const buffer = await readWebDavFile(remotePath);
      if (!buffer) return new NextResponse("not found", { status: 404 });
      headers.set("content-length", String(buffer.length));
      return new NextResponse(new Uint8Array(buffer), { headers });
    } catch (error) {
      const status = (error as { status?: number; response?: { status?: number } })?.status ||
        (error as { response?: { status?: number } })?.response?.status;
      return status === 404
        ? new NextResponse("not found", { status: 404 })
        : new NextResponse("media read failed", { status: 502 });
    }
  }

  const item = imageStore.get(id);
  if (!item) return new NextResponse("gone", { status: 410, headers: { "cache-control": "no-store" } });
  const parsedRange = parseByteRange(req.headers.get("range"), item.size);
  if (parsedRange === "invalid") return rangeError(item.size);
  const headers = baseHeaders(id, item.contentType);
  if (parsedRange) {
    const { start, end } = parsedRange;
    const chunk = item.data.subarray(start, end + 1);
    headers.set("content-range", `bytes ${start}-${end}/${item.size}`);
    headers.set("content-length", String(chunk.length));
    return new NextResponse(new Uint8Array(chunk), { status: 206, headers });
  }
  headers.set("content-length", String(item.size));
  return new NextResponse(new Uint8Array(item.data), { headers });
}
