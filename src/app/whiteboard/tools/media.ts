import { MutableRef } from "../services/animation";
import { BOARD_W, BOARD_H } from "../constants";
import { ImageCommitEvent, HistoryEvent, Tool, CommittedImage } from "../types";
export type MediaToolDeps = {
  id: string;
  toolRef: MutableRef<Tool>;
  readOnlyRef: MutableRef<boolean>;
  containerRef: MutableRef<HTMLDivElement | null>;
  areaRef: MutableRef<HTMLDivElement | null>;
  pendingImageRef: MutableRef<null | { src: string; naturalW: number; naturalH: number; kind?: "image" | "video"; animated?: boolean; origin?: 'link' | 'upload' }>;
  imagePreviewRef: MutableRef<null | { x: number; y: number; scale: number }>;
  sendCritical: (m: ImageCommitEvent) => void;
  historyRef: MutableRef<HistoryEvent[]>;
  myStrokesRef: MutableRef<string[]>;
  committedImagesRef: MutableRef<Map<string, CommittedImage>>;
  setSelectedImageId: (id: string | null) => void;
  setSelectedTextId: (id: string | null) => void;
  setTool: (t: Tool) => void;
  forceTick: (updater: (n: number) => number) => void;
  screenToBoardNorm: (x: number, y: number) => { x: number; y: number };
};
export function attachMediaTool(deps: MediaToolDeps) {
  const {
    id,
    toolRef,
    readOnlyRef,
    containerRef,
    areaRef,
    pendingImageRef,
    imagePreviewRef,
    sendCritical,
    historyRef,
    myStrokesRef,
    committedImagesRef,
    setSelectedImageId,
    setSelectedTextId,
    setTool,
    forceTick,
    screenToBoardNorm,
  } = deps;
  const container = containerRef.current;
  const area = areaRef.current;
  const onDown = (e: PointerEvent) => {
    if (readOnlyRef.current || toolRef.current !== "media") return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest('[data-ui-panel]')) return;
    if ((e as PointerEvent).button !== 0) return;
    const pending = pendingImageRef.current;
    if (!pending) return;
    const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
    let scale = imagePreviewRef.current?.scale ?? 1;
    const minPx = 10;
    const pxW0 = pending.naturalW * scale;
    const pxH0 = pending.naturalH * scale;
    if (pxW0 < minPx || pxH0 < minPx) {
      const k = Math.max(minPx / Math.max(1, pending.naturalW), minPx / Math.max(1, pending.naturalH));
      scale = Math.max(scale, k);
    }
    let w = (pending.naturalW * scale) / BOARD_W;
    let h = (pending.naturalH * scale) / BOARD_H;
    if (w > 1 || h > 1) {
      const s = Math.min(1 / w, 1 / h);
      w *= s; h *= s;
    }
    w = Math.max(10 / BOARD_W, w);
    h = Math.max(10 / BOARD_H, h);
    const imageId = `${id}-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const strokeId = `${id}-image-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const origin: 'link' | 'upload' = pending.origin === 'link' ? 'link' : 'upload';
  const commit: ImageCommitEvent = { type: "image_commit", id, imageId, src: pending.src, x: nx, y: ny, width: w, height: h, strokeId, filter: "none", rotX: 0, rotY: 0, rotZ: 0, mediaKind: pending.kind || 'image', animated: pending.animated, origin };
    setTimeout(() => sendCritical(commit), 0);
    historyRef.current.push(commit);
    myStrokesRef.current.push(strokeId);
  committedImagesRef.current.set(imageId, { imageId, x: nx, y: ny, width: w, height: h, src: pending.src, strokeId, naturalW: pending.naturalW, naturalH: pending.naturalH, aspect: pending.naturalW / Math.max(1e-6, pending.naturalH), filter: "none", rotX: 0, rotY: 0, rotZ: 0, mediaKind: pending.kind || 'image', animated: pending.animated, origin });
    setSelectedImageId(imageId);
    setSelectedTextId(null);
    setTool("select");
    forceTick(t => t + 1);
    pendingImageRef.current = null;
    imagePreviewRef.current = null;
  };
  const onMove = (e: PointerEvent) => {
    if (readOnlyRef.current || toolRef.current !== "media") return;
    if (!pendingImageRef.current) return;
    const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
    if (!imagePreviewRef.current) imagePreviewRef.current = { x: nx, y: ny, scale: 1 };
    else { imagePreviewRef.current.x = nx; imagePreviewRef.current.y = ny; }
    forceTick(t => t + 1);
  };
  const onWheel = (e: WheelEvent) => {
    if (readOnlyRef.current || toolRef.current !== "media") return;
    if (!pendingImageRef.current) return;
    if (!imagePreviewRef.current) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    const prev = imagePreviewRef.current.scale;
    let next = Math.max(0.05, Math.min(8, prev * factor));
    const pending = pendingImageRef.current;
    if (pending) {
      const pxW = (pending.naturalW * next);
      const pxH = (pending.naturalH * next);
      const minPx = 10;
      if (pxW < minPx || pxH < minPx) {
        const k = Math.max(minPx / Math.max(1, pending.naturalW), minPx / Math.max(1, pending.naturalH));
        next = Math.max(next, k);
      }
    }
    imagePreviewRef.current.scale = next;
    forceTick(t => t + 1);
  };
  const onKey = (e: KeyboardEvent) => {
    if (toolRef.current === "media" && e.key === "Escape") {
      imagePreviewRef.current = null;
      pendingImageRef.current = null;
      forceTick(t => t + 1);
    }
  };
  const cleanups: (() => void)[] = [];
  if (container) {
    container.addEventListener("pointerdown", onDown);
    cleanups.push(() => container.removeEventListener("pointerdown", onDown));
  }
  if (area) {
    area.addEventListener("pointermove", onMove, { passive: true });
    area.addEventListener("wheel", onWheel, { passive: false });
    cleanups.push(() => area.removeEventListener("pointermove", onMove));
    cleanups.push(() => area.removeEventListener("wheel", onWheel));
  }
  window.addEventListener("keydown", onKey);
  cleanups.push(() => window.removeEventListener("keydown", onKey));
  return () => cleanups.forEach(fn => { try { fn(); } catch {} });
}
