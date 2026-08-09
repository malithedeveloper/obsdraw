import { NextRequest, NextResponse } from "next/server";
import { imageStore } from "@/lib/imageStore";
import * as r2Store from "@/lib/imageStoreR2";
import { basePath as webDavBasePath, exists as webDavExists } from "@/lib/webdavClient.mjs";
import { contentTypeFromId } from "@/lib/media";
import { hasRequestRole, unauthorizedResponse } from "@/lib/requestAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const lookupCache = new Map<string, { id: string; contentType: string; at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm", ""];

function webDavConfigured(): boolean {
  return Boolean(
    process.env.WEBDAV_URL &&
    process.env.WEBDAV_USERNAME &&
    (process.env.WEBDAV_PASSWORD || process.env.WEBDAV_TOKEN),
  );
}

function responseFor(id: string, contentType: string) {
  const path = `/api/media/${encodeURIComponent(id)}`;
  return NextResponse.json({ exists: true, path, url: path, contentType });
}

export async function GET(req: NextRequest) {
  if (!hasRequestRole(req, "editor")) return unauthorizedResponse();
  const hash = (req.nextUrl.searchParams.get("hash") || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return NextResponse.json({ error: "invalid_hash" }, { status: 400 });
  }

  try {
    const cached = lookupCache.get(hash);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return responseFor(cached.id, cached.contentType);

    if (r2Store.isR2Configured()) {
      const found = await r2Store.headByHash(hash);
      if (!found) return NextResponse.json({ exists: false });
      lookupCache.set(hash, { ...found, at: Date.now() });
      return responseFor(found.id, found.contentType);
    }

    if (webDavConfigured()) {
      const mediaRoot = `${webDavBasePath()}/media`;
      const probes = EXTENSIONS.map(async (extension) => {
        const id = extension ? `${hash}.${extension}` : hash;
        if (!(await webDavExists(`${mediaRoot}/${id}`))) throw new Error("not_found");
        return id;
      });
      const id = await Promise.any(probes).catch(() => null);
      if (!id) return NextResponse.json({ exists: false });
      const contentType = contentTypeFromId(id);
      lookupCache.set(hash, { id, contentType, at: Date.now() });
      return responseFor(id, contentType);
    }

    const item = imageStore.getByHash(hash);
    return item ? responseFor(item.id, item.contentType) : NextResponse.json({ exists: false });
  } catch (error) {
    console.error("[media] lookup failed", error);
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
}
