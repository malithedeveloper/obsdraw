import { MutableRef } from "../services/animation";
import { BOARD_W, BOARD_H } from "../constants";
import { ChromaConfig, CursorPayload, StrokePayload, Tool } from "../types";
export type PenToolDeps = {
  id: string;
  name: string;
  toolRef: MutableRef<Tool>;
  readOnlyRef: MutableRef<boolean>;
  areaRef: MutableRef<HTMLDivElement | null>;
  boardRef: MutableRef<HTMLCanvasElement | null>;
  penSizeRef: MutableRef<number>;
  eraserSizeRef: MutableRef<number>;
  penColorRef: MutableRef<string>;
  penChromaRef: MutableRef<ChromaConfig>;
  chromaColor: (c: ChromaConfig) => string;
  screenToBoardNorm: (x: number, y: number) => { x: number; y: number };
  sendCritical: (m: StrokePayload | CursorPayload) => void;
};
export function attachPenAndEraser(deps: PenToolDeps) {
  const {
    id,
    name,
    toolRef,
    readOnlyRef,
    areaRef,
    boardRef,
    penSizeRef,
    eraserSizeRef,
    penColorRef,
    penChromaRef,
    chromaColor,
    screenToBoardNorm,
    sendCritical,
  } = deps;
  const isDrawing = { current: false } as MutableRef<boolean>;
  const lastPoint = { current: null as { x: number; y: number } | null } as MutableRef<{ x: number; y: number } | null>;
  const currentStrokeIdRef = { current: null as string | null } as MutableRef<string | null>;
  const area = areaRef.current;
  const board = boardRef.current;
  if (!area || !board) return () => {};
  const bctx = board.getContext("2d");
  if (!bctx) return () => {};
  const onDown = (e: PointerEvent) => {
    if (readOnlyRef.current) return;
    const tool = toolRef.current;
    if (!(tool === "pen" || tool === "eraser")) return;
    const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
    isDrawing.current = true;
    lastPoint.current = { x: nx, y: ny };
    currentStrokeIdRef.current = null;
    try { (e.target as Element)?.setPointerCapture?.(e.pointerId); } catch {}
  };
  let lastSentAt = 0;
  let pendingDraw: StrokePayload | null = null;
  let raf = 0;
  const flushDraw = () => {
    if (!pendingDraw) return;
    sendCritical(pendingDraw);
    pendingDraw = null;
  };
  const onMove = (e: PointerEvent) => {
    if (readOnlyRef.current) return;
    const tool = toolRef.current;
    if (!(tool === "pen" || tool === "eraser")) return;
    if (!isDrawing.current) return;
    const lp = lastPoint.current;
    const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
    const mode: "draw" | "erase" = tool === "eraser" ? "erase" : "draw";
    const size = tool === "eraser" ? eraserSizeRef.current : penSizeRef.current;
    const inBoard = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
    if (inBoard && !currentStrokeIdRef.current) {
      const sid = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      currentStrokeIdRef.current = sid;
      bctx.lineWidth = size;
      bctx.save();
      if (mode === "erase") {
        bctx.globalCompositeOperation = "destination-out";
        bctx.fillStyle = "#000";
      } else {
        bctx.globalCompositeOperation = "source-over";
        bctx.fillStyle = penChromaRef.current.enabled ? chromaColor(penChromaRef.current) : penColorRef.current;
      }
      bctx.beginPath();
      bctx.arc(nx * BOARD_W, ny * BOARD_H, size / 2, 0, Math.PI * 2);
      bctx.fill();
      bctx.restore();
      const color = penChromaRef.current.enabled ? chromaColor(penChromaRef.current) : penColorRef.current;
      sendCritical({ type: "stroke", id, color, size, phase: "start", x: nx, y: ny, mode, strokeId: sid });
  sendCritical({ type: "cursor", id, name, x: nx, y: ny, tool, size });
    } else if (!inBoard && currentStrokeIdRef.current) {
      const color = penChromaRef.current.enabled ? chromaColor(penChromaRef.current) : penColorRef.current;
      sendCritical({ type: "stroke", id, color, size, phase: "end", x: 0, y: 0, mode, strokeId: currentStrokeIdRef.current });
      currentStrokeIdRef.current = null;
    }
    if (currentStrokeIdRef.current && lp && (lp.x >= 0 && lp.x <= 1 && lp.y >= 0 && lp.y <= 1) && inBoard) {
      bctx.save();
      if (mode === "erase") {
        bctx.globalCompositeOperation = "destination-out";
      } else {
        bctx.globalCompositeOperation = "source-over";
        bctx.strokeStyle = penChromaRef.current.enabled ? chromaColor(penChromaRef.current) : penColorRef.current;
      }
      bctx.lineWidth = size;
      bctx.beginPath();
      bctx.moveTo(lp.x * BOARD_W, lp.y * BOARD_H);
      bctx.lineTo(nx * BOARD_W, ny * BOARD_H);
      bctx.stroke();
      bctx.restore();
      const color = penChromaRef.current.enabled ? chromaColor(penChromaRef.current) : penColorRef.current;
      pendingDraw = { type: "stroke", id, color, size, phase: "draw", x: nx, y: ny, mode, strokeId: currentStrokeIdRef.current } as StrokePayload;
      const now = performance.now();
      if (now - lastSentAt >= 8) {
        lastSentAt = now; flushDraw();
  sendCritical({ type: "cursor", id, name, x: nx, y: ny, tool, size });
      } else if (!raf) {
        raf = requestAnimationFrame(() => { raf = 0; flushDraw(); });
      }
    }
    lastPoint.current = { x: nx, y: ny };
  };
  const onUp = (e: PointerEvent) => {
    if (readOnlyRef.current) return;
    const tool = toolRef.current;
    if (!(tool === "pen" || tool === "eraser")) return;
    if (!isDrawing.current) return;
    isDrawing.current = false;
    lastPoint.current = null;
    const mode: "draw" | "erase" = tool === "eraser" ? "erase" : "draw";
    const size = tool === "eraser" ? eraserSizeRef.current : penSizeRef.current;
    if (currentStrokeIdRef.current) {
      const color = penChromaRef.current.enabled ? chromaColor(penChromaRef.current) : penColorRef.current;
      if (pendingDraw) { flushDraw(); }
      sendCritical({ type: "stroke", id, color, size, phase: "end", x: 0, y: 0, mode, strokeId: currentStrokeIdRef.current });
      currentStrokeIdRef.current = null;
    }
    try { (e.target as Element)?.releasePointerCapture?.(e.pointerId); } catch {}
  };
  area.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  return () => {
    area.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (raf) cancelAnimationFrame(raf);
  };
}
