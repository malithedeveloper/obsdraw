import { DvdState, RotAnimState, RotAxisState, CommittedText, CommittedImage, TextUpdateEvent, ImageUpdateEvent, HistoryEvent } from "../types";
export type MutableRef<T> = { current: T };
export type DragState =
  | null
  | {
      entity: "text" | "image";
      kind: "move" | "resize";
      id: string;
      startX: number;
      startY: number;
      shift?: boolean;
      anchor?: "tl" | "tr" | "bl" | "br" | "l" | "r" | "t" | "b";
      origin: { x: number; y: number; width?: number; height?: number; aspect?: number };
    };
export function ensureDvdState(
  kind: "text" | "image",
  id: string,
  opts: {
    dvdTextState: Map<string, DvdState>;
    dvdImageState: Map<string, DvdState>;
    BOARD_W: number;
    BOARD_H: number;
    baseSpeedPx?: number;
  }
): DvdState {
  const { dvdTextState, dvdImageState, BOARD_W, BOARD_H, baseSpeedPx = 240 } = opts;
  const map = kind === "text" ? dvdTextState : dvdImageState;
  if (!map.has(id)) {
    const bases = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
    const base = bases[Math.floor(Math.random() * bases.length)];
    const jitter = (Math.random() - 0.5) * (Math.PI / 6);  
    const angle = base + jitter;
    const vx = Math.cos(angle) * (baseSpeedPx / BOARD_W);  
    const vy = Math.sin(angle) * (baseSpeedPx / BOARD_H);
    map.set(id, { enabled: true, vx, vy, speed: baseSpeedPx, pausedByDrag: false, lastSent: 0, controlled: false });
  }
  return map.get(id)!;
}
export function ensureRotState(
  kind: "text" | "image",
  id: string,
  opts: { rotTextState: Map<string, RotAnimState>; rotImageState: Map<string, RotAnimState> }
): RotAnimState {
  const { rotTextState, rotImageState } = opts;
  const map = kind === "text" ? rotTextState : rotImageState;
  if (!map.has(id)) {
    const def = () => ({ enabled: false, dir: 1 as 1 | -1, speed: 60, min: -180, max: 180 });
    map.set(id, { x: def(), y: def(), z: def(), lastSent: 0, controlled: false });
  }
  return map.get(id)!;
}
export function startAnimationLoop(cfg: {
  id: string;
  BOARD_W: number;
  BOARD_H: number;
  committedTextsRef: MutableRef<Map<string, CommittedText>>;
  committedImagesRef: MutableRef<Map<string, CommittedImage>>;
  dvdTextStateRef: MutableRef<Map<string, DvdState>>;
  dvdImageStateRef: MutableRef<Map<string, DvdState>>;
  rotTextStateRef: MutableRef<Map<string, RotAnimState>>;
  rotImageStateRef: MutableRef<Map<string, RotAnimState>>;
  historyRef: MutableRef<HistoryEvent[]>;
  dragStateRef: MutableRef<DragState>;
  repaint: () => void;
  sendCritical: (m: TextUpdateEvent | ImageUpdateEvent) => void;
}): () => void {
  const {
    id,
    BOARD_W,
    BOARD_H,
    committedTextsRef,
    committedImagesRef,
    dvdTextStateRef,
    dvdImageStateRef,
    rotTextStateRef,
    rotImageStateRef,
    historyRef,
    dragStateRef,
    repaint,
    sendCritical,
  } = cfg;
  let raf = 0;
  let last = performance.now();
  const TICK_SEND_MS = 200;  
  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    let anyChanged = false;
    let anyEnabled = false;
    for (const [tid] of committedTextsRef.current) {
      let tb = committedTextsRef.current.get(tid)!;
      const st = dvdTextStateRef.current.get(tid);
      if (st && st.enabled && !st.pausedByDrag) {
        anyEnabled = true;
        const dragging = dragStateRef.current && dragStateRef.current.entity === "text" && dragStateRef.current.id === tid;
        if (dragging) {
          st.pausedByDrag = true;
        }
        if (!dragging && st.pausedByDrag) {
          st.pausedByDrag = false;
        }
        if (!dragging) {
          let wFrac = (tb.width ?? undefined) ? (tb.width as number) : undefined;
          let hFrac = (tb.height ?? undefined) ? (tb.height as number) : undefined;
          if (wFrac === undefined || hFrac === undefined) {
            const el = typeof document !== "undefined" ? (document.getElementById(`committed-${tid}`) as HTMLElement | null) : null;
            if (el) {
              const pxW = (el as HTMLElement).offsetWidth || 200;
              const pxH = (el as HTMLElement).offsetHeight || 50;
              wFrac = Math.max(10 / BOARD_W, pxW / BOARD_W);
              hFrac = Math.max(10 / BOARD_H, pxH / BOARD_H);
            } else {
              wFrac = Math.max(10 / BOARD_W, (tb.text.length * (tb.size * 0.6)) / BOARD_W);
              hFrac = Math.max(10 / BOARD_H, (tb.size * 1.2) / BOARD_H);
            }
          }
          const width = wFrac ?? 0.2;
          const height = hFrac ?? 0.1;
          let nx = tb.x + st.vx * dt;
          let ny = tb.y + st.vy * dt;
          let bounced = false;
          if (nx < 0) {
            nx = 0;
            st.vx = Math.abs(st.vx);
            bounced = true;
          }
          if (ny < 0) {
            ny = 0;
            st.vy = Math.abs(st.vy);
            bounced = true;
          }
          if (nx > 1 - width) {
            nx = 1 - width;
            st.vx = -Math.abs(st.vx);
            bounced = true;
          }
          if (ny > 1 - height) {
            ny = 1 - height;
            st.vy = -Math.abs(st.vy);
            bounced = true;
          }
          if (nx !== tb.x || ny !== tb.y) {
            const curNow = committedTextsRef.current.get(tid) || tb;
            committedTextsRef.current.set(tid, { ...curNow, x: nx, y: ny });
            tb = committedTextsRef.current.get(tid)!;
            anyChanged = true;
          }
          if (st.controlled && (st.lastSent ?? 0) + TICK_SEND_MS <= now) {
            st.lastSent = now;
            const lastX = st.lastSentX ?? tb.x;
            const lastY = st.lastSentY ?? tb.y;
            const px = Math.abs(nx - lastX) * BOARD_W;
            const py = Math.abs(ny - lastY) * BOARD_H;
            if (px >= 3 || py >= 3) {
              const upd: TextUpdateEvent = { type: "text_update", id, textId: tid, x: nx, y: ny, dvdVx: st.vx, dvdVy: st.vy, strokeId: tb.strokeId };
              sendCritical(upd);
              historyRef.current.push(upd as unknown as HistoryEvent);
              st.lastSentX = nx;
              st.lastSentY = ny;
            }
          }
          if (bounced) anyChanged = true;
        }
      }
      const rst = rotTextStateRef.current.get(tid);
      if (rst && (rst.x.enabled || rst.y.enabled || rst.z.enabled)) {
        anyEnabled = true;
        tb = committedTextsRef.current.get(tid) || tb;
        const { rotX = 0, rotY = 0, rotZ = 0 } = tb;
        const applyAxis = (cur: number, a: RotAxisState) => {
          if (!a.enabled) return cur;
          let v = cur + a.dir * a.speed * dt;
          if (v > 180) v -= 360;
          if (v < -180) v += 360;
          return v;
        };
        const nx = applyAxis(rotX, rst.x);
        const ny = applyAxis(rotY, rst.y);
        const nz = applyAxis(rotZ, rst.z);
        if (nx !== rotX || ny !== rotY || nz !== rotZ) {
          const curNow = committedTextsRef.current.get(tid) || tb;
          committedTextsRef.current.set(tid, { ...curNow, rotX: nx, rotY: ny, rotZ: nz });
          anyChanged = true;
          if (rst.controlled && (rst.lastSent ?? 0) + TICK_SEND_MS <= now) {
            rst.lastSent = now;
            const lx = rst.lastSentRotX ?? rotX;
            const ly = rst.lastSentRotY ?? rotY;
            const lz = rst.lastSentRotZ ?? rotZ;
            if (Math.abs(nx - lx) >= 5 || Math.abs(ny - ly) >= 5 || Math.abs(nz - lz) >= 5) {
              const upd: TextUpdateEvent = { type: "text_update", id, textId: tid, rotX: nx, rotY: ny, rotZ: nz, strokeId: tb.strokeId };
              sendCritical(upd);
              historyRef.current.push(upd as unknown as HistoryEvent);
              rst.lastSentRotX = nx;
              rst.lastSentRotY = ny;
              rst.lastSentRotZ = nz;
            }
          }
        }
      }
    }
    for (const [iid] of committedImagesRef.current) {
      let im = committedImagesRef.current.get(iid)!;
      const st = dvdImageStateRef.current.get(iid);
      if (st && st.enabled && !st.pausedByDrag) {
        anyEnabled = true;
        const dragging = dragStateRef.current && dragStateRef.current.entity === "image" && dragStateRef.current.id === iid;
        if (dragging) {
          st.pausedByDrag = true;
        }
        if (!dragging && st.pausedByDrag) {
          st.pausedByDrag = false;
        }
        if (!dragging) {
          const width = Math.max(10 / BOARD_W, im.width);
          const height = Math.max(10 / BOARD_H, im.height);
          let nx = im.x + st.vx * dt;
          let ny = im.y + st.vy * dt;
          let bounced = false;
          if (nx < 0) {
            nx = 0;
            st.vx = Math.abs(st.vx);
            bounced = true;
          }
          if (ny < 0) {
            ny = 0;
            st.vy = Math.abs(st.vy);
            bounced = true;
          }
          if (nx > 1 - width) {
            nx = 1 - width;
            st.vx = -Math.abs(st.vx);
            bounced = true;
          }
          if (ny > 1 - height) {
            ny = 1 - height;
            st.vy = -Math.abs(st.vy);
            bounced = true;
          }
          if (nx !== im.x || ny !== im.y) {
            const curNow = committedImagesRef.current.get(iid) || im;
            committedImagesRef.current.set(iid, { ...curNow, x: nx, y: ny });
            im = committedImagesRef.current.get(iid)!;
            anyChanged = true;
          }
          if (st.controlled && (st.lastSent ?? 0) + TICK_SEND_MS <= now) {
            st.lastSent = now;
            const lastX = st.lastSentX ?? im.x;
            const lastY = st.lastSentY ?? im.y;
            const px = Math.abs(nx - lastX) * BOARD_W;
            const py = Math.abs(ny - lastY) * BOARD_H;
            if (px >= 3 || py >= 3) {
              const upd: ImageUpdateEvent = { type: "image_update", id, imageId: iid, x: nx, y: ny, dvdVx: st.vx, dvdVy: st.vy, strokeId: im.strokeId };
              sendCritical(upd);
              historyRef.current.push(upd as unknown as HistoryEvent);
              st.lastSentX = nx;
              st.lastSentY = ny;
            }
          }
          if (bounced) anyChanged = true;
        }
      }
      const rst = rotImageStateRef.current.get(iid);
      if (rst && (rst.x.enabled || rst.y.enabled || rst.z.enabled)) {
        anyEnabled = true;
        im = committedImagesRef.current.get(iid) || im;
        const { rotX = 0, rotY = 0, rotZ = 0 } = im;
        const applyAxis = (cur: number, a: RotAxisState) => {
          if (!a.enabled) return cur;
          let v = cur + a.dir * a.speed * dt;
          if (v > 180) v -= 360;
          if (v < -180) v += 360;
          return v;
        };
        const nx = applyAxis(rotX, rst.x);
        const ny = applyAxis(rotY, rst.y);
        const nz = applyAxis(rotZ, rst.z);
        if (nx !== rotX || ny !== rotY || nz !== rotZ) {
          const curNow = committedImagesRef.current.get(iid) || im;
          committedImagesRef.current.set(iid, { ...curNow, rotX: nx, rotY: ny, rotZ: nz });
          anyChanged = true;
          if (rst.controlled && (rst.lastSent ?? 0) + TICK_SEND_MS <= now) {
            rst.lastSent = now;
            const lx = rst.lastSentRotX ?? rotX;
            const ly = rst.lastSentRotY ?? rotY;
            const lz = rst.lastSentRotZ ?? rotZ;
            if (Math.abs(nx - lx) >= 5 || Math.abs(ny - ly) >= 5 || Math.abs(nz - lz) >= 5) {
              const upd: ImageUpdateEvent = { type: "image_update", id, imageId: iid, rotX: nx, rotY: ny, rotZ: nz, strokeId: im.strokeId };
              sendCritical(upd);
              historyRef.current.push(upd as unknown as HistoryEvent);
              rst.lastSentRotX = nx;
              rst.lastSentRotY = ny;
              rst.lastSentRotZ = nz;
            }
          }
        }
      }
    }
    if (anyChanged || anyEnabled) {
      repaint();
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
