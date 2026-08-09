import { NextRequest, NextResponse } from "next/server";
import { guardedFetch, isWhitelistedContentType } from "@/lib/remoteUrlGuard";
import { hasRequestRole, unauthorizedResponse } from "@/lib/requestAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!hasRequestRole(req, "viewer")) return unauthorizedResponse();
  const remoteUrl = (req.nextUrl.searchParams.get("url") || "").trim();
  if (!remoteUrl || remoteUrl.length > 2_048) return new NextResponse("invalid url", { status: 400 });

  try {
    const upstream = await guardedFetch(remoteUrl, {
      method: "GET",
      headers: {
        ...(req.headers.get("range") ? { range: req.headers.get("range")! } : {}),
        accept: "image/*,video/*;q=0.9",
      },
    });
    if (!upstream.ok || !upstream.body) {
      return new NextResponse("upstream error", { status: 502, headers: { "cache-control": "no-store" } });
    }

    const contentType = upstream.headers.get("content-type");
    if (!isWhitelistedContentType(contentType)) {
      await upstream.body.cancel().catch(() => undefined);
      return new NextResponse("unsupported content type", { status: 415, headers: { "cache-control": "no-store" } });
    }

    const maxBytes = Number.parseInt(process.env.MEDIA_PROXY_MAX_BYTES || "", 10) || 50 * 1024 * 1024;
    const declaredLength = Number.parseInt(upstream.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await upstream.body.cancel().catch(() => undefined);
      return new NextResponse("remote media is too large", { status: 413, headers: { "cache-control": "no-store" } });
    }

    let streamedBytes = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        streamedBytes += chunk.byteLength;
        if (streamedBytes > maxBytes) {
          controller.error(new Error("remote media is too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const headers = new Headers({
      "cache-control": "private, max-age=600",
      "content-disposition": "inline",
      "content-type": contentType!,
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    });
    for (const name of ["accept-ranges", "content-range"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (Number.isFinite(declaredLength)) headers.set("content-length", String(declaredLength));
    return new NextResponse(upstream.body.pipeThrough(limiter), { status: upstream.status, headers });
  } catch (error) {
    console.warn("[media] proxy request rejected", error instanceof Error ? error.message : "unknown error");
    return new NextResponse("proxy failed", { status: 502, headers: { "cache-control": "no-store" } });
  }
}
