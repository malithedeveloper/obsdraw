import { NextRequest, NextResponse } from "next/server";
import { guardedFetch, isWhitelistedContentType, tryParseUrl } from "@/lib/remoteUrlGuard";
import { guessContentTypeFromUrl, readBodyWithLimit } from "@/lib/media";
import { hasRequestRole, unauthorizedResponse } from "@/lib/requestAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USER_AGENT = "Mozilla/5.0 (compatible; OBSdraw/1.0; +https://github.com/malithedeveloper/obsdraw)";

function mediaMetadataCandidates(html: string, baseUrl: string): string[] {
  const values = new Map<string, string>();
  const tags = html.match(/<meta\b[^>]*>/gi)?.slice(0, 2_000) || [];
  for (const tag of tags) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) {
      attributes.set(match[1]!.toLowerCase(), match[2]!);
    }
    const key = (attributes.get("property") || attributes.get("name") || "").toLowerCase();
    const content = attributes.get("content");
    if (key && content) values.set(key, content);
  }

  const rawCandidates = [
    values.get("og:video:secure_url"),
    values.get("og:video:url"),
    values.get("og:video"),
    values.get("twitter:player:stream"),
    values.get("og:image:secure_url"),
    values.get("og:image"),
  ];
  const candidates: string[] = [];
  for (const candidate of rawCandidates) {
    if (!candidate) continue;
    try {
      const absolute = new URL(candidate, baseUrl).toString();
      if (!candidates.includes(absolute)) candidates.push(absolute);
    } catch {
      // Ignore malformed metadata URLs.
    }
  }
  return candidates;
}

async function supportedRemote(url: string): Promise<{ url: string; contentType: string } | null> {
  const response = await guardedFetch(url, {
    method: "HEAD",
    headers: { "user-agent": USER_AGENT, accept: "image/*,video/*;q=0.9" },
  }).catch(() => null);
  const contentType = response?.headers.get("content-type") || "";
  return response?.ok && isWhitelistedContentType(contentType)
    ? { url: response.url || url, contentType }
    : null;
}

export async function GET(req: NextRequest) {
  if (!hasRequestRole(req, "editor")) return unauthorizedResponse();
  const remoteUrl = (req.nextUrl.searchParams.get("url") || "").trim();
  const parsed = tryParseUrl(remoteUrl);
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || remoteUrl.length > 2_048) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  try {
    const direct = await supportedRemote(parsed.toString());
    if (direct) return NextResponse.json(direct);

    const response = await guardedFetch(parsed.toString(), {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        range: "bytes=0-524287",
        accept: "text/html,application/xhtml+xml,image/*,video/*;q=0.9",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && isWhitelistedContentType(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      return NextResponse.json({ url: response.url || parsed.toString(), contentType });
    }

    const normalizedType = contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (!response.ok || !["text/html", "application/xhtml+xml"].includes(normalizedType)) {
      await response.body?.cancel().catch(() => undefined);
      const guessed = guessContentTypeFromUrl(parsed.toString());
      return guessed
        ? NextResponse.json({ url: parsed.toString(), contentType: guessed })
        : NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
    }

    const body = await readBodyWithLimit(response.body, 500_000, Number(response.headers.get("content-length")) || null);
    for (const candidate of mediaMetadataCandidates(body.toString("utf8"), response.url || parsed.toString())) {
      const candidateUrl = tryParseUrl(candidate);
      if (!candidateUrl || !["http:", "https:"].includes(candidateUrl.protocol)) continue;
      const resolved = await supportedRemote(candidateUrl.toString());
      if (resolved) return NextResponse.json(resolved);
    }

    return NextResponse.json({ error: "media_not_found" }, { status: 404 });
  } catch (error) {
    console.warn("[media] resolution failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "resolve_failed" }, { status: 502 });
  }
}
