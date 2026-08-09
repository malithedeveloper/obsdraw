import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/authCore.mjs";

export function POST() {
  const response = NextResponse.json(
    { status: "signed_out" },
    { headers: { "cache-control": "no-store" } },
  );
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
