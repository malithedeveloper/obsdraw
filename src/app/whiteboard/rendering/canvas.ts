import { BOARD_H, BOARD_W } from "../constants";
import { HistoryEvent } from "../types";

type Ref<T> = { current: T };

export function createReplayer(deps: {
  boardRef: Ref<HTMLCanvasElement | null>;
  historyRef: Ref<HistoryEvent[]>;
  undoneRef: Ref<Set<string>>;
}): () => void {
  const { boardRef, historyRef, undoneRef } = deps;

  return function replayBoard() {
    const board = boardRef.current;
    const bctx = board?.getContext("2d", { alpha: true });
    if (!board || !bctx) return;

    // Reset transform and clear
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, board.width, board.height);

    // Set common styles once
    bctx.lineCap = "round";
    bctx.lineJoin = "round";

    const lastPt = new Map<string, { x: number; y: number }>();
    
    // State tracking to minimize context switches
    let currentMode: "erase" | "draw" | null = null;
    let currentColor: string | null = null;
    let currentSize: number | null = null;

    // Helper to sync state
    const syncState = (mode: "erase" | "draw", color: string, size: number) => {
      if (currentMode !== mode) {
        bctx.globalCompositeOperation = mode === "erase" ? "destination-out" : "source-over";
        currentMode = mode;
      }
      
      if (mode === "draw") {
        if (currentColor !== color) {
          bctx.strokeStyle = color;
          bctx.fillStyle = color;
          currentColor = color;
        }
      } else {
        // Erase mode
        if (currentColor !== "#000000") {
          bctx.strokeStyle = "#000000";
          bctx.fillStyle = "#000000";
          currentColor = "#000000";
        }
      }

      if (currentSize !== size) {
        bctx.lineWidth = size;
        currentSize = size;
      }
    };

    for (const ev of historyRef.current) {
      if (ev.type !== "stroke") continue;
      const s = ev;
      if (undoneRef.current.has(s.strokeId)) continue;

      // Coordinate mapping
      const x = Math.max(0, Math.min(BOARD_W - 1, s.x * BOARD_W));
      const y = Math.max(0, Math.min(BOARD_H - 1, s.y * BOARD_H));
      
      const mode = s.mode === "erase" ? "erase" : "draw";

      if (s.phase === "start") {
        // Draw a dot
        syncState(mode, s.color, s.size);
        bctx.beginPath();
        bctx.arc(x, y, s.size / 2, 0, Math.PI * 2);
        bctx.fill();
        lastPt.set(s.strokeId, { x, y });
      } else if (s.phase === "draw") {
        const lp = lastPt.get(s.strokeId);
        if (lp) {
          syncState(mode, s.color, s.size);
          bctx.beginPath();
          bctx.moveTo(lp.x, lp.y);
          bctx.lineTo(x, y);
          bctx.stroke();
          lastPt.set(s.strokeId, { x, y });
        } else {
          // Treat as start if we missed the start or it was out of bounds
          syncState(mode, s.color, s.size);
          bctx.beginPath();
          bctx.arc(x, y, s.size / 2, 0, Math.PI * 2);
          bctx.fill();
          lastPt.set(s.strokeId, { x, y });
        }
      } else if (s.phase === "end") {
        lastPt.delete(s.strokeId);
      }
    }
  };
}
