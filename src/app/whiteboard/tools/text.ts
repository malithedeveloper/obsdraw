import { MutableRef } from "../services/animation";
import { BOARD_H } from "../constants";
import { ChromaConfig, CommittedText, HistoryEvent, TextCommitEvent, TextOutlineConfig, TextUpdateEvent, Tool } from "../types";
export type TextToolDeps = {
  id: string;
  toolRef: MutableRef<Tool>;
  readOnlyRef: MutableRef<boolean>;
  containerRef: MutableRef<HTMLDivElement | null>;
  screenToBoardNorm: (x: number, y: number) => { x: number; y: number };
  boardNormToScreen: (x: number, y: number) => { x: number; y: number };
  setTextInputActive: (v: boolean) => void;
  setTextInputValue: (v: string) => void;
  textInputRef: MutableRef<HTMLInputElement | null>;
  textInputUi: MutableRef<{ left: number; top: number; width: number }>;
  curTextRef2: MutableRef<{ textId: string; strokeId: string; x: number; y: number; size: number; color: string; font: string; outline: TextOutlineConfig; lastSent: number; committed: boolean } | null>;
  textColorRef: MutableRef<string>;
  textSizeRef: MutableRef<number>;
  textFontRef: MutableRef<string>;
  textChromaRef: MutableRef<ChromaConfig>;
  textOutlineRef: MutableRef<TextOutlineConfig>;
  chromaColor: (c: ChromaConfig) => string;
  committedTextsRef: MutableRef<Map<string, CommittedText>>;
  historyRef: MutableRef<HistoryEvent[]>;
  myStrokesRef: MutableRef<string[]>;
  setSelectedTextId: (id: string | null) => void;
  setSelectedImageId: (id: string | null) => void;
  sendCritical: (m: TextCommitEvent | TextUpdateEvent) => void;
};
export function attachTextTool(deps: TextToolDeps) {
  const {
    id,
    toolRef,
    readOnlyRef,
  containerRef,
    screenToBoardNorm,
    boardNormToScreen,
    setTextInputActive,
    setTextInputValue,
    textInputRef,
    textInputUi,
    curTextRef2,
    textColorRef,
    textSizeRef,
    textFontRef,
  textChromaRef,
  textOutlineRef,
    chromaColor,
    committedTextsRef,
    historyRef,
    myStrokesRef,
    setSelectedTextId,
    setSelectedImageId,
    sendCritical,
  } = deps;
  const container = containerRef.current;
  if (!container) return { detach: () => {}, sendTextImmediate: () => {} };
  const cloneOutline = (src?: TextOutlineConfig): TextOutlineConfig => {
    const base = src ?? textOutlineRef.current;
    if (!base) {
      return { enabled: false, color: "#000000", width: 0, feather: 0 };
    }
    return { ...base, chroma: base.chroma ? { ...base.chroma } : undefined };
  };
  const sendTextImmediate = (val: string) => {
    const cur = curTextRef2.current;
    if (!cur) return;
    const chromaEnabled = !!textChromaRef.current?.enabled;
    const chromaOpt = chromaEnabled ? { ...textChromaRef.current } : undefined;
    const effectiveColor = chromaEnabled ? chromaColor(textChromaRef.current) : cur.color;
    const outlineSnapshot = cloneOutline(cur.outline);
    cur.outline = outlineSnapshot;
    if (!cur.committed) {
      if (val.length === 0) return;
      const commit: TextCommitEvent = { type: "text_commit", id, textId: cur.textId, text: val, x: cur.x, y: cur.y, color: effectiveColor, size: cur.size, font: cur.font, strokeId: cur.strokeId, chroma: chromaOpt, outline: outlineSnapshot };
      sendCritical(commit);
      historyRef.current.push(commit);
      myStrokesRef.current.push(cur.strokeId);
      committedTextsRef.current.set(cur.textId, {
        textId: cur.textId,
        x: cur.x,
        y: cur.y,
        text: val,
        color: cur.color,
        size: cur.size,
        font: cur.font,
        strokeId: cur.strokeId,
        outline: outlineSnapshot,
      });
      cur.committed = true;
    } else {
      const upd: TextUpdateEvent = {
        type: "text_update",
        id,
        textId: cur.textId,
        text: val,
        x: cur.x,
        y: cur.y,
        color: effectiveColor,
        size: cur.size,
        font: cur.font,
        strokeId: committedTextsRef.current.get(cur.textId)?.strokeId,
        chroma: chromaOpt,
        outline: outlineSnapshot,
      };
      sendCritical(upd);
      historyRef.current.push(upd as unknown as HistoryEvent);
      const exist = committedTextsRef.current.get(cur.textId);
      if (exist) {
        committedTextsRef.current.set(cur.textId, {
          ...exist,
          text: val,
          x: cur.x,
          y: cur.y,
          color: cur.color,
          size: cur.size,
          font: cur.font,
          outline: outlineSnapshot,
        });
      }
    }
  };
  const onDown = (e: PointerEvent) => {
    if (readOnlyRef.current || toolRef.current !== "text") return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest('[data-ui-panel]')) return;
    const el = e.target as HTMLElement;
    if (el && el.id && el.id.startsWith("committed-")) {
      const textId = el.id.replace("committed-", "");
      const cur = committedTextsRef.current.get(textId);
      if (cur) {
        const outlineClone = cloneOutline(cur.outline ?? textOutlineRef.current);
        curTextRef2.current = { textId: cur.textId, strokeId: cur.strokeId, x: cur.x, y: cur.y, size: cur.size, color: cur.color, font: cur.font, outline: outlineClone, lastSent: 0, committed: true };
        setTextInputValue(cur.text);
        setSelectedTextId(cur.textId);
        const c = containerRef.current;
        if (c) {
          const rect = c.getBoundingClientRect();
          const scr = boardNormToScreen(cur.x, cur.y);
          const px = scr.x - rect.left;
          const py = scr.y - rect.top;
          const clientW = rect.width;
          let left = px;
          if (left + textInputUi.current.width > clientW - 10) left = Math.max(60, clientW - textInputUi.current.width - 10);
          textInputUi.current.left = left;
          const top = Math.max(0, py - cur.size - 8);
          textInputUi.current.top = top;
        }
        setTextInputActive(true);
        requestAnimationFrame(() => textInputRef.current?.focus());
        e.preventDefault();
        return;
      }
    }
    const pos = screenToBoardNorm(e.clientX, e.clientY);
    const nx = pos.x;
    const ny = pos.y + (textSizeRef.current / 2) / BOARD_H;
    const textId = `${id}-txt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const strokeId = `${id}-text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const outlineClone = cloneOutline(textOutlineRef.current);
  curTextRef2.current = { textId, strokeId, x: nx, y: ny, size: textSizeRef.current, color: textColorRef.current, font: textFontRef.current, outline: outlineClone, lastSent: 0, committed: false };
    setTextInputValue("");
    setSelectedTextId(textId);
    setSelectedImageId(null);
    const c2 = containerRef.current;
    if (c2) {
      const crect = c2.getBoundingClientRect();
      const scr = boardNormToScreen(nx, ny);
      const px = scr.x - crect.left;
      const py = scr.y - crect.top;
      const clientW = crect.width;
      let left = px;
      if (left + textInputUi.current.width > clientW - 10) left = Math.max(60, clientW - textInputUi.current.width - 10);
      textInputUi.current.left = left;
      textInputUi.current.top = Math.max(0, py - textSizeRef.current - 8);
    }
    setTextInputActive(true);
    requestAnimationFrame(() => textInputRef.current?.focus());
  };
  container.addEventListener("pointerdown", onDown);
  const detach = () => container.removeEventListener("pointerdown", onDown);
  return { detach, sendTextImmediate };
}
