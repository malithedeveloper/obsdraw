import { BOARD_W, BOARD_H } from "../constants";
import {
  ChromaConfig,
  CommittedImage,
  CommittedText,
  HistoryEvent,
  ImageChromaState,
  ImageChromaKeyState,
  ImageCommitEvent,
  ImageUpdateEvent,
  RotAnimState,
  DvdState,
  TextCommitEvent,
  TextUpdateEvent,
} from "../types";
export function rebuildCommittedTexts(
  history: HistoryEvent[],
  undone: Set<string>,
  readOnly: boolean,
  ensureFontLoaded?: (css: string) => void
): Map<string, CommittedText> {
  const commits = new Map<string, CommittedText>();
  const merged = new Map<string, Partial<CommittedText & { chroma: ChromaConfig }>>();
  for (const ev of history) {
    if (ev.type === "text_commit") {
      const t = ev as TextCommitEvent;
      if (undone.has(t.strokeId)) continue;
      commits.set(t.textId, {
        textId: t.textId,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        text: t.text,
        color: t.color,
        size: t.size,
        font: t.font,
        strokeId: t.strokeId,
        chroma: t.chroma,
        rotX: t.rotX,
        rotY: t.rotY,
        rotZ: t.rotZ,
        outline: t.outline,
      });
    } else if (ev.type === "text_update") {
      const u = ev as TextUpdateEvent;
      if (u.strokeId && undone.has(u.strokeId)) continue;
      const cur = merged.get(u.textId) || {};
      if (u.x !== undefined) cur.x = u.x;
      if (u.y !== undefined) cur.y = u.y;
      if (u.width !== undefined) cur.width = u.width;
      if (u.height !== undefined) cur.height = u.height;
      if (u.text !== undefined) cur.text = u.text;
      if (u.color !== undefined) cur.color = u.color;
      if (u.size !== undefined) cur.size = u.size;
      if (u.font !== undefined) cur.font = u.font;
      if (u.chroma !== undefined) cur.chroma = u.chroma;
  if (u.outline !== undefined) cur.outline = u.outline;
      if (u.rotX !== undefined) cur.rotX = u.rotX;
      if (u.rotY !== undefined) cur.rotY = u.rotY;
      if (u.rotZ !== undefined) cur.rotZ = u.rotZ;
      merged.set(u.textId, cur);
    }
  }
  const result = new Map<string, CommittedText>();
  for (const [textId, base] of commits) {
    const upd = merged.get(textId) || {};
    const mergedText: CommittedText = {
      ...base,
      x: upd.x ?? base.x,
      y: upd.y ?? base.y,
      width: upd.width ?? base.width,
      height: upd.height ?? base.height,
      text: upd.text ?? base.text,
      color: upd.color ?? base.color,
      size: upd.size ?? base.size,
      font: upd.font ?? base.font,
      chroma: upd.chroma ?? base.chroma,
  outline: upd.outline ?? base.outline,
      rotX: upd.rotX ?? base.rotX,
      rotY: upd.rotY ?? base.rotY,
      rotZ: upd.rotZ ?? base.rotZ,
    };
    result.set(textId, mergedText);
    if (readOnly && ensureFontLoaded) { try { ensureFontLoaded(mergedText.font); } catch {}
    }
  }
  return result;
}
export function rebuildTextAnimStates(
  history: HistoryEvent[],
  undone: Set<string>,
  dvdMap: Map<string, DvdState>,
  rotMap: Map<string, RotAnimState>
): void {
  dvdMap.clear();
  rotMap.clear();
  for (const ev of history) {
    if (ev.type !== "text_update") continue;
    const u = ev as TextUpdateEvent;
    if (u.strokeId && undone.has(u.strokeId)) continue;
  if (u.dvdEnabled !== undefined || u.dvdSpeed !== undefined || u.dvdVx !== undefined || u.dvdVy !== undefined) {
      const st = dvdMap.get(u.textId) ?? {
        enabled: true,
        vx: Math.cos(Math.PI / 4) * (240 / BOARD_W),
        vy: Math.sin(Math.PI / 4) * (240 / BOARD_H),
        speed: 240,
        pausedByDrag: false,
      } as DvdState;
      if (u.dvdEnabled !== undefined) st.enabled = u.dvdEnabled;
      if (u.dvdSpeed !== undefined) {
        st.speed = u.dvdSpeed;
        const ang = Math.atan2(st.vy * BOARD_H, st.vx * BOARD_W);
        st.vx = Math.cos(ang) * (st.speed / BOARD_W);
        st.vy = Math.sin(ang) * (st.speed / BOARD_H);
      }
  if (u.dvdVx !== undefined) st.vx = u.dvdVx;
  if (u.dvdVy !== undefined) st.vy = u.dvdVy;
      st.controlled = false;
      dvdMap.set(u.textId, st);
    }
    const rotTouched = (
      u.rotXAnimEnabled !== undefined || u.rotXAnimSpeed !== undefined || u.rotXAnimMin !== undefined || u.rotXAnimMax !== undefined ||
      u.rotYAnimEnabled !== undefined || u.rotYAnimSpeed !== undefined || u.rotYAnimMin !== undefined || u.rotYAnimMax !== undefined ||
      u.rotZAnimEnabled !== undefined || u.rotZAnimSpeed !== undefined || u.rotZAnimMin !== undefined || u.rotZAnimMax !== undefined
    );
    if (rotTouched) {
      const defAxis = () => ({ enabled: false, dir: 1 as 1 | -1, speed: 60, min: -180, max: 180 });
      const st = rotMap.get(u.textId) ?? { x: defAxis(), y: defAxis(), z: defAxis(), lastSent: 0, controlled: false };
      if (u.rotXAnimEnabled !== undefined) st.x.enabled = u.rotXAnimEnabled;
      if (u.rotXAnimSpeed !== undefined) st.x.speed = u.rotXAnimSpeed;
      if (u.rotXAnimMin !== undefined) st.x.min = u.rotXAnimMin;
      if (u.rotXAnimMax !== undefined) st.x.max = u.rotXAnimMax;
      if (u.rotXAnimDir !== undefined) st.x.dir = u.rotXAnimDir;
      if (u.rotYAnimEnabled !== undefined) st.y.enabled = u.rotYAnimEnabled;
      if (u.rotYAnimSpeed !== undefined) st.y.speed = u.rotYAnimSpeed;
      if (u.rotYAnimMin !== undefined) st.y.min = u.rotYAnimMin;
      if (u.rotYAnimMax !== undefined) st.y.max = u.rotYAnimMax;
      if (u.rotYAnimDir !== undefined) st.y.dir = u.rotYAnimDir;
      if (u.rotZAnimEnabled !== undefined) st.z.enabled = u.rotZAnimEnabled;
      if (u.rotZAnimSpeed !== undefined) st.z.speed = u.rotZAnimSpeed;
      if (u.rotZAnimMin !== undefined) st.z.min = u.rotZAnimMin;
      if (u.rotZAnimMax !== undefined) st.z.max = u.rotZAnimMax;
      if (u.rotZAnimDir !== undefined) st.z.dir = u.rotZAnimDir;
      st.controlled = false;
      rotMap.set(u.textId, st);
    }
  }
}
export function rebuildCommittedImages(
  history: HistoryEvent[],
  undone: Set<string>
): Map<string, CommittedImage> {
  const map = new Map<string, CommittedImage>();
  for (const ev of history) {
    if (ev.type === "image_commit") {
      const im = ev as ImageCommitEvent;
      if (undone.has(im.strokeId)) continue;
      const minW = 10 / BOARD_W, minH = 10 / BOARD_H;
      const width = Math.max(minW, Math.min(1, im.width));
      const height = Math.max(minH, Math.min(1, im.height));
      map.set(im.imageId, {
        imageId: im.imageId,
        x: im.x,
        y: im.y,
        width,
        height,
        src: im.src,
        strokeId: im.strokeId,
        filter: im.filter,
        rotX: im.rotX,
        rotY: im.rotY,
        rotZ: im.rotZ,
        mediaKind: im.mediaKind,
        animated: im.animated,
        origin: im.origin,
      });
    } else if (ev.type === "image_update") {
      const up = ev as ImageUpdateEvent;
      const cur = map.get(up.imageId);
      if (cur) {
        const minW = 10 / BOARD_W, minH = 10 / BOARD_H;
        const width = up.width !== undefined ? Math.max(minW, Math.min(1, up.width)) : cur.width;
        const height = up.height !== undefined ? Math.max(minH, Math.min(1, up.height)) : cur.height;
        map.set(up.imageId, {
          ...cur,
          x: up.x ?? cur.x,
          y: up.y ?? cur.y,
          width,
          height,
          filter: up.filter ?? cur.filter,
          rotX: up.rotX ?? cur.rotX,
          rotY: up.rotY ?? cur.rotY,
          rotZ: up.rotZ ?? cur.rotZ,
        });
      }
    }
  }
  return map;
}
export function rebuildImageAnimStates(
  history: HistoryEvent[],
  undone: Set<string>,
  imageChroma: Map<string, ImageChromaState>,
  imageChromaKey: Map<string, ImageChromaKeyState>,
  dvdMap: Map<string, DvdState>,
  rotMap: Map<string, RotAnimState>
): void {
  imageChroma.clear();
  imageChromaKey.clear();
  dvdMap.clear();
  rotMap.clear();
  for (const ev of history) {
    if (ev.type !== "image_update") continue;
    const u = ev as ImageUpdateEvent;
    if (u.strokeId && undone.has(u.strokeId)) continue;
    if (u.chromaSpeed !== undefined || u.chromaSaturation !== undefined || u.chromaLightness !== undefined) {
      const st = imageChroma.get(u.imageId) ?? { speed: 120, saturation: 180, lightness: 100 };
      if (u.chromaSpeed !== undefined) st.speed = u.chromaSpeed;
      if (u.chromaSaturation !== undefined) st.saturation = u.chromaSaturation;
      if (u.chromaLightness !== undefined) st.lightness = u.chromaLightness;
      imageChroma.set(u.imageId, st);
    }
    if (
      u.chromaKeyEnabled !== undefined ||
      u.chromaKeyColor !== undefined ||
      u.chromaKeyTolerance !== undefined ||
      u.chromaKeyFeather !== undefined ||
      u.chromaKeySpill !== undefined
    ) {
      const st = imageChromaKey.get(u.imageId) ?? { enabled: false, color: "#00ff00", tolerance: 80, feather: 20, spill: 40 };
      if (u.chromaKeyColor !== undefined) st.color = u.chromaKeyColor;
      if (u.chromaKeyTolerance !== undefined) st.tolerance = u.chromaKeyTolerance;
      if (u.chromaKeyFeather !== undefined) st.feather = u.chromaKeyFeather;
      if (u.chromaKeySpill !== undefined) st.spill = u.chromaKeySpill;
      if (u.chromaKeyEnabled !== undefined) st.enabled = u.chromaKeyEnabled;
      else if (
        u.chromaKeyColor !== undefined ||
        u.chromaKeyTolerance !== undefined ||
        u.chromaKeyFeather !== undefined ||
        u.chromaKeySpill !== undefined
      ) {
        st.enabled = st.enabled || true;
      }
      imageChromaKey.set(u.imageId, st);
    }
  if (u.dvdEnabled !== undefined || u.dvdSpeed !== undefined || u.dvdVx !== undefined || u.dvdVy !== undefined) {
      const st = dvdMap.get(u.imageId) ?? {
        enabled: true,
        vx: Math.cos(Math.PI / 4) * (240 / BOARD_W),
        vy: Math.sin(Math.PI / 4) * (240 / BOARD_H),
        speed: 240,
        pausedByDrag: false,
      } as DvdState;
      if (u.dvdEnabled !== undefined) st.enabled = u.dvdEnabled;
      if (u.dvdSpeed !== undefined) {
        st.speed = u.dvdSpeed;
        const ang = Math.atan2(st.vy * BOARD_H, st.vx * BOARD_W);
        st.vx = Math.cos(ang) * (st.speed / BOARD_W);
        st.vy = Math.sin(ang) * (st.speed / BOARD_H);
      }
  if (u.dvdVx !== undefined) st.vx = u.dvdVx;
  if (u.dvdVy !== undefined) st.vy = u.dvdVy;
      st.controlled = false;
      dvdMap.set(u.imageId, st);
    }
    const rotTouched = (
      u.rotXAnimEnabled !== undefined || u.rotXAnimSpeed !== undefined || u.rotXAnimMin !== undefined || u.rotXAnimMax !== undefined ||
      u.rotYAnimEnabled !== undefined || u.rotYAnimSpeed !== undefined || u.rotYAnimMin !== undefined || u.rotYAnimMax !== undefined ||
      u.rotZAnimEnabled !== undefined || u.rotZAnimSpeed !== undefined || u.rotZAnimMin !== undefined || u.rotZAnimMax !== undefined
    );
    if (rotTouched) {
      const defAxis = () => ({ enabled: false, dir: 1 as 1 | -1, speed: 60, min: -180, max: 180 });
      const st = rotMap.get(u.imageId) ?? { x: defAxis(), y: defAxis(), z: defAxis(), lastSent: 0, controlled: false };
      if (u.rotXAnimEnabled !== undefined) st.x.enabled = u.rotXAnimEnabled;
      if (u.rotXAnimSpeed !== undefined) st.x.speed = u.rotXAnimSpeed;
      if (u.rotXAnimMin !== undefined) st.x.min = u.rotXAnimMin;
      if (u.rotXAnimMax !== undefined) st.x.max = u.rotXAnimMax;
      if (u.rotXAnimDir !== undefined) st.x.dir = u.rotXAnimDir;
      if (u.rotYAnimEnabled !== undefined) st.y.enabled = u.rotYAnimEnabled;
      if (u.rotYAnimSpeed !== undefined) st.y.speed = u.rotYAnimSpeed;
      if (u.rotYAnimMin !== undefined) st.y.min = u.rotYAnimMin;
      if (u.rotYAnimMax !== undefined) st.y.max = u.rotYAnimMax;
      if (u.rotYAnimDir !== undefined) st.y.dir = u.rotYAnimDir;
      if (u.rotZAnimEnabled !== undefined) st.z.enabled = u.rotZAnimEnabled;
      if (u.rotZAnimSpeed !== undefined) st.z.speed = u.rotZAnimSpeed;
      if (u.rotZAnimMin !== undefined) st.z.min = u.rotZAnimMin;
      if (u.rotZAnimMax !== undefined) st.z.max = u.rotZAnimMax;
      if (u.rotZAnimDir !== undefined) st.z.dir = u.rotZAnimDir;
      st.controlled = false;
      rotMap.set(u.imageId, st);
    }
  }
}
