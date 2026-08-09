import NextImage from "next/image";
import { memo } from "react";
import type { Tool } from "../types";
const TOOL_ICON_FILES: Record<Tool, string> = {
  select: "/icons/tool-select.svg",
  hand: "/icons/tool-hand.svg",
  pen: "/icons/tool-pen.svg",
  eraser: "/icons/tool-eraser.svg",
  text: "/icons/tool-text.svg",
  media: "/icons/tool-media.svg",
};
type IconCacheEntry =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; image: HTMLImageElement };
const iconCache = new Map<Tool, IconCacheEntry>();
export const ToolIcon = memo(function ToolIcon({ tool, className, title }: { tool: Tool; className?: string; title?: string }) {
  const src = TOOL_ICON_FILES[tool];
  return (
    <NextImage
      src={src}
      alt={title ?? TOOL_LABELS[tool]}
      className={className}
      data-tool-icon
      draggable={false}
      width={16}
      height={16}
      unoptimized
    />
  );
});
export function ensureToolIconImage(tool: Tool, onReady?: () => void): HTMLImageElement | null {
  if (typeof window === "undefined") return null;
  const cached = iconCache.get(tool);
  if (cached?.status === "loaded") return cached.image;
  if (cached?.status === "loading") return null;
  const img = new globalThis.Image();
  iconCache.set(tool, { status: "loading" });
  img.onload = () => {
    iconCache.set(tool, { status: "loaded", image: img });
    onReady?.();
  };
  img.onerror = () => {
    iconCache.set(tool, { status: "error" });
  };
  img.src = TOOL_ICON_FILES[tool];
  return null;
}
export const TOOL_LABELS: Record<Tool, string> = {
  select: "Select",
  hand: "Pan",
  pen: "Pen",
  eraser: "Eraser",
  text: "Text",
  media: "Media",
};
export const TOOL_BADGE_BG: Record<Tool, string> = {
  select: "#3b82f6",
  hand: "#f59e0b",
  pen: "#6366f1",
  eraser: "#ef4444",
  text: "#0ea5e9",
  media: "#10b981",
};
