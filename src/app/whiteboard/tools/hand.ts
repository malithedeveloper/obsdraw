import { MutableRef } from "../services/animation";
import { BOARD_W, BOARD_H } from "../constants";
import { Tool } from "../types";
export type HandToolDeps = {
  toolRef: MutableRef<Tool>;
  readOnlyRef: MutableRef<boolean>;
  areaRef: MutableRef<HTMLDivElement | null>;
  panRef: MutableRef<{ x: number; y: number }>;
  scaleRef: MutableRef<number>;
  setViewTransform: (v: { x: number; y: number; s: number }) => void;
  panDragRef: MutableRef<null | { startX: number; startY: number; origX: number; origY: number }>;
  panOverrideRef: MutableRef<boolean>;
  marqueeRef: MutableRef<null | { start: { x: number; y: number }; end: { x: number; y: number } }>;
  committedTextsRef: MutableRef<Map<string, { textId: string; x: number; y: number; width?: number; height?: number; text: string; color: string; size: number; font: string }>>;
  committedImagesRef: MutableRef<Map<string, { imageId: string; x: number; y: number; width: number; height: number }>>;
  setSelectedTextId: (id: string | null) => void;
  setSelectedImageId: (id: string | null) => void;
  setSelectedTextIds: (ids: string[]) => void;
  setSelectedImageIds: (ids: string[]) => void;
  screenToBoardNorm: (x: number, y: number) => { x: number; y: number };
  forceTick: (updater: (n: number) => number) => void;
};
export function attachHandTool(deps: HandToolDeps) {
  const {
    toolRef,
    readOnlyRef,
    areaRef,
    panRef,
    scaleRef,
    setViewTransform,
    panDragRef,
    panOverrideRef,
    marqueeRef,
    committedTextsRef,
    committedImagesRef,
    setSelectedTextId,
    setSelectedImageId,
    setSelectedTextIds,
    setSelectedImageIds,
    screenToBoardNorm,
    forceTick,
  } = deps;
  const area = areaRef.current;
  if (!area) return () => {};
  const onDown = (e: PointerEvent) => {
    if (readOnlyRef.current) return;
    if (!(toolRef.current === "hand" || panOverrideRef.current || e.button === 1)) return;
    if (toolRef.current === "select" && panOverrideRef.current) {
      const pos = screenToBoardNorm(e.clientX, e.clientY);
      marqueeRef.current = { start: pos, end: pos };
      setSelectedTextId(null); setSelectedImageId(null);
      setSelectedTextIds([]); setSelectedImageIds([]);
    }
    panDragRef.current = { startX: e.clientX, startY: e.clientY, origX: panRef.current.x, origY: panRef.current.y };
    try { (e.target as Element | null)?.setPointerCapture?.(e.pointerId); } catch {}
  };
  const onMove = (e: PointerEvent) => {
    if (!panDragRef.current) return;
    const dx = e.clientX - panDragRef.current.startX;
    const dy = e.clientY - panDragRef.current.startY;
    const nx = panDragRef.current.origX + dx;
    const ny = panDragRef.current.origY + dy;
    panRef.current = { x: nx, y: ny };
    setViewTransform({ x: nx, y: ny, s: scaleRef.current });
    if (toolRef.current === "select" && panOverrideRef.current && marqueeRef.current) {
      marqueeRef.current.end = screenToBoardNorm(e.clientX, e.clientY);
      forceTick(t => t + 1);
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!panDragRef.current) return;
    panDragRef.current = null;
    if (toolRef.current === "select" && marqueeRef.current) {
      const m = marqueeRef.current;
      marqueeRef.current = null;
      const minX = Math.min(m.start.x, m.end.x);
      const minY = Math.min(m.start.y, m.end.y);
      const maxX = Math.max(m.start.x, m.end.x);
      const maxY = Math.max(m.start.y, m.end.y);
      const pickedTexts: string[] = [];
      for (const v of committedTextsRef.current.values()) {
        const w = (v.width ?? Math.max(10 / BOARD_W, (v.text.length * (v.size * 0.6)) / BOARD_W));
        const h = (v.height ?? Math.max(10 / BOARD_H, (v.size * 1.2) / BOARD_H));
        const l = v.x; const t = v.y; const r = v.x + w; const b = v.y + h;
        const intersects = !(r < minX || l > maxX || b < minY || t > maxY);
        if (intersects) pickedTexts.push(v.textId);
      }
      const pickedImages: string[] = [];
      for (const v of committedImagesRef.current.values()) {
        const l = v.x; const t = v.y; const r = v.x + v.width; const b = v.y + v.height;
        const intersects = !(r < minX || l > maxX || b < minY || t > maxY);
        if (intersects) pickedImages.push(v.imageId);
      }
      setSelectedTextIds(pickedTexts);
      setSelectedImageIds(pickedImages);
      setSelectedTextId(pickedTexts.length === 1 && pickedImages.length === 0 ? pickedTexts[0] : null);
      setSelectedImageId(pickedImages.length === 1 && pickedTexts.length === 0 ? pickedImages[0] : null);
      forceTick(t => t + 1);
    }
    try { (e.target as Element | null)?.releasePointerCapture?.(e.pointerId); } catch {}
  };
  const onContextMenu = (e: MouseEvent) => {
    if (panDragRef.current) { e.preventDefault(); }
  };
  area.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("contextmenu", onContextMenu);
  return () => {
    area.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("contextmenu", onContextMenu);
  };
}
