import type { Metadata, Viewport } from "next";
import "./globals.css";
import ZoomBlocker from "@/app/zoom-blocker";
export const metadata: Metadata = {
  title: "OBSdraw",
  description: "A collaborative whiteboard built for transparent OBS browser sources",
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <ZoomBlocker />
        {children}
      </body>
    </html>
  );
}
