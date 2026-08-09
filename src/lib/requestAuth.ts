import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE_NAME,
  verifyAuthToken,
  verifySocketToken,
} from "./authCore.mjs";

type RequestIdentity = {
  role: "editor" | "viewer";
  name: string;
};

function parseCookieHeader(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name || name in cookies) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

function requestToken(req: NextRequest): string {
  const authorization = req.headers.get("authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  if (bearer) return bearer;
  if (req.method === "GET" || req.method === "HEAD") {
    return req.nextUrl.searchParams.get("access_token")?.trim() || "";
  }
  return "";
}

function requestIdentity(req: NextRequest): RequestIdentity | null {
  const token = requestToken(req);
  const socketIdentity = verifySocketToken(token);
  if (socketIdentity) return { role: socketIdentity.role, name: socketIdentity.name };

  const cookies = parseCookieHeader(req.headers.get("cookie"));
  const session = verifyAuthToken(cookies[AUTH_COOKIE_NAME] || "");
  return session ? { role: "editor", name: session.name } : null;
}

export function hasRequestRole(req: NextRequest, requiredRole: "editor" | "viewer"): boolean {
  const identity = requestIdentity(req);
  if (!identity) return false;
  return requiredRole === "viewer" || identity.role === "editor";
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: "unauthorized" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}
