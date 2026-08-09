import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import WhiteboardClient from "./WhiteboardClient";
import { AUTH_COOKIE_NAME, createSocketToken, verifyAuthToken } from "@/lib/authCore.mjs";
export const dynamic = "force-dynamic";
export default async function Whiteboard() {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value || "";
  const session = verifyAuthToken(token);
  if (!session) redirect("/");
  const displayName = session.name;
  const socketToken = createSocketToken("editor", displayName) || undefined;
  return (
    <div className="w-full h-screen">
      <WhiteboardClient name={displayName} socketToken={socketToken} />
    </div>
  );
}
