import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import WhiteboardClient from "./whiteboard/WhiteboardClient";
import TransparentBoardStyles from "./whiteboard/TransparentBoardStyles";
import Image from "next/image";
import { Metadata } from "next";
import {
  AUTH_COOKIE_NAME,
  AUTH_MAX_AGE_SECONDS,
  createAuthToken,
  createSocketToken,
  sanitizeDisplayName,
  verifyAccessKey,
  verifyViewKey,
} from "@/lib/authCore.mjs";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "OBSdraw | Sign in",
  description: "Secure access to your collaborative OBS whiteboard",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; view?: string }>;
}) {
  const { error, view } = await searchParams;
  const hasError = error === "invalid";
  const nameTaken = error === "name_taken";
  const viewKeyRaw = (view || "").toString();
  if (viewKeyRaw) {
    if (verifyViewKey(viewKeyRaw)) {
      const socketToken = createSocketToken("viewer", "Viewer") || undefined;
      return (
        <div className="w-full h-screen bg-transparent">
          <TransparentBoardStyles />
          <WhiteboardClient name="Viewer" readOnly socketToken={socketToken} />
        </div>
      );
    }
  }
  async function authenticate(formData: FormData) {
    "use server";
    const name = sanitizeDisplayName(formData.get("name"));
    const key = (formData.get("key") || "").toString();
    if (!verifyAccessKey(key)) redirect("/?error=invalid");
    const authToken = createAuthToken(name);
    if (!authToken) redirect("/?error=invalid");
    const cookieStore = await cookies();
    cookieStore.set(AUTH_COOKIE_NAME, authToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: AUTH_MAX_AGE_SECONDS,
    });
    redirect(`/whiteboard`);
  }
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-zinc-100 px-6 py-10 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="w-full max-w-md border border-zinc-300 bg-white p-8 rounded-none dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-8 flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center border border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950">
            <Image
              src="/obsdraw-logo.webp"
              alt="OBSdraw logo"
              width={44}
              height={44}
              priority
              className="h-11 w-11 object-contain"
            />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Enter your display name and access key.</p>
          </div>
        </div>

        <form action={authenticate} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="name" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Display name</label>
            <input
              id="name"
              name="name"
              type="text"
              placeholder="Your name"
              autoComplete="nickname"
              className={`w-full border bg-white px-3 py-2 outline-none transition focus:border-zinc-600 dark:bg-zinc-950 ${nameTaken ? "border-red-500 focus:border-red-500" : "border-zinc-300 dark:border-zinc-700"}`}
              required
            />
            {nameTaken && <p className="text-sm text-red-600">That name is already in use. Try another one.</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="key" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Access key</label>
            <input
              id="key"
              name="key"
              type="password"
              placeholder="Enter your access key"
              autoComplete="current-password"
              className={`w-full border bg-white px-3 py-2 outline-none transition focus:border-zinc-600 dark:bg-zinc-950 ${hasError ? "border-red-500 focus:border-red-500" : "border-zinc-300 dark:border-zinc-700"}`}
              required
            />
            {hasError && <p className="text-sm text-red-600">The access key is invalid. Please try again.</p>}
          </div>

          <button
            type="submit"
            className="w-full border border-zinc-900 bg-zinc-900 px-4 py-2.5 font-semibold text-white transition hover:bg-zinc-800 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            Open whiteboard
          </button>
        </form>
        <p className="mt-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
          AGPL-3.0 licensed. <a className="underline hover:text-zinc-800 dark:hover:text-zinc-200" href={process.env.NEXT_PUBLIC_SOURCE_URL || "https://github.com/malithedeveloper/obsdraw"}>View source code</a>.
        </p>
      </div>
    </div>
  );
}
