import { redirect } from "next/navigation";
import WhiteboardClient from "@/app/whiteboard/WhiteboardClient";
import TransparentBoardStyles from "@/app/whiteboard/TransparentBoardStyles";
import { createSocketToken, verifyViewKey } from "@/lib/authCore.mjs";
export const dynamic = "force-dynamic";

export default async function ViewerPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!key || !verifyViewKey(key)) {
    redirect("/?error=invalid");
  }
  const name = "Viewer";
  const socketToken = createSocketToken("viewer", name) || undefined;
  return (
    <div className="w-full h-screen">
      <TransparentBoardStyles />
      <WhiteboardClient name={name} readOnly socketToken={socketToken} />
    </div>
  );
}
