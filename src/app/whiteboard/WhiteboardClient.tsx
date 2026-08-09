"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { sanitizeUrl } from "@braintree/sanitize-url";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Socket } from "socket.io-client";
import { BOARD_W, BOARD_H, CYCLE_MIN_MS, CYCLE_MAX_MS } from "./constants";
import { chromaColor as computeChromaColor } from "./utils/chroma";
import { primaryFamily as primaryFontFamily, ensureGoogleFontLoaded, GOOGLE_FONT_NAMES, buildFontOptions, FONT_FALLBACK_STACK, withFontFallback } from "./utils/fonts";
import { sha256Hex } from "./utils/hash";
import { computeFingerprintFromHistory } from "./utils/fingerprint";
import { fingerprintHistory } from "@/lib/historyProtocol.mjs";
import { SnapshotAssembler } from "./services/snapshotAssembler";
import { createOutbox } from "./services/outbox";
import { connectSocket } from "./services/socket";
import { createReplayer } from "./rendering/canvas";
import { DvdState, RotAnimState, CommittedText, CommittedImage, ImageChromaKeyState, TextOutlineConfig } from "./types";
import { startAnimationLoop, ensureDvdState as ensureDvdStateSvc, ensureRotState as ensureRotStateSvc } from "./services/animation";
import { rebuildCommittedImages, rebuildCommittedTexts, rebuildImageAnimStates, rebuildTextAnimStates } from "./services/history";
import { attachPenAndEraser } from "./tools/pen";
import { Tool, LatencyStats, ChromaConfig, CursorPayload, UndoRedoPayload, TextLivePayload, TextCommitEvent, TextUpdateEvent, ImageCommitEvent, ImageUpdateEvent, HistoryEvent, SnapshotMessage, SnapshotMeta, SnapshotChunk, PingPayload, AnimControlPayload, FontCycleControlPayload, ChatMessage, PresenceMessage, ServerMessage2, PeerCursor, TextClip, ImageClip, DriftReply, ImageHandleKey } from "./types";
declare global {
  interface Window {
    EyeDropper?: new () => {
      open: () => Promise<{ sRGBHex?: string }>;
    };
  }
}
import { userColor } from "./utils/color";
import { attachMediaTool } from "./tools/media";
import { attachTextTool } from "./tools/text";
import { attachHandTool } from "./tools/hand";
import ChromaKeyCanvas from "./rendering/ChromaKeyCanvas";
import { ToolIcon, TOOL_LABELS, TOOL_BADGE_BG, ensureToolIconImage } from "./icons/toolIcons";
import {
  cloneTextOutline,
  computeHandleAnchorMapping,
  cursorPaletteFor,
  effectiveOutlineValue,
  horizontalComponent,
  looksAnimatedImage,
  OUTLINE_BASE_FONT_PX,
  verticalComponent,
} from "./utils/helpers";

const TOOLBAR_ITEMS: { key: Tool; title: string }[] = [
  { key: "select", title: TOOL_LABELS.select },
  { key: "hand", title: TOOL_LABELS.hand },
  { key: "pen", title: TOOL_LABELS.pen },
  { key: "eraser", title: TOOL_LABELS.eraser },
  { key: "text", title: TOOL_LABELS.text },
  { key: "media", title: TOOL_LABELS.media },
];
const LATENCY_REFRESH_INTERVAL_MS = 1000;
const LATENCY_SAMPLE_SIZE = 20;
const BUFFER_DRAIN_BATCH_SIZE = 80;
const ACTIVE_WINDOW_MS = 60 * 1000;
const CHAT_MAX_ITEMS = 200;
const CHAT_TTL_MS = 20 * 60 * 1000;
type ThemePalette = {
  areaBackground: string;
  boardBackground: string;
  boardGridMinor: string;
  boardGridMajor: string;
  boardShadow: string;
  progressTrack: string;
  progressFill: string;
  panelBackground: string;
  panelText: string;
  panelMutedText: string;
  panelDivider: string;
  panelBorderColor: string;
  panelShadow: string;
  controlButtonHover: string;
  controlButtonText: string;
  badgeBackground: string;
  badgeText: string;
  chipBackground: string;
  chipText: string;
  inputBackground: string;
  inputText: string;
  inputPlaceholder: string;
  primaryButtonBg: string;
  primaryButtonHover: string;
  primaryButtonText: string;
  neutralButtonBg: string;
  neutralButtonHover: string;
  neutralButtonText: string;
  overlayScrim: string;
  modalBackground: string;
  modalText: string;
  modalBorder: string;
  toolIconFilter: string;
};



export default function WhiteboardClient({
  name,
  readOnly = false,
  socketToken,
}: {
  name: string;
  readOnly?: boolean;
  socketToken?: string;
}) {
  const router = useRouter();
  const apiAuthorizationHeaders = useMemo<Record<string, string>>(() => {
    const headers: Record<string, string> = {};
    if (socketToken) headers.authorization = `Bearer ${socketToken}`;
    return headers;
  }, [socketToken]);
  const redirectReasonRef = useRef<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const outbox = useRef<ReturnType<typeof createOutbox> | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotProgress, setSnapshotProgress] = useState<{ total: number; got: number } | null>(null);
  const [mediaProgress, setMediaProgress] = useState<{ total: number; got: number } | null>(null);
  const id = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const [, forceTick] = useState(0);
  const [isDarkTheme, setIsDarkTheme] = useState(false);
  const hasExplicitThemePreferenceRef = useRef(false);
  const handleThemeToggle = useCallback(() => {
    hasExplicitThemePreferenceRef.current = true;
    setIsDarkTheme(prev => !prev);
  }, []);
  const handleSignOut = useCallback(async () => {
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      router.replace("/");
      router.refresh();
    }
  }, [router]);
  const themePalette = useMemo<ThemePalette>(() => {
    if (isDarkTheme) {
      return {
        areaBackground: "#222222ff",
        boardBackground: "#e0e0e0ff",
        boardGridMinor: "rgba(15, 23, 42, 0.08)",
        boardGridMajor: "rgba(15, 23, 42, 0.14)",
        boardShadow: "0 36px 60px rgba(3, 6, 12, 0.45)",
        progressTrack: "rgba(255, 255, 255, 0.24)",
        progressFill: "#90bff8ff",  
        panelBackground: "rgba(11, 15, 23, 0.92)",
        panelText: "#e8edf7",
        panelMutedText: "rgba(180, 196, 214, 0.78)",
        panelDivider: "rgba(71, 85, 105, 0.55)",
        panelBorderColor: "rgba(63, 78, 102, 0.75)",
        panelShadow: "0 24px 48px rgba(1, 3, 7, 0.66)",
        controlButtonHover: "rgba(96, 165, 250, 0.2)",
        controlButtonText: "#f8fafc",
        badgeBackground: "rgba(59, 130, 246, 0.3)",
        badgeText: "#e0f2fe",
        chipBackground: "rgba(148, 163, 184, 0.16)",
        chipText: "rgba(226, 232, 240, 0.9)",
        inputBackground: "rgba(22, 28, 40, 0.95)",
        inputText: "#f8fafc",
        inputPlaceholder: "rgba(148, 163, 184, 0.7)",
        primaryButtonBg: "rgba(59, 130, 246, 0.92)",
        primaryButtonHover: "rgba(59, 130, 246, 1)",
        primaryButtonText: "#f8fafc",
        neutralButtonBg: "rgba(22, 30, 44, 0.85)",
        neutralButtonHover: "rgba(41, 53, 75, 0.92)",
        neutralButtonText: "#dce3f0",
        overlayScrim: "rgba(4, 6, 12, 0.84)",
        modalBackground: "rgba(12, 16, 25, 0.96)",
        modalText: "#e2e8f0",
        modalBorder: "1px solid rgba(63, 78, 102, 0.75)",
        toolIconFilter: "invert(1) saturate(1.15)",
      };
    }
    return {
      areaBackground: "#dbe0e8",
      boardBackground: "#f9fafb",
      boardGridMinor: "rgba(0, 0, 0, 0.06)",
      boardGridMajor: "rgba(0, 0, 0, 0.12)",
      boardShadow: "0 26px 48px rgba(15, 23, 42, 0.18)",
      progressTrack: "rgba(15, 23, 42, 0.12)",
      progressFill: "#1d4ed8",
      panelBackground: "rgba(255, 255, 255, 0.94)",
      panelText: "#0f172a",
      panelMutedText: "rgba(71, 85, 105, 0.75)",
      panelDivider: "rgba(148, 163, 184, 0.4)",
      panelBorderColor: "rgba(226, 232, 240, 0.9)",
      panelShadow: "0 20px 34px rgba(15, 23, 42, 0.18)",
      controlButtonHover: "rgba(37, 99, 235, 0.15)",
      controlButtonText: "#0f172a",
      badgeBackground: "rgba(37, 99, 235, 0.12)",
      badgeText: "#1d4ed8",
      chipBackground: "rgba(15, 23, 42, 0.08)",
      chipText: "rgba(51, 65, 85, 0.85)",
      inputBackground: "#ffffff",
      inputText: "#0f172a",
      inputPlaceholder: "rgba(100, 116, 139, 0.7)",
      primaryButtonBg: "rgba(37, 99, 235, 0.92)",
      primaryButtonHover: "rgba(37, 99, 235, 1)",
      primaryButtonText: "#f8fafc",
      neutralButtonBg: "rgba(248, 250, 252, 0.95)",
      neutralButtonHover: "rgba(226, 232, 240, 1)",
      neutralButtonText: "#0f172a",
      overlayScrim: "rgba(15, 23, 42, 0.48)",
      modalBackground: "#ffffff",
      modalText: "#0f172a",
      modalBorder: "1px solid rgba(226, 232, 240, 0.9)",
      toolIconFilter: "none",
    };
  }, [isDarkTheme]);
  const [, setLatencyStats] = useState<LatencyStats>({
    pingMs: null,
    avgPingMs: null,
    upstreamMs: null,
    downstreamMs: null,
    serverProcessMs: null,
    sendPending: 0,
    sendBacklogMs: 0,
    receiveGapMs: 0,
    bufferedEvents: 0,
  });
  const lastInboundAtRef = useRef<number>(0);
  const pingSeqRef = useRef(0);
  const pendingPingRef = useRef<Map<number, number>>(new Map());
  const pingSamplesRef = useRef<number[]>([]);
  const peers = useRef<Map<string, PeerCursor>>(new Map());
  const selfPos = useRef<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);  
  const peerRenderRef = useRef<Map<string, { x: number; y: number; tx: number; ty: number; lastSeen: number }>>(new Map());
  const lastDrawTsRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);  
  const areaRef = useRef<HTMLDivElement | null>(null);  
  const boardRef = useRef<HTMLCanvasElement | null>(null);  
  const recentMediaRef = useRef<Map<string, { url: string; kind: 'image' | 'video'; w: number; h: number; contentType: string; animated?: boolean }>>(new Map());
  const stageRef = useRef<HTMLDivElement | null>(null);  
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });  
  const scaleRef = useRef<number>(1);
  const [viewTransform, setViewTransform] = useState<{ x: number; y: number; s: number }>({ x: 0, y: 0, s: 1 });
  const panDragRef = useRef<null | { startX: number; startY: number; origX: number; origY: number }>(null);
  const panOverrideRef = useRef(false);
  const marqueeRef = useRef<null | { start: { x: number; y: number }; end: { x: number; y: number } }>(null);
  const [penColor, setPenColor] = useState("\#20c124");
  const [penSize, setPenSize] = useState(4);
  const [tool, setTool] = useState<Tool>("pen");
  const [textColor, setTextColor] = useState("\#111111");
  const [textSize, setTextSize] = useState(24);
  const [textFont, setTextFont] = useState(FONT_FALLBACK_STACK);
  const [textOutline, setTextOutline] = useState<TextOutlineConfig>({
    enabled: false,
    color: "#000000",
    width: 4,
    feather: 2,
    chroma: { enabled: false, speed: 120, saturation: 100, lightness: 50, startAt: 0 },
  });
  const GOOGLE_FONTS = useMemo(() => GOOGLE_FONT_NAMES, []);
  const FONT_OPTIONS = useMemo(() => buildFontOptions(GOOGLE_FONTS), [GOOGLE_FONTS]);
  const requestedFontsRef = useRef<Set<string>>(new Set());
  const loadGoogleFont = useCallback(async (family: string) => {
    if (typeof window === 'undefined') return;
    if (!GOOGLE_FONTS.includes(family)) return;  
    if (requestedFontsRef.current.has(family)) return;
    requestedFontsRef.current.add(family);
    await ensureGoogleFontLoaded({ family });
    try { forceTick(t => t + 1); } catch {}
  }, [GOOGLE_FONTS]);
  const ensureFontLoaded = useCallback((css: string) => {
    const fam = primaryFontFamily(css);
    if (fam) loadGoogleFont(fam);
  }, [loadGoogleFont]);
  const [fontCycleOn, setFontCycleOn] = useState(false);
  const speedFromMs = useCallback((ms: number) => {
    const clamped = Math.max(CYCLE_MIN_MS, Math.min(CYCLE_MAX_MS, ms));
    return Math.round(((CYCLE_MAX_MS - clamped) / (CYCLE_MAX_MS - CYCLE_MIN_MS)) * 100);
  }, []);
  const msFromSpeed = useCallback((speed: number) => {
    const s = Math.max(0, Math.min(100, speed));
    return Math.round(CYCLE_MAX_MS - (CYCLE_MAX_MS - CYCLE_MIN_MS) * (s / 100));
  }, []);
  const [fontCycleMs, setFontCycleMs] = useState(800);
  const [fontCycleSpeed, setFontCycleSpeed] = useState<number>(() => speedFromMs(800));
  const [eraserSize, setEraserSize] = useState(16);
  const [showGrid, setShowGrid] = useState(false);
  const [penChroma, setPenChroma] = useState<ChromaConfig>({ enabled: false, speed: 120, saturation: 100, lightness: 50, startAt: 0 });
  const [textChroma, setTextChroma] = useState<ChromaConfig>({ enabled: false, speed: 120, saturation: 100, lightness: 50, startAt: 0 });
  const chromaColor = useCallback((c: ChromaConfig) => computeChromaColor(c), []);
  const hasCommittedChroma = useCallback(() => {
    if (textOutline.enabled && textOutline.chroma?.enabled) return true;
    for (const v of committedTextsRef.current.values()) {
      if (v.chroma?.enabled) return true;
      if (v.outline?.enabled && v.outline.chroma?.enabled) return true;
    }
    for (const v of committedImagesRef.current.values()) {
      if ((v.filter ?? "none") === "rainbow") return true;
    }
    return false;
  }, [textOutline]);
  useEffect(() => {
    let raf = 0;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      if (penChroma.enabled || textChroma.enabled || hasCommittedChroma()) {
        forceTick(t => t + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [penChroma.enabled, textChroma.enabled, textOutline.enabled, textOutline.chroma?.enabled, hasCommittedChroma]);
  const remotePaths = useRef<Map<string, { x: number; y: number } | null>>(new Map());
  const historyRef = useRef<HistoryEvent[]>([]);
  const undoneRef = useRef<Set<string>>(new Set());
  const myStrokesRef = useRef<string[]>([]);
  const undoOrderRef = useRef<string[]>([]);
  const editingTextRef = useRef<null | {
    textId: string;
    x: number;
    y: number;
    text: string;
    color: string;
    size: number;
    font: string;
    strokeId: string;
    width: number;
    height: number;
    outline?: TextOutlineConfig;
  }>(null);
  const overlayTextsRef = useRef<Map<string, { textId: string; x: number; y: number; text: string; color: string; size: number; font: string; width?: number; height?: number; outline?: TextOutlineConfig }>>(new Map());
  const committedTextsRef = useRef<Map<string, CommittedText>>(new Map());
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [selectedTextIds, setSelectedTextIds] = useState<string[]>([]);
  useEffect(() => {
    if (!fontCycleOn) return;
    if (selectedTextId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (!alive) return;
      if (FONT_OPTIONS.length > 0) {
        const opt = FONT_OPTIONS[Math.floor(Math.random() * FONT_OPTIONS.length)]!;
        loadGoogleFont(opt.label);
        setTextFont(opt.value);
      }
      timer = setTimeout(tick, Math.max(CYCLE_MIN_MS, fontCycleMs));
    };
    timer = setTimeout(tick, Math.max(CYCLE_MIN_MS, fontCycleMs));
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [fontCycleOn, fontCycleMs, selectedTextId, FONT_OPTIONS, loadGoogleFont]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (!alive) return;
      const opts = FONT_OPTIONS;
      if (opts.length === 0) { timer = setTimeout(tick, 500); return; }
      let any = false;
      for (const [textId, st] of fontCycleStateRef.current.entries()) {
        if (!st.enabled) continue;
        const cur = committedTextsRef.current.get(textId);
        if (!cur) continue;
        const nextIdx = ((st.lastIdx ?? Math.floor(Math.random() * opts.length)) + 1) % opts.length;
        const opt = opts[nextIdx]!;
        loadGoogleFont(opt.label);
        committedTextsRef.current.set(textId, { ...cur, font: opt.value });
        st.lastIdx = nextIdx;
        any = true;
      }
      if (any) { try { forceTick(t => t + 1); } catch {} }
      let delay = Infinity;
      for (const st of fontCycleStateRef.current.values()) {
        if (st.enabled) delay = Math.min(delay, Math.max(CYCLE_MIN_MS, st.ms));
      }
      if (!isFinite(delay)) delay = 800;
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, 400);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [FONT_OPTIONS, loadGoogleFont]);
  const committedImagesRef = useRef<Map<string, CommittedImage>>(new Map());
  const IMAGE_FILTERS = useMemo<Record<string, string>>(() => ({
    none: "none",
    grayscale: "grayscale(100%)",
    sepia: "sepia(85%)",
    invert: "invert(100%)",
    wash: "contrast(85%) brightness(120%) saturate(90%)",
    punch: "contrast(130%) saturate(140%)",
    noir: "grayscale(100%) contrast(130%) brightness(90%)",
    vintage: "sepia(60%) contrast(110%) brightness(95%) saturate(120%)",
    cold: "hue-rotate(200deg) saturate(120%)",
    warm: "hue-rotate(-20deg) saturate(120%)",
    pop: "saturate(180%) contrast(115%)",
    shadow: "drop-shadow(0 2px 6px rgba(0,0,0,0.5))",
  rainbow: "none",
  }), []);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const pendingImageRef = useRef<null | { src: string; naturalW: number; naturalH: number; kind?: "image" | "video"; animated?: boolean; origin?: 'link' | 'upload' }>(null);
  const brokenImageIdsRef = useRef<Set<string>>(new Set());
  const imagePreviewRef = useRef<null | { x: number; y: number; scale: number }>(null);
  const addMediaAccessToken = useCallback((path: string): string => {
    if (!socketToken || !path.startsWith("/api/media/")) return path;
    try {
      const url = new URL(path, window.location.origin);
      url.searchParams.set("access_token", socketToken);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return path;
    }
  }, [socketToken]);
  const normalizeMediaSrc = useCallback((src: string): string => {
    if (!src) return "";
    const sanitized = sanitizeUrl(src);
    if (!sanitized || sanitized === "about:blank") return "";
    const trimmed = sanitized.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/api/media/")) return addMediaAccessToken(trimmed);
    if (trimmed.startsWith("/")) return trimmed;
    if (/^data:(?:image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm));/i.test(trimmed)) return trimmed;
    if (trimmed.startsWith("blob:")) return trimmed;
    if (!/^https?:/i.test(trimmed)) return "";
    const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const currentHost = typeof window !== "undefined" ? window.location.host : "";
    try {
      const u = new URL(trimmed, origin);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      if (currentHost && u.host === currentHost) {
        return addMediaAccessToken(u.pathname + u.search + u.hash);
      }
      return addMediaAccessToken(`/api/media/proxy?url=${encodeURIComponent(u.toString())}`);
    } catch {
      return "";
    }
  }, [addMediaAccessToken]);
  const dvdTextStateRef = useRef<Map<string, DvdState>>(new Map());
  const dvdImageStateRef = useRef<Map<string, DvdState>>(new Map());
  const rotTextStateRef = useRef<Map<string, RotAnimState>>(new Map());
  const rotImageStateRef = useRef<Map<string, RotAnimState>>(new Map());
  const pendingTextUpdatesRef = useRef<Map<string, Partial<TextUpdateEvent>>>(new Map());
  const pendingImageUpdatesRef = useRef<Map<string, Partial<ImageUpdateEvent>>>(new Map());
  const fontCycleStateRef = useRef<Map<string, { enabled: boolean; ms: number; lastIdx?: number; baseFont?: string }>>(new Map());
  const imageChromaStateRef = useRef<Map<string, { speed: number; saturation: number; lightness: number }>>(new Map());
  const imageChromaKeyStateRef = useRef<Map<string, ImageChromaKeyState>>(new Map());
  const [chromaKeyEditTarget, setChromaKeyEditTarget] = useState<string | null>(null);
  const [chromaPicking, setChromaPicking] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingImageName, setPendingImageName] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageUploadProgress, setImageUploadProgress] = useState<number | null>(null);
  const [mediaProcessing, setMediaProcessing] = useState(false);
  const [previewPreparing, setPreviewPreparing] = useState(false);
  const [mediaPhase, setMediaPhase] = useState<null | 'analyze' | 'lookup' | 'upload' | 'process' | 'preview'>(null);
  const mediaBusyRef = useRef(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const setMediaBusyTrue = useCallback(() => {
    mediaBusyRef.current = true;
    setMediaBusy(true);
  }, []);
  const setMediaBusyFalse = useCallback(() => {
    mediaBusyRef.current = false;
    setMediaBusy(false);
  }, []);
  const [quietReconnect, setQuietReconnect] = useState(false);
  const liveSocketStateRef = useRef({
    name,
    tool,
    penSize,
    textSize,
    eraserSize,
    textOutline,
    quietReconnect,
  });
  useEffect(() => {
    liveSocketStateRef.current = {
      name,
      tool,
      penSize,
      textSize,
      eraserSize,
      textOutline,
      quietReconnect,
    };
  }, [name, tool, penSize, textSize, eraserSize, textOutline, quietReconnect]);
  const retriedMediaRef = useRef<Set<string>>(new Set());
  const currentUploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const currentUploadTokenRef = useRef<{ id: string; aborted: boolean } | null>(null);
  const clipboardRef = useRef<null | { texts: TextClip[]; images: ImageClip[] }>(null);
  const pasteBumpRef = useRef(0);
  type ChatLogItem = { kind: "sys" | "msg"; text: string; name?: string; id?: string; ts: number };
  const [chatOpen, setChatOpen] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatLog, setChatLog] = useState<ChatLogItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const chatOpenRef = useRef(true);
  useEffect(() => { chatOpenRef.current = chatOpen; }, [chatOpen]);
  type Participant = { id: string; name: string; online: boolean; lastSeen: number };
  const participantsRef = useRef<Map<string, Participant>>(new Map());
  const [rosterHover, setRosterHover] = useState(false);
  useEffect(() => {
    participantsRef.current.set(id, { id, name, online: true, lastSeen: Date.now() });
    forceTick(t => t + 1);
  }, [id, name]);
  const getRoster = useCallback(() => {
    const now = Date.now();
    const list = Array.from(participantsRef.current.values());
    const active = list.filter(p => p.online && (now - p.lastSeen) < ACTIVE_WINDOW_MS);
    const passive = list.filter(p => !active.some(a => a.id === p.id));
    active.sort((a, b) => a.name.localeCompare(b.name));
    passive.sort((a, b) => a.name.localeCompare(b.name));
    return { active, passive, count: active.length };
  }, []);
  const touchParticipant = useCallback((pid: string, pname?: string) => {
    const now = Date.now();
    const prev = participantsRef.current.get(pid);
    const nm = (pname ?? prev?.name ?? "Anon");
    if (prev) {
      const next = { ...prev, name: nm, lastSeen: now };
      participantsRef.current.set(pid, next);
    } else {
      participantsRef.current.set(pid, { id: pid, name: nm, online: true, lastSeen: now });
    }
    requestAnimationFrame(() => forceTick(t => t + 1));
  }, []);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef2 = useRef<HTMLInputElement | null>(null);
  const typingPeersRef = useRef<Map<string, { name: string; last: number }>>(new Map());
  const lastTypingSentRef = useRef(0);
  const typingStopTimerRef = useRef<number | null>(null);
  const chatSeenRef = useRef<Set<string>>(new Set());
  const snapshotReadyRef = useRef(false);
  const unsyncRef = useRef<{ bad: number; shown: boolean; fixing: boolean }>({ bad: 0, shown: false, fixing: false });
  const [unsyncShown, setUnsyncShown] = useState(false);
  const unsyncSuppressUntilRef = useRef<number>(0);
  const lastNetworkSendAtRef = useRef<number>(0);
  const [wsEpoch, setWsEpoch] = useState(0);
  const pageHiddenRef = useRef<boolean>(false);
  const pageHiddenAtRef = useRef<number | null>(null);
  const incomingBufferRef = useRef<string[]>([]);
  const drainingRef = useRef<boolean>(false);
  const pruneChat = useCallback((list: ChatLogItem[]) => {
    const now = Date.now();
    const aged = list.filter(m => now - m.ts <= CHAT_TTL_MS);
    return aged.length > CHAT_MAX_ITEMS ? aged.slice(-CHAT_MAX_ITEMS) : aged;
  }, []);
  const addChatItem = useCallback((item: ChatLogItem) => {
    setChatLog(l => pruneChat([...l, item]));
  }, [pruneChat]);
  const fmtClock = useCallback((ts: number) => {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      setChatLog(l => pruneChat(l));
    }, 60 * 1000);
    return () => clearInterval(t);
  }, [pruneChat]);
  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = chatListRef.current;
    if (!el) return;
    try { el.scrollTo({ top: el.scrollHeight, behavior }); } catch {
      el.scrollTop = el.scrollHeight;
    }
  }, []);
  const isNearBottom = useCallback(() => {
    const el = chatListRef.current;
    if (!el) return true;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 48;  
  }, []);
  useEffect(() => {
    if (!chatOpen) return;
    const id = requestAnimationFrame(() => {
      chatInputRef2.current?.focus();
      scrollChatToBottom("auto");
      setUnreadCount(0);
    });
    return () => cancelAnimationFrame(id);
  }, [chatOpen, scrollChatToBottom]);
  useEffect(() => {
    if (!chatOpen) return;
    if (isNearBottom()) scrollChatToBottom("auto");
  }, [chatLog.length, chatOpen, isNearBottom, scrollChatToBottom]);
  const dragStateRef = useRef<
    | null
    | {
        entity: "text" | "image";
        kind: "move" | "resize";
        id: string;
        startX: number;
        startY: number;
        shift?: boolean;
        anchor?: ImageHandleKey;
        handle?: ImageHandleKey;
        origin: { x: number; y: number; width?: number; height?: number; aspect?: number };
      }
  >(null);
  const lastDragSentRef = useRef<number>(0);
  const pendingDragUpdateRef = useRef<null | (TextUpdateEvent | ImageUpdateEvent)>(null);
  const dragFlushRafRef = useRef<number>(0);
  const DRAG_SEND_INTERVAL_MS = 40;  
  const [textInputActive, setTextInputActive] = useState(false);
  const [textInputValue, setTextInputValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, type: "text" | "image", id: string } | null>(null);

  const textInputActiveRef = useRef(false);
  useEffect(() => { textInputActiveRef.current = textInputActive; }, [textInputActive]);
  const textInputValueRef = useRef("");
  useEffect(() => { textInputValueRef.current = textInputValue; }, [textInputValue]);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const textInputUi = useRef<{ left: number; top: number; width: number }>({ left: 80, top: 5, width: 500 });
  const curTextRef2 = useRef<{ textId: string; strokeId: string; x: number; y: number; size: number; color: string; font: string; outline: TextOutlineConfig; lastSent: number; committed: boolean } | null>(null);
  const screenToBoardNorm = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const crect = container.getBoundingClientRect();
    const pan = panRef.current;
    const s = scaleRef.current;
    const cx = clientX - crect.left;
    const cy = clientY - crect.top;
    const bx = (cx - pan.x) / Math.max(1e-6, s);
    const by = (cy - pan.y) / Math.max(1e-6, s);
    return { x: bx / BOARD_W, y: by / BOARD_H };
  }, []);
  const boardNormToScreen = useCallback((nx: number, ny: number) => {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const crect = container.getBoundingClientRect();
    const pan = panRef.current;
    const s = scaleRef.current;
    const px = nx * BOARD_W * s + pan.x + crect.left;
    const py = ny * BOARD_H * s + pan.y + crect.top;
    return { x: px, y: py };
  }, []);
  useEffect(() => {
    if (!readOnly) return;
    const fit = () => {
      const container = containerRef.current;
      if (!container) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (!cw || !ch) return;
      const s = Math.min(cw / BOARD_W, ch / BOARD_H);
      const x = Math.max(0, (cw - BOARD_W * s) / 2);
      const y = Math.max(0, (ch - BOARD_H * s) / 2);
      panRef.current = { x, y };
      scaleRef.current = s;
      setViewTransform({ x, y, s });
    };
    fit();
    const ro = new ResizeObserver(() => fit());
    const el = containerRef.current;
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [readOnly]);
  const startFlush = useCallback(() => { outbox.current?.start(); }, []);
  const sendCritical = useCallback((obj: unknown) => {
    lastNetworkSendAtRef.current = Date.now();
  outbox.current?.send(obj);
  }, []);
  const computeFingerprint = useCallback((): { v: number; c: number; u: number; h: number } => {
    return computeFingerprintFromHistory(historyRef.current, undoneRef.current.size);
  }, []);
  const computeFpKeys = useCallback((): { keys: string[]; undone: string[] } => {
    const { keys } = fingerprintHistory(historyRef.current, undoneRef.current.size);
    return { keys, undone: Array.from(undoneRef.current) };
  }, []);
  const sendPing = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) return;
    if (!snapshotReadyRef.current) return;
    pingSeqRef.current += 1;
    const seq = pingSeqRef.current;
    const sentAt = Date.now();
    pendingPingRef.current.set(seq, sentAt);
    const fp = computeFingerprint();
    const payload: PingPayload = { type: "ping", id, name, fp, seq, clientTs: sentAt };
    try {
      socket.emit("message", payload);
    } catch {
      pendingPingRef.current.delete(seq);
    }
  }, [computeFingerprint, id, name]);
  const ensureImageNaturalInfo = useCallback((imageId: string) => {
    const cur = committedImagesRef.current.get(imageId);
    if (!cur || (cur.naturalW && cur.naturalH && cur.aspect)) return;
    if (cur.mediaKind === 'video') {
      try {
        const container = document.querySelector(`[data-image-id="${CSS.escape(imageId)}"]`) as HTMLElement | null;
        const existing = container?.querySelector('video') as HTMLVideoElement | null;
        if (existing) {
          if (existing.readyState >= 1) {
            const fallbackW = Math.max(1, Math.round((cur.width || 0.2) * BOARD_W));
            const fallbackH = Math.max(1, Math.round((cur.height || 0.2) * BOARD_H));
            const naturalW = existing.videoWidth || fallbackW;
            const naturalH = existing.videoHeight || fallbackH;
            const aspect = naturalW > 0 && naturalH > 0 ? naturalW / naturalH : (fallbackW / Math.max(1e-6, fallbackH));
            committedImagesRef.current.set(imageId, { ...cur, naturalW, naturalH, aspect });
            forceTick(t => t + 1);
            return;
          }
          existing.addEventListener('loadedmetadata', () => {
            const fallbackW = Math.max(1, Math.round((cur.width || 0.2) * BOARD_W));
            const fallbackH = Math.max(1, Math.round((cur.height || 0.2) * BOARD_H));
            const naturalW = existing.videoWidth || fallbackW;
            const naturalH = existing.videoHeight || fallbackH;
            const aspect = naturalW > 0 && naturalH > 0 ? naturalW / naturalH : (fallbackW / Math.max(1e-6, fallbackH));
            committedImagesRef.current.set(imageId, { ...cur, naturalW, naturalH, aspect });
            forceTick(t => t + 1);
          }, { once: true });
          return;
        }
      } catch {}
      return;
    }
  const img = new Image();
    img.onload = () => {
      const fallbackW = Math.max(1, Math.round((cur.width || 0.2) * BOARD_W));
      const fallbackH = Math.max(1, Math.round((cur.height || 0.2) * BOARD_H));
      const naturalW = img.naturalWidth || fallbackW;
      const naturalH = img.naturalHeight || fallbackH;
      const aspect = naturalW > 0 && naturalH > 0 ? naturalW / naturalH : (fallbackW / Math.max(1e-6, fallbackH));
      committedImagesRef.current.set(imageId, { ...cur, naturalW, naturalH, aspect });
      forceTick(t => t + 1);
    };
    img.src = normalizeMediaSrc(cur.src);
  }, [normalizeMediaSrc]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const stats = outbox.current?.getStats?.();
      const now = Date.now();
      const receiveGapMs = Math.max(0, now - (lastInboundAtRef.current || now));
      for (const [seq, sentAt] of pendingPingRef.current) {
        if (now - sentAt > 30000) pendingPingRef.current.delete(seq);
      }
      setLatencyStats(prev => ({
        ...prev,
        sendPending: stats?.pending ?? 0,
        sendBacklogMs: stats?.backlogMs ?? 0,
        receiveGapMs,
        bufferedEvents: incomingBufferRef.current.length,
      }));
    }, LATENCY_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
  const preloadSnapshotMedia = useCallback(async () => {
    const items = Array.from(committedImagesRef.current.values());
    const unique: Array<{ src: string; kind: "image" | "video" }> = [];
    const seen = new Set<string>();
    for (const it of items) {
      if (!it.src) continue;
      const kind: "image" | "video" = it.mediaKind === "video" ? "video" : "image";
      const srcNorm = normalizeMediaSrc(it.src);
      const key = `${kind}|${srcNorm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (kind === "image") unique.push({ src: srcNorm, kind });
    }
    if (unique.length === 0) return;
    setMediaBusyTrue();
    setMediaProgress({ total: unique.length, got: 0 });
    let done = 0;
    const bump = () => setMediaProgress({ total: unique.length, got: ++done });
  const FATAL_RETRIES = 1;  
  const TIMEOUT_MS = 8000;  
  const TOTAL_DEADLINE_MS = Math.max(10000, unique.length * 1200);  
  const deadlineAt = Date.now() + TOTAL_DEADLINE_MS;
    const loadImage = async (src: string) => {
      for (let attempt = 1; attempt <= FATAL_RETRIES; attempt++) {
        const ok = await new Promise<boolean>(resolve => {
          const img = new Image();
          let finished = false;
          const timer = window.setTimeout(() => { if (finished) return; finished = true; img.src = ""; resolve(false); }, TIMEOUT_MS);
          img.onload = () => { if (finished) return; finished = true; window.clearTimeout(timer); try { img.decode?.().catch(() => {}); } catch {} resolve(true); };
          img.onerror = () => { if (finished) return; finished = true; window.clearTimeout(timer); resolve(false); };
          img.crossOrigin = "anonymous";
          try { img.decoding = "async" as unknown as HTMLImageElement["decoding"]; } catch { try { img.setAttribute("decoding", "async"); } catch {} }
          img.src = normalizeMediaSrc(src);
        });
        if (ok) return true;
        await new Promise(r => setTimeout(r, 200 + attempt * 200));
      }
      return false;
    };
  const loadVideo = async () => true;
  const MAX_CONCURRENCY = 4;
    const queue = unique.slice();
    const runner = async () => {
      while (queue.length) {
        if (Date.now() > deadlineAt) {
          const left = queue.splice(0);
          for (let i = 0; i < left.length; i++) bump();
          break;
        }
        const it = queue.shift();
        if (!it) break;
        try {
          if (it.kind === "video") await loadVideo(); else await loadImage(it.src);
        } catch {}
        bump();
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENCY, queue.length); i++) workers.push(runner());
    await Promise.all(workers);
    setMediaBusyFalse();
    setMediaProgress(p => p ? { ...p } : p);
  }, [normalizeMediaSrc, setMediaBusyFalse, setMediaBusyTrue]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    let next = media?.matches ?? false;
    let explicit = false;
    try {
      const saved = window.localStorage.getItem("obsdraw-theme");
      if (saved === "dark" || saved === "light") {
        next = saved === "dark";
        explicit = true;
      }
    } catch {}
    hasExplicitThemePreferenceRef.current = explicit;
    setIsDarkTheme(prev => (prev === next ? prev : next));
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    if (!media) return;
    const listener = (event: MediaQueryListEvent) => {
      if (hasExplicitThemePreferenceRef.current) return;
      setIsDarkTheme(event.matches);
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    }
    if (typeof media.addListener === "function") {
      media.addListener(listener);
      return () => media.removeListener(listener);
    }
    return undefined;
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const body = document.body;
    const background = readOnly ? "transparent" : (isDarkTheme ? "#0a0a0a" : "#ffffff");
    const foreground = isDarkTheme ? "#ededed" : "#171717";
  root.classList.toggle("dark", isDarkTheme);
  root.classList.add("theme-transition");
  body.classList.add("theme-transition");
    if (readOnly) {
      root.style.setProperty("background", "transparent", "important");
      root.style.setProperty("background-color", "rgba(0,0,0,0)", "important");
      body.style.setProperty("background", "transparent", "important");
      body.style.setProperty("background-color", "rgba(0,0,0,0)", "important");
    }
    root.style.setProperty("--background", background);
    root.style.setProperty("--foreground", foreground);
  root.style.setProperty("--area-bg", themePalette.areaBackground);
  root.style.setProperty("--board-bg", themePalette.boardBackground);
  root.style.setProperty("--board-grid-minor", themePalette.boardGridMinor);
  root.style.setProperty("--board-grid-major", themePalette.boardGridMajor);
  root.style.setProperty("--board-shadow", themePalette.boardShadow);
    root.style.setProperty("--panel-bg", themePalette.panelBackground);
    root.style.setProperty("--panel-fg", themePalette.panelText);
    root.style.setProperty("--panel-muted", themePalette.panelMutedText);
    root.style.setProperty("--panel-divider", themePalette.panelDivider);
    root.style.setProperty("--panel-border", themePalette.panelBorderColor);
    root.style.setProperty("--panel-shadow", themePalette.panelShadow);
    root.style.setProperty("--panel-control-hover", themePalette.controlButtonHover);
    root.style.setProperty("--panel-control-text", themePalette.controlButtonText);
    root.style.setProperty("--badge-bg", themePalette.badgeBackground);
    root.style.setProperty("--badge-text", themePalette.badgeText);
    root.style.setProperty("--chip-bg", themePalette.chipBackground);
    root.style.setProperty("--chip-text", themePalette.chipText);
    root.style.setProperty("--input-bg", themePalette.inputBackground);
    root.style.setProperty("--input-fg", themePalette.inputText);
    root.style.setProperty("--input-placeholder", themePalette.inputPlaceholder);
    root.style.setProperty("--overlay-scrim", themePalette.overlayScrim);
    root.style.setProperty("--modal-bg", themePalette.modalBackground);
    root.style.setProperty("--modal-fg", themePalette.modalText);
    root.style.setProperty("--modal-border", themePalette.modalBorder);
    root.style.setProperty("--btn-primary-bg", themePalette.primaryButtonBg);
    root.style.setProperty("--btn-primary-hover", themePalette.primaryButtonHover);
    root.style.setProperty("--btn-primary-text", themePalette.primaryButtonText);
    root.style.setProperty("--btn-neutral-bg", themePalette.neutralButtonBg);
    root.style.setProperty("--btn-neutral-hover", themePalette.neutralButtonHover);
    root.style.setProperty("--btn-neutral-text", themePalette.neutralButtonText);
    root.style.setProperty("--progress-track", themePalette.progressTrack);
    root.style.setProperty("--progress-fill", themePalette.progressFill);
  root.style.setProperty("--tool-icon-filter", themePalette.toolIconFilter ?? "none");
    root.style.setProperty("color-scheme", isDarkTheme ? "dark" : "light");
    body.style.backgroundColor = background;
    body.style.color = foreground;
    try {
      window.localStorage.setItem("obsdraw-theme", isDarkTheme ? "dark" : "light");
    } catch {}
    const timeout = window.setTimeout(() => {
      root.classList.remove("theme-transition");
      body.classList.remove("theme-transition");
    }, 420);
    return () => {
      window.clearTimeout(timeout);
      root.classList.remove("theme-transition");
      body.classList.remove("theme-transition");
    };
  }, [isDarkTheme, readOnly, themePalette]);
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    board.style.width = `${BOARD_W}px`;
    board.style.height = `${BOARD_H}px`;
    board.width = BOARD_W * dpr;
    board.height = BOARD_H * dpr;
    const bctx = board.getContext("2d");
    if (bctx) {
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.lineCap = "round";
      bctx.lineJoin = "round";
    }
  }, []);
  useEffect(() => {
    const detach = attachHandTool({
      toolRef: { current: tool },
      readOnlyRef: { current: readOnly },
      areaRef,
      panRef,
      scaleRef,
      setViewTransform: (v) => setViewTransform(v),
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
    });
  return () => { try { if (detach) detach(); } catch {} };
  }, [tool, readOnly, screenToBoardNorm, forceTick]);
  useEffect(() => {
    if (readOnly) return;
    const area = areaRef.current;
    if (!area) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const oldS = scaleRef.current;
      const newS = Math.max(0.25, Math.min(4, oldS * factor));
      const crect = area.getBoundingClientRect();
      const cx = e.clientX - crect.left;
      const cy = e.clientY - crect.top;
      const pan = panRef.current;
      const worldX = (cx - pan.x) / Math.max(1e-6, oldS);
      const worldY = (cy - pan.y) / Math.max(1e-6, oldS);
      const nx = cx - worldX * newS;
      const ny = cy - worldY * newS;
      panRef.current = { x: nx, y: ny };
      scaleRef.current = newS;
      setViewTransform({ x: nx, y: ny, s: newS });
    };
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => area.removeEventListener("wheel", onWheel as EventListener);
  }, [readOnly]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (readOnly) return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.code === "Space" && !panOverrideRef.current) {
        panOverrideRef.current = true;
        e.preventDefault();
        forceTick(t => t + 1);
      }
      const s = scaleRef.current;
      const area = areaRef.current;
      if (!area) return;
      const crect = area.getBoundingClientRect();
      const cx = crect.left + crect.width / 2;
      const cy = crect.top + crect.height / 2;
      const applyZoomAt = (newS: number, anchorX: number, anchorY: number) => {
        const oldS = scaleRef.current;
        newS = Math.max(0.25, Math.min(4, newS));
        const pan = panRef.current;
        const worldX = (anchorX - crect.left - pan.x) / Math.max(1e-6, oldS);
        const worldY = (anchorY - crect.top - pan.y) / Math.max(1e-6, oldS);
        const nx = anchorX - crect.left - worldX * newS;
        const ny = anchorY - crect.top - worldY * newS;
        panRef.current = { x: nx, y: ny };
        scaleRef.current = newS;
        setViewTransform({ x: nx, y: ny, s: newS });
      };
      if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        applyZoomAt(s * 1.1, cx, cy);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        applyZoomAt(s / 1.1, cx, cy);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "0")) {
        e.preventDefault();
        const cw = crect.width, ch = crect.height;
        const ns = Math.min(cw / BOARD_W, ch / BOARD_H);
        const nx = Math.max(0, (cw - BOARD_W * ns) / 2);
        const ny = Math.max(0, (ch - BOARD_H * ns) / 2);
        panRef.current = { x: nx, y: ny };
        scaleRef.current = ns;
        setViewTransform({ x: nx, y: ny, s: ns });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && panOverrideRef.current) {
        panOverrideRef.current = false;
        forceTick(t => t + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, [readOnly]);
  useEffect(() => {
    let raf = 0;
    const ctx = canvasRef.current?.getContext("2d");
    const pointerPath = typeof Path2D !== "undefined"
      ? new Path2D("M0 0 L0 20 L4.6 15.3 L9.2 24.8 L12.4 23 L7.8 14.5 L16 14.5 Z")
      : null;
    const pointerScale = 0.74;
    let disposed = false;
    const requestIconImage = (toolKey: Tool): HTMLImageElement | null => ensureToolIconImage(toolKey, () => {
      if (disposed) return;
      try { forceTick(t => t + 1); } catch {}
    });
    const drawPointer = (
      context: CanvasRenderingContext2D,
      x: number,
      y: number,
      toolKey: Tool,
      col: { main: string; glow: string; bg: string },
      isSelf: boolean,
      size?: number,
      currentScale?: number,
      currentPenSize?: number,
    ) => {
  const selectImg = requestIconImage("select");
  const cursorSize = 22;
  const cursorOffsetX = -3;
  const cursorOffsetY = -2;
  const pointerOffsetX = -2;
  const pointerOffsetY = -1;
      const palette = cursorPaletteFor(col.main);
      context.save();
      context.translate(x + pointerOffsetX, y + pointerOffsetY);
      const scaleValue = currentScale || 1;
      const penSizeValue = currentPenSize || 2;
      if (isSelf) {
        if (toolKey === "eraser") {
          const eraserSizeValue = eraserSize;
          const eraserRadiusScreen = (eraserSizeValue * scaleValue) / 2;
          context.beginPath();
          context.arc(-pointerOffsetX + 2, -pointerOffsetY, eraserRadiusScreen, 0, Math.PI * 2);
          context.strokeStyle = "rgba(255, 0, 0, 0.6)";
          context.lineWidth = 2;
          context.stroke();
          context.fillStyle = "rgba(255, 0, 0, 0.1)";
          context.fill();
        }
        if (toolKey === "pen") {
          const toolPenSize = penSizeValue;
          const penRadiusScreen = (toolPenSize * scaleValue) / 2;
          context.beginPath();
          context.arc(-pointerOffsetX + 2, -pointerOffsetY, penRadiusScreen, 0, Math.PI * 2);
          context.strokeStyle = `${col.main}CC`;  
          context.lineWidth = 2;
          context.stroke();
          context.fillStyle = `${col.main}26`;  
          context.fill();
        }
      }
      if (selectImg) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = cursorSize + Math.abs(cursorOffsetX) * 2;
        tempCanvas.height = cursorSize + Math.abs(cursorOffsetY) * 2;
        const tempCtx = tempCanvas.getContext('2d');
        if (tempCtx) {
          const tempOffsetX = Math.abs(cursorOffsetX);
          const tempOffsetY = Math.abs(cursorOffsetY);
          tempCtx.drawImage(selectImg, tempOffsetX, tempOffsetY, cursorSize, cursorSize);
          tempCtx.globalCompositeOperation = "source-in";
          tempCtx.fillStyle = palette.pointer;
          tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
          context.save();
          context.translate(-pointerOffsetX, -pointerOffsetY);
          context.drawImage(tempCanvas, cursorOffsetX - tempOffsetX, cursorOffsetY - tempOffsetY);
          context.restore();
        }
      } else if (pointerPath) {
        context.save();
        context.scale(pointerScale, pointerScale);
        context.lineJoin = "round";
        context.lineCap = "round";
        context.fillStyle = palette.pointer;
        context.fill(pointerPath);
        context.restore();
      } else {
        context.beginPath();
        context.moveTo(0, 0);
        context.lineTo(0, 18);
        context.lineTo(6, 13);
        context.lineTo(12, 24);
        context.lineTo(15, 22);
        context.lineTo(9, 12);
        context.lineTo(18, 12);
        context.closePath();
        context.fillStyle = palette.pointer;
        context.fill();
      }
      context.restore();
    };
    const drawNameplate = (
      context: CanvasRenderingContext2D,
      x: number,
      y: number,
      w: number,
      h: number,
      toolKey: Tool,
      displayName: string,
      col: { main: string; glow: string; bg: string },
    ) => {
      const padX = 6;
      const padY = 3;
      const iconSize = 12;
      const labelFont = `600 9px "Inter", ${FONT_FALLBACK_STACK}`;
      context.font = labelFont;
      context.textBaseline = "middle";
      context.textAlign = "left";
      const maxTextWidth = 80;
      let label = displayName.trim() || "Misafir";
      if (context.measureText(label).width > maxTextWidth) {
        let truncated = label;
        while (truncated.length > 1 && context.measureText(`${truncated}…`).width > maxTextWidth) {
          truncated = truncated.slice(0, -1);
        }
        label = `${truncated}…`;
      }
      const nameWidth = context.measureText(label).width;
      const toolBoxWidth = iconSize + padX;
      const nameBoxWidth = nameWidth + padX * 1.5;
      const totalWidth = toolBoxWidth + nameBoxWidth;
      const height = iconSize + padY * 2;
      const tx = Math.min(w - totalWidth - 8, Math.max(6, x + 6));
      let ty = y - height - 4;  
      if (ty < 8) {
        ty = Math.min(h - height - 8, y + 12);  
      }
      context.save();
      const toolBase = TOOL_BADGE_BG[toolKey] ?? col.main;
      const toolPalette = cursorPaletteFor(toolBase);
      const iconBg = toolPalette.pointer;
      context.fillStyle = iconBg;
      context.beginPath();
      context.arc(tx + height/2, ty + height/2, height/2, Math.PI/2, Math.PI*3/2);
      context.lineTo(tx + toolBoxWidth, ty);
      context.lineTo(tx + toolBoxWidth, ty + height);
      context.lineTo(tx + height/2, ty + height);
      context.fill();
      const palette = cursorPaletteFor(col.main);
      const bubbleFill = palette.bg;
      context.fillStyle = bubbleFill;
      context.beginPath();
      context.moveTo(tx + toolBoxWidth, ty);
      context.lineTo(tx + totalWidth - height/2, ty);
      context.arc(tx + totalWidth - height/2, ty + height/2, height/2, Math.PI*3/2, Math.PI/2);
      context.lineTo(tx + toolBoxWidth, ty + height);
      context.closePath();
      context.fill();
      context.strokeStyle = palette.stroke;
      context.lineWidth = 1;
      context.beginPath();
      context.arc(tx + height/2, ty + height/2, height/2, Math.PI/2, Math.PI*3/2);
      context.lineTo(tx + totalWidth - height/2, ty);
      context.arc(tx + totalWidth - height/2, ty + height/2, height/2, Math.PI*3/2, Math.PI/2);
      context.lineTo(tx + height/2, ty + height);
      context.closePath();
      context.stroke();
      const icon = requestIconImage(toolKey);
      const iconX = tx + (toolBoxWidth - iconSize) / 2;
      const iconY = ty + (height - iconSize) / 2;
      if (icon) {
        context.save();
        context.filter = "brightness(0) saturate(100%) invert(1)";
        context.drawImage(icon, iconX, iconY, iconSize, iconSize);
        context.restore();
      } else {
        context.save();
        context.fillStyle = "#ffffff";
        context.font = `bold 11px "Inter", ${FONT_FALLBACK_STACK}`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(toolKey.slice(0, 1).toUpperCase(), iconX + iconSize / 2, iconY + iconSize / 2 + 0.5);
        context.restore();
      }
      const nameColor = palette.text;
      const textX = tx + toolBoxWidth + padX * 0.5;
      const baseline = ty + height / 2;
      context.font = labelFont;
      context.fillStyle = nameColor;
      context.fillText(label, textX, baseline);
      context.restore();
    };
  function draw() {
      const cvs = canvasRef.current;
      const container = containerRef.current;
      if (!ctx || !cvs || !container) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (cvs.width !== w || cvs.height !== h) {
        cvs.width = w;
        cvs.height = h;
      }
      ctx.clearRect(0, 0, cvs.width, cvs.height);
  const now = Date.now();
  const nowPerf = (typeof performance !== "undefined" ? performance.now() : now);
      const last = lastDrawTsRef.current ?? nowPerf;
      const dt = Math.max(0, Math.min(100, nowPerf - last));
      lastDrawTsRef.current = nowPerf;
  const tau = 80;  
      const alpha = 1 - Math.exp(-dt / tau);
      for (const [pid, p] of peers.current) {
        if (now - p.lastSeen > 5000) {
          peers.current.delete(pid);
          peerRenderRef.current.delete(pid);
        }
      }
      const crect = container.getBoundingClientRect();
      ctx.font = `12px "Geist", "Inter", ${FONT_FALLBACK_STACK}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      for (const [pid, p] of peers.current) {
        if (pid === id) continue;
        let r = peerRenderRef.current.get(pid);
        if (!r) {
          r = { x: p.x, y: p.y, tx: p.x, ty: p.y, lastSeen: p.lastSeen };
          peerRenderRef.current.set(pid, r);
        } else {
          r.tx = p.x;
          r.ty = p.y;
          r.lastSeen = p.lastSeen;
        }
        const dx = r.tx - r.x;
        const dy = r.ty - r.y;
        r.x = r.x + dx * alpha;
        r.y = r.y + dy * alpha;
        if (r.x < -0.5 || r.x > 1.5 || r.y < -0.5 || r.y > 1.5) {
          continue;
        }
        if (readOnly && (r.x < 0 || r.x > 1 || r.y < 0 || r.y > 1)) {
          continue;
        }
        const scr = boardNormToScreen(r.x, r.y);
        const x = scr.x - crect.left;
        const y = scr.y - crect.top;
  const toolKey = p.tool ?? "pen";
  const col = userColor(pid);
  drawPointer(ctx, x, y, toolKey, col, false, p.size, scaleRef.current, penSize);
  drawNameplate(ctx, x, y, w, h, toolKey, p.name, col);
      }
      if (!readOnly && selfPos.current) {
        const p = { name, x: selfPos.current.x, y: selfPos.current.y };
        const scr = boardNormToScreen(p.x, p.y);
        const x = Math.max(0, Math.min(w - 1, scr.x - crect.left));
        const y = Math.max(0, Math.min(h - 1, scr.y - crect.top));
  const toolKey = tool;
  const selfCol = userColor(id);
  drawPointer(ctx, x, y, toolKey, selfCol, true, undefined, scaleRef.current, penSize);
  drawNameplate(ctx, x, y, w, h, toolKey, p.name, selfCol);
      }
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
    };
  }, [boardNormToScreen, eraserSize, id, name, penSize, readOnly, tool]);
  useEffect(() => {
    if (readOnly) return;  
    if (!selfPos.current) {
      selfPos.current = { x: 0.5, y: 0.5 };
      const socket = socketRef.current;
      if (socket && socket.connected) {
  if (!snapshotReadyRef.current || mediaBusy) return;
        const { x, y } = selfPos.current;  
        const msg: CursorPayload = {
          type: "cursor",
          id,
          name,
          x,
          y,
          tool,
          size: tool === "eraser" ? eraserSize : tool === "text" ? textSize : penSize,
        };
  sendCritical(msg);
      }
    }
  }, [eraserSize, id, mediaBusy, name, penSize, readOnly, sendCritical, textSize, tool]);
  const ensureDvdState = useCallback(
    (kind: "text" | "image", id0: string, baseSpeedPx = 240) =>
      ensureDvdStateSvc(kind, id0, {
        dvdTextState: dvdTextStateRef.current,
        dvdImageState: dvdImageStateRef.current,
        BOARD_W,
        BOARD_H,
        baseSpeedPx,
      }),
    []
  );
  const ensureRotState = useCallback(
    (kind: "text" | "image", id0: string) =>
      ensureRotStateSvc(kind, id0, { rotTextState: rotTextStateRef.current, rotImageState: rotImageStateRef.current }),
    []
  );
  const replayBoard = useMemo(
    () => createReplayer({ boardRef, historyRef, undoneRef }),
    []
  );
  const rebuildTextsFromHistory = useCallback(() => {
    const result = rebuildCommittedTexts(historyRef.current, undoneRef.current, readOnly, ensureFontLoaded);
    committedTextsRef.current = result as Map<string, CommittedText>;
    rebuildTextAnimStates(historyRef.current, undoneRef.current, dvdTextStateRef.current, rotTextStateRef.current);
    forceTick(t => t + 1);
  }, [ensureFontLoaded, readOnly]);
  const rebuildImagesFromHistory = useCallback(() => {
    const map = rebuildCommittedImages(historyRef.current, undoneRef.current);
    committedImagesRef.current = map as Map<string, CommittedImage>;
    rebuildImageAnimStates(
      historyRef.current,
      undoneRef.current,
      imageChromaStateRef.current,
      imageChromaKeyStateRef.current,
      dvdImageStateRef.current,
      rotImageStateRef.current
    );
    for (const key of map.keys()) ensureImageNaturalInfo(key);
    forceTick(t => t + 1);
  }, [ensureImageNaturalInfo]);
  useEffect(() => {
    let aborted = false;
    const pendingPingEntries = pendingPingRef.current;
    snapshotReadyRef.current = false;
    const quietResync = readOnly && (unsyncRef.current?.fixing === true || liveSocketStateRef.current.quietReconnect);
    if (!quietResync) {
      setSnapshotLoading(true);
    } else {
      setSnapshotLoading(false);
    }
  setSnapshotProgress(null);
    function resolveBaseUrl(loc: Location): string | undefined {
      try {
        const u = new URL(loc.href);
        const qp = u.searchParams.get("ws") || u.searchParams.get("ws_url");
        if (qp && qp.trim()) return qp.trim();
      } catch {}
      const override = process.env.NEXT_PUBLIC_WS_URL as string | undefined;
      if (override && typeof override === "string" && override.trim().length > 0) return override.trim();
      return undefined;  
    }
  function connect() {
      if (aborted) return;
      const baseUrl = resolveBaseUrl(window.location);
      const assembler = new SnapshotAssembler();
      const isBufferableType = (t: string) => (
        t === "stroke" || t === "text_commit" || t === "text_update" || t === "image_commit" || t === "image_update" || t === "undo" || t === "redo"
      );
  const handleIncomingRef = { current: async () => {   } } as { current: (data: unknown, fromBuffer?: boolean) => Promise<void> };
      const drainBuffer = async () => {
        if (drainingRef.current) return;
        drainingRef.current = true;
        try {
          let processedTotal = 0;
          const processBatch = async (): Promise<void> => {
            let processed = 0;
            const limit = BUFFER_DRAIN_BATCH_SIZE;
            while (incomingBufferRef.current.length && processed < limit) {
              const raw = incomingBufferRef.current.shift();
              if (!raw) break;
              await handleIncomingRef.current(raw, true);
              processed += 1;
              processedTotal += 1;
            }
            setLatencyStats(prev => ({ ...prev, bufferedEvents: incomingBufferRef.current.length }));
            if (incomingBufferRef.current.length) {
              await new Promise(resolve => setTimeout(resolve, 0));
              await processBatch();
            }
          };
          await processBatch();
          if (processedTotal > 0) {
            try {
              replayBoard();
              rebuildTextsFromHistory();
              rebuildImagesFromHistory();
            } catch {}
          }
        } finally {
          drainingRef.current = false;
        }
      };
      const socket = connectSocket({
        baseUrl,
        auth: {
          role: readOnly ? "viewer" : "editor",
          token: socketToken,
        },
        callbacks: {
          onConnect: (sid) => {
            const live = liveSocketStateRef.current;
            void sid;
            setConnectionLost(false);
            setQuietReconnect(false);
            startFlush();
            if (!readOnly) {
              const repairing = unsyncRef.current.fixing === true;
              if (repairing) {
                try { sendCritical({ type: "presence", kind: "quiet" }); } catch {}
              }
              sendCritical({ type: "presence", kind: "join", id, name: live.name });
              try { sendCritical({ type: "presence", kind: "roster" }); } catch {}
              if (!repairing) addChatItem({ kind: "sys", text: `${live.name} connected`, name: live.name, id, ts: Date.now() });
            }
          },
          onDisconnect: (reason) => {
            void reason;
            if (aborted) return;
            setConnectionLost(true);
            if (readOnly) setQuietReconnect(true);
          },
          onError: (err) => {
            console.warn("Socket connection error", err);
          },
          onMessage: async (data) => {
        return handleIncomingRef.current(data, false);
          },
        },
      });
      try {
        pageHiddenRef.current = (typeof document !== 'undefined') ? (document.visibilityState === 'hidden') : false;
        const onVis = () => {
          const hidden = (typeof document !== 'undefined') ? (document.visibilityState === 'hidden') : false;
          pageHiddenRef.current = hidden;
          if (hidden) {
            pageHiddenAtRef.current = Date.now();
            return;
          }
          const now = Date.now();
          const hiddenFor = pageHiddenAtRef.current ? now - pageHiddenAtRef.current : 0;
          pageHiddenAtRef.current = null;
          const buffered = incomingBufferRef.current.length;
          const unsyncState = unsyncRef.current;
          const shortBackgrounding = hiddenFor < 30000;  
          const smallBuffer = buffered < 200;  
          const hardResyncNeeded =
            unsyncState.fixing === true ||
            hiddenFor > 45000 ||  
            buffered > 600 ||  
            !snapshotReadyRef.current;
          if (hardResyncNeeded) {
            unsyncSuppressUntilRef.current = now + 5000;
            unsyncState.fixing = true;
            unsyncState.bad = 0;
            if (unsyncState.shown) { unsyncState.shown = false; setUnsyncShown(false); }
            if (readOnly) {
              setQuietReconnect(true);
              setSnapshotLoading(false);
              setSnapshotProgress(null);
            } else {
              setSnapshotLoading(true);
              setSnapshotProgress(null);
            }
            incomingBufferRef.current = [];
            setLatencyStats(prev => ({ ...prev, bufferedEvents: 0 }));
            try { sendCritical({ type: "presence", kind: "quiet" }); } catch {}
            setWsEpoch(e => e + 1);
            return;
          }
          unsyncSuppressUntilRef.current = now + 2000;  
          unsyncState.fixing = false;
          if (readOnly) {
            setQuietReconnect(false);
          } else {
            if (shortBackgrounding && smallBuffer) {
              setSnapshotLoading(false);
            }
          }
          if (incomingBufferRef.current.length) {
            void drainBuffer();
          }
          sendPing();
        };
        document.addEventListener('visibilitychange', onVis);
        const prevDisconnect = () => {
          document.removeEventListener('visibilitychange', onVis);
        };
        if (!aborted) {
          (socketRef as unknown as { _visCleanup?: () => void })._visCleanup = prevDisconnect;
        }
      } catch {}
      handleIncomingRef.current = async (data: unknown, fromBuffer = false) => {
        try {
          let raw: string;
          if (typeof data === "string") raw = data;
          else raw = JSON.stringify(data);
          const msg = JSON.parse(raw) as ServerMessage2;
          const nowTs = Date.now();
          lastInboundAtRef.current = nowTs;
      if (!fromBuffer && !snapshotReadyRef.current) {
        if (msg.type === "presence" || msg.type === "chat" || msg.type === "typing" || msg.type === "ping" || msg.type === "drift_reply") {
        } else if (isBufferableType(msg.type)) {
          incomingBufferRef.current.push(raw);
          setLatencyStats(prev => ({ ...prev, bufferedEvents: incomingBufferRef.current.length }));
          return;
        }
      }
      if (!fromBuffer && pageHiddenRef.current && isBufferableType(msg.type)) {
        incomingBufferRef.current.push(raw);
        setLatencyStats(prev => ({ ...prev, bufferedEvents: incomingBufferRef.current.length }));
        return;
      }
      if (msg.type === "snapshot_meta") {
        assembler.start(msg as SnapshotMeta);
        const p = assembler.progress();
        if (p) setSnapshotProgress(p);
        return;
      }
      if (msg.type === "snapshot_chunk") {
        assembler.addChunk(msg as SnapshotChunk);
        const p = assembler.progress();
        if (p) setSnapshotProgress(p);
        return;
      }
    if (msg.type === "snapshot_done") {
      const live = liveSocketStateRef.current;
        const events = assembler.done();
        historyRef.current = [];
        undoneRef.current = new Set();
        committedTextsRef.current.clear();
        committedImagesRef.current.clear();
    pendingTextUpdatesRef.current.clear();
    pendingImageUpdatesRef.current.clear();
        for (const item of events) {
          try {
            const ev = typeof item === "string" ? JSON.parse(item) : item;
            if (!ev || typeof ev !== "object" || !("type" in ev)) continue;
            const t = (ev as { type: string }).type;
            if (t === "stroke" || t === "text_commit" || t === "text_update" || t === "image_commit" || t === "image_update") {
              historyRef.current.push(ev as unknown as HistoryEvent);
            } else if (t === "undo") {
              undoneRef.current.add((ev as { strokeId: string }).strokeId);
            } else if (t === "redo") {
              undoneRef.current.delete((ev as { strokeId: string }).strokeId);
            } else if (t === "text_live") {
              const live = ev as TextLivePayload;
              const commit: TextCommitEvent = {
                type: "text_commit",
                id: live.id,
                textId: live.textId,
                text: live.text,
                x: live.x,
                y: live.y,
                color: live.color,
                size: live.size,
                font: live.font,
                strokeId: `live-${live.textId}`,
                width: live.width,
                height: live.height,
              };
              historyRef.current.push(commit);
            }
          } catch {}
        }
  replayBoard();
  rebuildTextsFromHistory();
  rebuildImagesFromHistory();
  snapshotReadyRef.current = true;
  setSnapshotProgress(null);
  if (readOnly) {
    setSnapshotLoading(false);
    setQuietReconnect(false);
  } else {
    Promise.resolve().then(() => {
      const imgs = committedImagesRef.current.size;
      if (imgs === 0) { setSnapshotLoading(false); }
    });
    try {
      void (async () => {
        try { await preloadSnapshotMedia(); } catch {}
        setSnapshotLoading(false);
      })();
    } catch {}
  }
        try { const u = unsyncRef.current; u.fixing = false; } catch {}
        undoOrderRef.current = [];
        if (!readOnly) {
          try {
            const socket = socketRef.current;
            const pos = selfPos.current || { x: 0.5, y: 0.5 };
            if (socket && socket.connected) {
              const initCursor: CursorPayload = {
                type: "cursor",
                id,
                name: live.name,
                x: pos.x,
                y: pos.y,
                tool: live.tool,
                size: live.tool === "eraser" ? live.eraserSize : live.tool === "text" ? live.textSize : live.penSize,
              };
              sendCritical(initCursor);
            }
          } catch {}
        }
        forceTick(t => t + 1);
        await drainBuffer();
        return;
      }
    if (msg.type === "snapshot") {
      const live = liveSocketStateRef.current;
        const snap = msg as SnapshotMessage;
        historyRef.current = [];
        undoneRef.current = new Set();
        committedTextsRef.current.clear();
        committedImagesRef.current.clear();
    pendingTextUpdatesRef.current.clear();
    pendingImageUpdatesRef.current.clear();
        try {
          const arr = Array.isArray(snap.events) ? snap.events : [];
          for (const item of arr) {
            try {
              const ev = typeof item === "string" ? JSON.parse(item) : item;
              if (!ev || typeof ev !== "object" || !("type" in ev)) continue;
              const t = (ev as { type: string }).type;
              if (t === "stroke" || t === "text_commit" || t === "text_update" || t === "image_commit" || t === "image_update") {
                historyRef.current.push(ev as unknown as HistoryEvent);
              } else if (t === "undo") {
                undoneRef.current.add((ev as { strokeId: string }).strokeId);
              } else if (t === "redo") {
                undoneRef.current.delete((ev as { strokeId: string }).strokeId);
              } else if (t === "text_live") {
                const live = ev as TextLivePayload;
                const commit: TextCommitEvent = {
                  type: "text_commit",
                  id: live.id,
                  textId: live.textId,
                  text: live.text,
                  x: live.x,
                  y: live.y,
                  color: live.color,
                  size: live.size,
                  font: live.font,
                  strokeId: `live-${live.textId}`,
                  width: live.width,
                  height: live.height,
                };
                historyRef.current.push(commit);
              }
            } catch {}
          }
        } catch {}
  replayBoard();
  rebuildTextsFromHistory();
  rebuildImagesFromHistory();
  snapshotReadyRef.current = true;
  setSnapshotProgress(null);
  if (readOnly) {
    setSnapshotLoading(false);
    setQuietReconnect(false);
  } else {
    Promise.resolve().then(() => {
      const imgs = committedImagesRef.current.size;
      if (imgs === 0) { setSnapshotLoading(false); }
    });
    try {
      void (async () => {
        try { await preloadSnapshotMedia(); } catch {}
        setSnapshotLoading(false);
      })();
    } catch {}
  }
        try { const u = unsyncRef.current; u.fixing = false; } catch {}
        undoOrderRef.current = [];
        if (!readOnly) {
          try {
            const socket = socketRef.current;
            const pos = selfPos.current || { x: 0.5, y: 0.5 };
            if (socket && socket.connected) {
              const initCursor: CursorPayload = {
                type: "cursor",
                id,
                name: live.name,
                x: pos.x,
                y: pos.y,
                tool: live.tool,
                size: live.tool === "eraser" ? live.eraserSize : live.tool === "text" ? live.textSize : live.penSize,
              };
              sendCritical(initCursor);
            }
          } catch {}
        }
        forceTick(t => t + 1);
        await drainBuffer();
        return;
      }
      if (msg.type === "ping") {
        const pingMsg = msg as PingPayload;
        if (typeof pingMsg.seq === "number") {
          const sentAt = pendingPingRef.current.get(pingMsg.seq);
          if (sentAt) {
            pendingPingRef.current.delete(pingMsg.seq);
            const now = Date.now();
            const roundTrip = Math.max(0, now - sentAt);
            const samples = pingSamplesRef.current;
            samples.push(roundTrip);
            if (samples.length > LATENCY_SAMPLE_SIZE) samples.shift();
            const avgPing = samples.reduce((acc, val) => acc + val, 0) / samples.length;
            const downstreamMs = pingMsg.serverTs ? Math.max(0, now - pingMsg.serverTs) : null;
            const upstreamMs = (pingMsg.serverTs !== undefined && pingMsg.clientTs !== undefined)
              ? Math.max(0, pingMsg.serverTs - pingMsg.clientTs - (pingMsg.processMs ?? 0))
              : null;
            const displayPing = Math.round(roundTrip * 0.4);
            const displayAvgPing = Math.round(avgPing * 0.4);
            setLatencyStats(prev => ({
              ...prev,
              pingMs: displayPing,
              avgPingMs: displayAvgPing,
              downstreamMs: downstreamMs ?? prev.downstreamMs,
              upstreamMs: upstreamMs ?? prev.upstreamMs,
              serverProcessMs: pingMsg.processMs ?? prev.serverProcessMs,
            }));
          }
        }
        const fpLocal = computeFingerprint();
        const fpRemote = pingMsg.fp;
        const now = Date.now();
        const recentSend = now - (lastNetworkSendAtRef.current || 0) < 2500;  
        const suppressed = now < (unsyncSuppressUntilRef.current || 0);
        if (pageHiddenRef.current) {
          return;
        }
        const mismatch = !!(fpRemote && (fpRemote.v !== fpLocal.v || fpRemote.c !== fpLocal.c || fpRemote.h !== fpLocal.h));
        if (!suppressed && mismatch) {
          if (readOnly) {
            const u = unsyncRef.current; u.fixing = true; u.bad = 0; u.shown = false; setUnsyncShown(false);
            setQuietReconnect(true);
            setSnapshotLoading(false);
            setWsEpoch(e => e + 1);
          } else {
            const u = unsyncRef.current;
            if (!recentSend) {
              u.bad = (u.bad || 0) + 1;
              if (!u.shown && u.bad >= 3) {
                u.shown = true; setUnsyncShown(true);
                addChatItem({ kind: "sys", text: "Synchronization may be out of date. Select Repair to resync.", ts: Date.now() });
              }
              try {
                const socket = socketRef.current;
                if (socket && socket.connected) {
                  const { keys, undone } = computeFpKeys();
                  const since = Date.now() - (lastNetworkSendAtRef.current || 0);
                  const req = { type: "drift_request", id, name: liveSocketStateRef.current.name, mode: "editor", client: { fp: fpLocal, undone, keys, grace: recentSend, sinceLastSendMs: since } } as const;
                  socket.emit("message", req);
                }
              } catch {}
            }
          }
        } else {
          const u = unsyncRef.current;
          u.bad = 0;
          if (u.shown && !u.fixing) { u.shown = false; setUnsyncShown(false); }
        }
        return;
      }
  if (msg.type === "drift_reply") {
        try {
          const info = msg as DriftReply;
          let cmp: { clientCount: number; serverCount: number; lastCommonSuffix: number; clientFirstDiff?: string | null; serverFirstDiff?: string | null } | undefined;
          try {
            cmp = info?.analysis?.compare as
              | { clientCount: number; serverCount: number; lastCommonSuffix: number; clientFirstDiff?: string | null; serverFirstDiff?: string | null }
              | undefined;
            if (cmp) {
              const equal = cmp.clientCount === cmp.serverCount &&
                cmp.lastCommonSuffix === cmp.clientCount &&
                !cmp.clientFirstDiff && !cmp.serverFirstDiff;
              if (equal) {
                const u = unsyncRef.current;
                u.bad = 0;
                if (u.shown && !u.fixing) { u.shown = false; setUnsyncShown(false); }
              }
            }
          } catch {}
          const serverTotal = (typeof info?.server?.totalPersisted === 'number') ? info.server.totalPersisted : 0;
          if (cmp && cmp.clientCount >= 500 && cmp.serverCount >= 500 && cmp.lastCommonSuffix === 0 && serverTotal >= 500) {
                      unsyncSuppressUntilRef.current = Date.now() + (readOnly ? 5 * 60_000 : 60_000);
                      const u = unsyncRef.current;
                      u.bad = 0;
                      if (u.shown && !u.fixing) { u.shown = false; setUnsyncShown(false); }
          }
        } catch {}
        return;
      }
      if (msg.type === "presence") {
        const pmsg = msg as PresenceMessage;
        if (pmsg.kind === "error" && pmsg.code === "name_taken") {
          addChatItem({ kind: "sys", text: "That name is already in use. Please reconnect with another name.", ts: Date.now() });
          try { alert("That name is already in use. Please reconnect with another name."); } catch {}
          redirectReasonRef.current = "name_taken";
          try { router.replace("/?error=name_taken"); } catch { try { window.location.replace("/?error=name_taken"); } catch {} }
          return;
        }
        if (pmsg.kind === "roster") {
          const list = pmsg.members;
          if (Array.isArray(list)) {
            for (const m of list) {
              participantsRef.current.set(m.id, { id: m.id, name: m.name, online: true, lastSeen: Date.now() });
            }
            forceTick(t => t + 1);
          }
          return;
        }
        const ev = pmsg as Extract<PresenceMessage, { kind: "join" | "leave" }>;
        if (ev.id === id) return;
        if (ev.kind === "join") {
      touchParticipant(ev.id, ev.name);
      if (!unsyncRef.current.fixing) {
            const item: ChatLogItem = { kind: "sys", text: `${ev.name} joined`, name: ev.name, id: ev.id, ts: Date.now() };
            addChatItem(item);
          }
        } else if (ev.kind === "leave") {
      const p = participantsRef.current.get(ev.id);
      if (p) participantsRef.current.set(ev.id, { ...p, online: false, lastSeen: Date.now() });
      if (!unsyncRef.current.fixing) {
            const item: ChatLogItem = { kind: "sys", text: `${ev.name} left`, name: ev.name, id: ev.id, ts: Date.now() };
            addChatItem(item);
          }
        }
        return;
      }
          if (msg.type === "chat") {
            const m = msg as ChatMessage;
            if (m.id === id) return;
            if (m.mid && chatSeenRef.current.has(m.mid)) return;
            if (m.mid) chatSeenRef.current.add(m.mid);
              touchParticipant(m.id, m.name);
            const item: ChatLogItem = { kind: "msg", text: m.text, name: m.name, id: m.id, ts: m.ts };
            addChatItem(item);
            if (!chatOpenRef.current) setUnreadCount(c => Math.min(99, c + 1));
            return;
          }
          if (msg.type === "typing") {
            if (msg.id === id) return;
            if (msg.typing) {
              typingPeersRef.current.set(msg.id, { name: msg.name, last: Date.now() });
            } else {
              typingPeersRef.current.delete(msg.id);
            }
            forceTick(t => t + 1);
            return;
          }
          if (msg.type === "anim_control" && msg.id !== id) {
            const m = msg as AnimControlPayload;
            if (m.entity === "text") {
              const st = dvdTextStateRef.current.get(m.targetId);
              if (st && m.dvdPaused !== undefined) { st.pausedByDrag = m.dvdPaused; }
            } else if (m.entity === "image") {
              const st = dvdImageStateRef.current.get(m.targetId);
              if (st && m.dvdPaused !== undefined) { st.pausedByDrag = m.dvdPaused; }
            }
            forceTick(t => t + 1);
          } else if (msg.type === "font_cycle_control" && msg.id !== id) {
            const m = msg as FontCycleControlPayload;
            const st = fontCycleStateRef.current.get(m.targetId) || { enabled: false, ms: 800 };
            if (m.enabled !== undefined) st.enabled = m.enabled;
            if (m.ms !== undefined) st.ms = Math.max(CYCLE_MIN_MS, Math.min(CYCLE_MAX_MS, m.ms));
            fontCycleStateRef.current.set(m.targetId, st);
            forceTick(t => t + 1);
            return;
          } else if (msg.type === "cursor") {
            if (msg.id !== id) {
              const now = Date.now();
              touchParticipant(msg.id, msg.name);
              peers.current.set(msg.id, { name: msg.name, x: msg.x, y: msg.y, lastSeen: now, tool: msg.tool, size: msg.size });
              const r = peerRenderRef.current.get(msg.id);
              if (!r) {
                peerRenderRef.current.set(msg.id, { x: msg.x, y: msg.y, tx: msg.x, ty: msg.y, lastSeen: now });
              } else {
                r.tx = msg.x; r.ty = msg.y; r.lastSeen = now;
              }
              forceTick(t => t + 1);
            }
          } else if (msg.type === "stroke") {
            historyRef.current.push(msg);
            if (msg.id !== id) {
              const board = boardRef.current;
              const bctx = board?.getContext("2d");
              if (!board || !bctx) return;
              const nx = msg.x;
              const ny = msg.y;
              const inBoard = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
              const x = Math.max(0, Math.min(BOARD_W - 1, nx * BOARD_W));
              const y = Math.max(0, Math.min(BOARD_H - 1, ny * BOARD_H));
              bctx.lineWidth = msg.size;
              const key = msg.id;
              const lp = remotePaths.current.get(key) || null;
              if (msg.phase === "start") {
                if (inBoard) {
                  bctx.save();
                  if (msg.mode === "erase") {
                    bctx.globalCompositeOperation = "destination-out";
                    bctx.fillStyle = "#000";
                  } else {
                    bctx.globalCompositeOperation = "source-over";
                    bctx.fillStyle = msg.color;
                  }
                  bctx.beginPath();
                  bctx.arc(x, y, msg.size / 2, 0, Math.PI * 2);
                  bctx.fill();
                  bctx.restore();
                  remotePaths.current.set(key, { x, y });
                } else {
                  remotePaths.current.set(key, null);
                }
              } else if (msg.phase === "draw") {
                if (lp && inBoard) {
                  bctx.save();
                  if (msg.mode === "erase") {
                    bctx.globalCompositeOperation = "destination-out";
                  } else {
                    bctx.globalCompositeOperation = "source-over";
                    bctx.strokeStyle = msg.color;
                  }
                  bctx.beginPath();
                  bctx.moveTo(lp.x, lp.y);
                  bctx.lineTo(x, y);
                  bctx.stroke();
                  bctx.restore();
                  remotePaths.current.set(key, { x, y });
                } else if (!lp && inBoard) {
                  bctx.save();
                  if (msg.mode === "erase") {
                    bctx.globalCompositeOperation = "destination-out";
                    bctx.fillStyle = "#000";
                  } else {
                    bctx.globalCompositeOperation = "source-over";
                    bctx.fillStyle = msg.color;
                  }
                  bctx.beginPath();
                  bctx.arc(x, y, msg.size / 2, 0, Math.PI * 2);
                  bctx.fill();
                  bctx.restore();
                  remotePaths.current.set(key, { x, y });
                } else {
                  remotePaths.current.set(key, null);
                }
              } else if (msg.phase === "end") {
                remotePaths.current.delete(key);
              }
            }
          } else if (msg.type === "text_live") {
  } else if (msg.type === "text_commit") {
        const m: TextCommitEvent = msg;
                if (m.id !== id) {
                  historyRef.current.push(m);
                }
                overlayTextsRef.current.delete(m.textId);
                committedTextsRef.current.set(m.textId, {
                  textId: m.textId,
                  x: m.x,
                  y: m.y,
                  width: m.width,
                  height: m.height,
                  text: m.text,
                  color: m.color,
                  size: m.size,
                  font: m.font,
                  strokeId: m.strokeId,
    chroma: m.chroma,
    rotX: m.rotX,
    rotY: m.rotY,
    rotZ: m.rotZ,
    outline: m.outline ? cloneTextOutline(m.outline, liveSocketStateRef.current.textOutline) : undefined,
                });
                try {
                  const pend = pendingTextUpdatesRef.current.get(m.textId);
                  if (pend) {
                    const cur = committedTextsRef.current.get(m.textId)!;
                    committedTextsRef.current.set(m.textId, {
                      ...cur,
                      x: pend.x ?? cur.x,
                      y: pend.y ?? cur.y,
                      width: pend.width ?? cur.width,
                      height: pend.height ?? cur.height,
                      text: pend.text ?? cur.text,
                      color: pend.color ?? cur.color,
                      size: pend.size ?? cur.size,
                      font: pend.font ?? cur.font,
                      chroma: pend.chroma ?? cur.chroma,
                      outline: pend.outline ? cloneTextOutline(pend.outline, liveSocketStateRef.current.textOutline) : cur.outline,
                      rotX: pend.rotX ?? cur.rotX,
                      rotY: pend.rotY ?? cur.rotY,
                      rotZ: pend.rotZ ?? cur.rotZ,
                    });
                    pendingTextUpdatesRef.current.delete(m.textId);
                  }
                } catch {}
                if (readOnly) { try { ensureFontLoaded(m.font); } catch {} }
                forceTick(t => t + 1);
      } else if (msg.type === "text_update") {
        const m: TextUpdateEvent = msg as TextUpdateEvent;
                if (m.id === id && dragStateRef.current && dragStateRef.current.entity === "text" && dragStateRef.current.id === m.textId) {
                  return;  
                }
                if (m.id !== id) {
                  historyRef.current.push(m as unknown as HistoryEvent);
                }
                const cur = committedTextsRef.current.get(m.textId);
                if (cur) {
                  const dvd = dvdTextStateRef.current.get(m.textId);
                  const isAnimating = dvd && dvd.enabled && !dvd.pausedByDrag;
                  let targetX = m.x ?? cur.x;
                  let targetY = m.y ?? cur.y;
                  
                  if (isAnimating && m.x !== undefined && m.y !== undefined) {
                    const dx = Math.abs(m.x - cur.x);
                    const dy = Math.abs(m.y - cur.y);
                    if (dx < 0.04 && dy < 0.04) {
                      targetX = cur.x;
                      targetY = cur.y;
                    }
                  }

                  committedTextsRef.current.set(m.textId, {
                    ...cur,
                    x: targetX,
                    y: targetY,
                    width: m.width ?? cur.width,
                    height: m.height ?? cur.height,
                    text: m.text ?? cur.text,
                    color: m.color ?? cur.color,
                    size: m.size ?? cur.size,
                    font: m.font ?? cur.font,
                    chroma: m.chroma ?? cur.chroma,
                    outline: m.outline ? cloneTextOutline(m.outline, liveSocketStateRef.current.textOutline) : cur.outline,
                    rotX: m.rotX ?? cur.rotX,
                    rotY: m.rotY ?? cur.rotY,
                    rotZ: m.rotZ ?? cur.rotZ,
                    zIndex: m.zIndex ?? cur.zIndex,
                  });
                  if (readOnly && m.font) { try { ensureFontLoaded(m.font); } catch {} }
                  if (m.dvdEnabled !== undefined || m.dvdSpeed !== undefined || m.dvdVx !== undefined || m.dvdVy !== undefined) {
                    const st = ensureDvdState("text", m.textId);
                    if (m.dvdEnabled !== undefined) st.enabled = m.dvdEnabled;
                    if (m.dvdSpeed !== undefined) {
                      st.speed = m.dvdSpeed;
                      const ang = Math.atan2(st.vy * BOARD_H, st.vx * BOARD_W);
                      st.vx = Math.cos(ang) * (st.speed / BOARD_W);
                      st.vy = Math.sin(ang) * (st.speed / BOARD_H);
                    }
                    if (m.dvdVx !== undefined) st.vx = m.dvdVx;
                    if (m.dvdVy !== undefined) st.vy = m.dvdVy;
                    st.controlled = false;  
                    dvdTextStateRef.current.set(m.textId, st);
                  }
                  if (
                    m.rotXAnimEnabled !== undefined || m.rotXAnimSpeed !== undefined || m.rotXAnimMin !== undefined || m.rotXAnimMax !== undefined ||
                    m.rotYAnimEnabled !== undefined || m.rotYAnimSpeed !== undefined || m.rotYAnimMin !== undefined || m.rotYAnimMax !== undefined ||
                    m.rotZAnimEnabled !== undefined || m.rotZAnimSpeed !== undefined || m.rotZAnimMin !== undefined || m.rotZAnimMax !== undefined
                  ) {
                    const st = ensureRotState("text", m.textId);
                    if (m.rotXAnimEnabled !== undefined) st.x.enabled = m.rotXAnimEnabled;
                    if (m.rotXAnimSpeed !== undefined) st.x.speed = m.rotXAnimSpeed;
                    if (m.rotXAnimMin !== undefined) st.x.min = m.rotXAnimMin;
                    if (m.rotXAnimMax !== undefined) st.x.max = m.rotXAnimMax;
                    if (m.rotXAnimDir !== undefined) st.x.dir = m.rotXAnimDir;
                    if (m.rotYAnimEnabled !== undefined) st.y.enabled = m.rotYAnimEnabled;
                    if (m.rotYAnimSpeed !== undefined) st.y.speed = m.rotYAnimSpeed;
                    if (m.rotYAnimMin !== undefined) st.y.min = m.rotYAnimMin;
                    if (m.rotYAnimMax !== undefined) st.y.max = m.rotYAnimMax;
                    if (m.rotYAnimDir !== undefined) st.y.dir = m.rotYAnimDir;
                    if (m.rotZAnimEnabled !== undefined) st.z.enabled = m.rotZAnimEnabled;
                    if (m.rotZAnimSpeed !== undefined) st.z.speed = m.rotZAnimSpeed;
                    if (m.rotZAnimMin !== undefined) st.z.min = m.rotZAnimMin;
                    if (m.rotZAnimMax !== undefined) st.z.max = m.rotZAnimMax;
                    if (m.rotZAnimDir !== undefined) st.z.dir = m.rotZAnimDir;
                    st.controlled = false;
                    rotTextStateRef.current.set(m.textId, st);
                  }
                  forceTick(t => t + 1);
                } else {
                  if (m.id !== id) {
                    const curPend = pendingTextUpdatesRef.current.get(m.textId) || {};
                    if (m.x !== undefined) (curPend as Partial<TextUpdateEvent>).x = m.x;
                    if (m.y !== undefined) (curPend as Partial<TextUpdateEvent>).y = m.y;
                    if (m.width !== undefined) (curPend as Partial<TextUpdateEvent>).width = m.width;
                    if (m.height !== undefined) (curPend as Partial<TextUpdateEvent>).height = m.height;
                    if (m.text !== undefined) (curPend as Partial<TextUpdateEvent>).text = m.text;
                    if (m.color !== undefined) (curPend as Partial<TextUpdateEvent>).color = m.color;
                    if (m.size !== undefined) (curPend as Partial<TextUpdateEvent>).size = m.size;
                    if (m.font !== undefined) (curPend as Partial<TextUpdateEvent>).font = m.font;
                    if (m.chroma !== undefined) (curPend as Partial<TextUpdateEvent>).chroma = m.chroma;
                    if (m.outline !== undefined) (curPend as Partial<TextUpdateEvent>).outline = m.outline;
                    if (m.rotX !== undefined) (curPend as Partial<TextUpdateEvent>).rotX = m.rotX;
                    if (m.rotY !== undefined) (curPend as Partial<TextUpdateEvent>).rotY = m.rotY;
                    if (m.rotZ !== undefined) (curPend as Partial<TextUpdateEvent>).rotZ = m.rotZ;
                    pendingTextUpdatesRef.current.set(m.textId, curPend as Partial<TextUpdateEvent>);
                  }
                }
          } else if (msg.type === "undo") {
            undoneRef.current.add(msg.strokeId);
            undoOrderRef.current.push(msg.strokeId);
            replayBoard();
            rebuildTextsFromHistory();
            rebuildImagesFromHistory();
            if (msg.by === id) forceTick(t => t + 1);
          } else if (msg.type === "redo") {
            undoneRef.current.delete(msg.strokeId);
            const stack = undoOrderRef.current;
            if (stack.length && stack[stack.length - 1] === msg.strokeId) stack.pop();
            else { for (let i = stack.length - 1; i >= 0; i--) { if (stack[i] === msg.strokeId) { stack.splice(i, 1); break; } } }
            replayBoard();
            rebuildTextsFromHistory();
            rebuildImagesFromHistory();
            if (msg.by === id) forceTick(t => t + 1);
          } else if (msg.type === "image_commit") {
            const m = msg as ImageCommitEvent;
            if (m.id !== id) {
              historyRef.current.push(m);
            }
            {
              const minW = 10 / BOARD_W, minH = 10 / BOARD_H;
              const width = Math.max(minW, Math.min(1, m.width));
              const height = Math.max(minH, Math.min(1, m.height));
              committedImagesRef.current.set(m.imageId, { imageId: m.imageId, x: m.x, y: m.y, width, height, src: m.src, strokeId: m.strokeId, filter: m.filter, rotX: m.rotX, rotY: m.rotY, rotZ: m.rotZ, mediaKind: m.mediaKind, animated: m.animated, origin: m.origin, zIndex: m.zIndex });
              try {
                const pend = pendingImageUpdatesRef.current.get(m.imageId);
                if (pend) {
                  const cur = committedImagesRef.current.get(m.imageId)!;
                  committedImagesRef.current.set(m.imageId, {
                    ...cur,
                    x: pend.x ?? cur.x,
                    y: pend.y ?? cur.y,
                    width: pend.width ?? cur.width,
                    height: pend.height ?? cur.height,
                    filter: pend.filter ?? cur.filter,
                    rotX: pend.rotX ?? cur.rotX,
                    rotY: pend.rotY ?? cur.rotY,
                    rotZ: pend.rotZ ?? cur.rotZ,
                  });
                  pendingImageUpdatesRef.current.delete(m.imageId);
                }
              } catch {}
            }
            ensureImageNaturalInfo(m.imageId);
            forceTick(t => t + 1);
          } else if (msg.type === "image_update") {
            const m = msg as ImageUpdateEvent;
            if (m.id === id && dragStateRef.current && dragStateRef.current.entity === "image" && dragStateRef.current.id === m.imageId) {
              return;
            }
            if (m.id !== id) {
              historyRef.current.push(m as unknown as HistoryEvent);
            }
            {
              const cur = committedImagesRef.current.get(m.imageId);
              if (cur) {
                const dvd = dvdImageStateRef.current.get(m.imageId);
                const isAnimating = dvd && dvd.enabled && !dvd.pausedByDrag;
                let targetX = m.x ?? cur.x;
                let targetY = m.y ?? cur.y;

                if (isAnimating && m.x !== undefined && m.y !== undefined) {
                  const dx = Math.abs(m.x - cur.x);
                  const dy = Math.abs(m.y - cur.y);
                  if (dx < 0.04 && dy < 0.04) {
                    targetX = cur.x;
                    targetY = cur.y;
                  }
                }

                const minW = 10 / BOARD_W, minH = 10 / BOARD_H;
                const width = m.width !== undefined ? Math.max(minW, Math.min(1, m.width)) : cur.width;
                const height = m.height !== undefined ? Math.max(minH, Math.min(1, m.height)) : cur.height;
                const next = { ...cur, x: targetX, y: targetY, width, height, filter: m.filter ?? cur.filter, rotX: m.rotX ?? cur.rotX, rotY: m.rotY ?? cur.rotY, rotZ: m.rotZ ?? cur.rotZ, zIndex: m.zIndex ?? cur.zIndex };
                committedImagesRef.current.set(m.imageId, next);
                if (m.chromaSpeed !== undefined || m.chromaSaturation !== undefined || m.chromaLightness !== undefined) {
                  const st = imageChromaStateRef.current.get(m.imageId) ?? { speed: 120, saturation: 180, lightness: 100 };
                  if (m.chromaSpeed !== undefined) st.speed = m.chromaSpeed;
                  if (m.chromaSaturation !== undefined) st.saturation = m.chromaSaturation;
                  if (m.chromaLightness !== undefined) st.lightness = m.chromaLightness;
                  imageChromaStateRef.current.set(m.imageId, st);
                }
                if (
                  m.chromaKeyEnabled !== undefined ||
                  m.chromaKeyColor !== undefined ||
                  m.chromaKeyTolerance !== undefined ||
                  m.chromaKeyFeather !== undefined ||
                  m.chromaKeySpill !== undefined
                ) {
                  const st = imageChromaKeyStateRef.current.get(m.imageId) ?? { enabled: false, color: "#00ff00", tolerance: 80, feather: 20, spill: 40 };
                  if (m.chromaKeyColor !== undefined) st.color = m.chromaKeyColor;
                  if (m.chromaKeyTolerance !== undefined) st.tolerance = m.chromaKeyTolerance;
                  if (m.chromaKeyFeather !== undefined) st.feather = m.chromaKeyFeather;
                  if (m.chromaKeySpill !== undefined) st.spill = m.chromaKeySpill;
                  if (m.chromaKeyEnabled !== undefined) st.enabled = m.chromaKeyEnabled;
                  else if (
                    m.chromaKeyColor !== undefined ||
                    m.chromaKeyTolerance !== undefined ||
                    m.chromaKeyFeather !== undefined ||
                    m.chromaKeySpill !== undefined
                  ) {
                    st.enabled = st.enabled || true;
                  }
                  imageChromaKeyStateRef.current.set(m.imageId, st);
                }
                forceTick(t => t + 1);
                if (m.dvdEnabled !== undefined || m.dvdSpeed !== undefined || m.dvdVx !== undefined || m.dvdVy !== undefined) {
                  const st = ensureDvdState("image", m.imageId);
                  if (m.dvdEnabled !== undefined) st.enabled = m.dvdEnabled;
                  if (m.dvdSpeed !== undefined) {
                    st.speed = m.dvdSpeed;
                    const ang = Math.atan2(st.vy * BOARD_H, st.vx * BOARD_W);
                    st.vx = Math.cos(ang) * (st.speed / BOARD_W);
                    st.vy = Math.sin(ang) * (st.speed / BOARD_H);
                  }
                  if (m.dvdVx !== undefined) st.vx = m.dvdVx;
                  if (m.dvdVy !== undefined) st.vy = m.dvdVy;
                  st.controlled = false;
                  dvdImageStateRef.current.set(m.imageId, st);
                }
                if (
                  m.rotXAnimEnabled !== undefined || m.rotXAnimSpeed !== undefined || m.rotXAnimMin !== undefined || m.rotXAnimMax !== undefined ||
                  m.rotYAnimEnabled !== undefined || m.rotYAnimSpeed !== undefined || m.rotYAnimMin !== undefined || m.rotYAnimMax !== undefined ||
                  m.rotZAnimEnabled !== undefined || m.rotZAnimSpeed !== undefined || m.rotZAnimMin !== undefined || m.rotZAnimMax !== undefined
                ) {
                  const st = ensureRotState("image", m.imageId);
                  if (m.rotXAnimEnabled !== undefined) st.x.enabled = m.rotXAnimEnabled;
                  if (m.rotXAnimSpeed !== undefined) st.x.speed = m.rotXAnimSpeed;
                  if (m.rotXAnimMin !== undefined) st.x.min = m.rotXAnimMin;
                  if (m.rotXAnimMax !== undefined) st.x.max = m.rotXAnimMax;
                  if (m.rotYAnimEnabled !== undefined) st.y.enabled = m.rotYAnimEnabled;
                  if (m.rotYAnimSpeed !== undefined) st.y.speed = m.rotYAnimSpeed;
                  if (m.rotYAnimMin !== undefined) st.y.min = m.rotYAnimMin;
                  if (m.rotYAnimMax !== undefined) st.y.max = m.rotYAnimMax;
                  if (m.rotZAnimEnabled !== undefined) st.z.enabled = m.rotZAnimEnabled;
                  if (m.rotZAnimSpeed !== undefined) st.z.speed = m.rotZAnimSpeed;
                  if (m.rotZAnimMin !== undefined) st.z.min = m.rotZAnimMin;
                  if (m.rotZAnimMax !== undefined) st.z.max = m.rotZAnimMax;
                  st.controlled = false;
                  rotImageStateRef.current.set(m.imageId, st);
                }
                forceTick(t => t + 1);
              } else {
                if (m.id !== id) {
                  const curPend = pendingImageUpdatesRef.current.get(m.imageId) || {};
                  if (m.x !== undefined) (curPend as Partial<ImageUpdateEvent>).x = m.x;
                  if (m.y !== undefined) (curPend as Partial<ImageUpdateEvent>).y = m.y;
                  if (m.width !== undefined) (curPend as Partial<ImageUpdateEvent>).width = m.width;
                  if (m.height !== undefined) (curPend as Partial<ImageUpdateEvent>).height = m.height;
                  if (m.filter !== undefined) (curPend as Partial<ImageUpdateEvent>).filter = m.filter;
                  if (m.rotX !== undefined) (curPend as Partial<ImageUpdateEvent>).rotX = m.rotX;
                  if (m.rotY !== undefined) (curPend as Partial<ImageUpdateEvent>).rotY = m.rotY;
                  if (m.rotZ !== undefined) (curPend as Partial<ImageUpdateEvent>).rotZ = m.rotZ;
                  if (m.dvdEnabled !== undefined) (curPend as Partial<ImageUpdateEvent>).dvdEnabled = m.dvdEnabled;
                  if (m.dvdSpeed !== undefined) (curPend as Partial<ImageUpdateEvent>).dvdSpeed = m.dvdSpeed;
                  if (m.chromaSpeed !== undefined) (curPend as Partial<ImageUpdateEvent>).chromaSpeed = m.chromaSpeed;
                  if (m.chromaSaturation !== undefined) (curPend as Partial<ImageUpdateEvent>).chromaSaturation = m.chromaSaturation;
                  if (m.chromaLightness !== undefined) (curPend as Partial<ImageUpdateEvent>).chromaLightness = m.chromaLightness;
                  if (m.rotXAnimEnabled !== undefined) (curPend as Partial<ImageUpdateEvent>).rotXAnimEnabled = m.rotXAnimEnabled;
                  if (m.rotXAnimSpeed !== undefined) (curPend as Partial<ImageUpdateEvent>).rotXAnimSpeed = m.rotXAnimSpeed;
                  if (m.rotXAnimMin !== undefined) (curPend as Partial<ImageUpdateEvent>).rotXAnimMin = m.rotXAnimMin;
                  if (m.rotXAnimMax !== undefined) (curPend as Partial<ImageUpdateEvent>).rotXAnimMax = m.rotXAnimMax;
                  if (m.rotYAnimEnabled !== undefined) (curPend as Partial<ImageUpdateEvent>).rotYAnimEnabled = m.rotYAnimEnabled;
                  if (m.rotYAnimSpeed !== undefined) (curPend as Partial<ImageUpdateEvent>).rotYAnimSpeed = m.rotYAnimSpeed;
                  if (m.rotYAnimMin !== undefined) (curPend as Partial<ImageUpdateEvent>).rotYAnimMin = m.rotYAnimMin;
                  if (m.rotYAnimMax !== undefined) (curPend as Partial<ImageUpdateEvent>).rotYAnimMax = m.rotYAnimMax;
                  if (m.rotZAnimEnabled !== undefined) (curPend as Partial<ImageUpdateEvent>).rotZAnimEnabled = m.rotZAnimEnabled;
                  if (m.rotZAnimSpeed !== undefined) (curPend as Partial<ImageUpdateEvent>).rotZAnimSpeed = m.rotZAnimSpeed;
                  if (m.rotZAnimMin !== undefined) (curPend as Partial<ImageUpdateEvent>).rotZAnimMin = m.rotZAnimMin;
                  if (m.rotZAnimMax !== undefined) (curPend as Partial<ImageUpdateEvent>).rotZAnimMax = m.rotZAnimMax;
                  if (m.chromaKeyEnabled !== undefined) (curPend as Partial<ImageUpdateEvent>).chromaKeyEnabled = m.chromaKeyEnabled;
                  if (m.chromaKeyColor !== undefined) (curPend as Partial<ImageUpdateEvent>).chromaKeyColor = m.chromaKeyColor;
                  if (m.chromaKeyTolerance !== undefined) (curPend as Partial<ImageUpdateEvent>).chromaKeyTolerance = m.chromaKeyTolerance;
                  if (m.chromaKeyFeather !== undefined) (curPend as Partial<ImageUpdateEvent>).chromaKeyFeather = m.chromaKeyFeather;
                  if (m.chromaKeySpill !== undefined) (curPend as Partial<ImageUpdateEvent>).chromaKeySpill = m.chromaKeySpill;
                  pendingImageUpdatesRef.current.set(m.imageId, curPend as Partial<ImageUpdateEvent>);
                }
              }
            }
          }
        } catch {
        }
      };
  socketRef.current = socket;
      if (!outbox.current) {
        outbox.current = createOutbox(
          () => {
            const s = socketRef.current;
            return s ? { emit: (event: string, payload: string) => s.emit(event, payload), connected: s.connected } : null;
          },
          () => setChatLog(l => [...l, { kind: 'sys', text: 'The message is larger than 12 MB. Please use a smaller image.', ts: Date.now() }])
        );
      }
    }
    connect();
    const typingCleanup = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of typingPeersRef.current) {
        if (now - v.last > 3000) typingPeersRef.current.delete(k);
      }
    }, 20000);
    return () => {
      aborted = true;
      try { socketRef.current?.disconnect(); } catch {}
  socketRef.current = null;
  outbox.current?.stop();
      pendingPingEntries.clear();
  pingSamplesRef.current = [];
  try { (socketRef as unknown as { _visCleanup?: () => void })._visCleanup?.(); } catch {}
      clearInterval(typingCleanup);
    };
  }, [addChatItem, computeFingerprint, computeFpKeys, ensureDvdState, ensureFontLoaded, ensureImageNaturalInfo, ensureRotState, id, preloadSnapshotMedia, readOnly, rebuildImagesFromHistory, rebuildTextsFromHistory, replayBoard, router, sendCritical, sendPing, socketToken, startFlush, touchParticipant, wsEpoch]);
  useEffect(() => {
    if (readOnly) return;
    const handler = () => {
  if (unsyncRef.current.fixing) return;
      try {
        const payload = JSON.stringify({ type: "presence", kind: "leave", id, name });
        if (navigator.sendBeacon) {
          const u = new URL(window.location.href);
          u.pathname = "/socket.io/";  
          navigator.sendBeacon(u.toString(), payload);
        }
      } catch {}
      try { socketRef.current?.emit?.("message", { type: "presence", kind: "leave", id, name }); } catch {}
    };
    window.addEventListener("beforeunload", handler);
    window.addEventListener("unload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("unload", handler);
    };
  }, [id, name, readOnly]);
  useEffect(() => {
    const beforeUnloadConfirm = (e: BeforeUnloadEvent) => {
      if (imageUploading || mediaProcessing) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
      return undefined;
    };
    const onUnload = () => {
      if (imageUploading || mediaProcessing) {
        try { currentUploadXhrRef.current?.abort(); } catch {}
      }
    };
    window.addEventListener('beforeunload', beforeUnloadConfirm);
    window.addEventListener('unload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnloadConfirm);
      window.removeEventListener('unload', onUnload);
    };
  }, [imageUploading, mediaProcessing]);
  useEffect(() => {
    const send = () => {
      try { sendPing(); } catch {}
    };
    send();
    const t = window.setInterval(send, 10000);
    return () => window.clearInterval(t);
  }, [sendPing]);
  const repairResync = useCallback(() => {
    const u = unsyncRef.current;
    u.fixing = true; u.bad = 0; u.shown = false; setUnsyncShown(false);
  try { sendCritical({ type: "presence", kind: "quiet" }); } catch {}
    setWsEpoch(e => e + 1);
    window.setTimeout(() => { const uu = unsyncRef.current; uu.fixing = false; }, 3000);
  }, [sendCritical]);
  useEffect(() => {
    return startAnimationLoop({
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
      repaint: () => forceTick(t => t + 1),
      sendCritical,
    });
  }, [id, sendCritical]);
  const triggerUndo = useCallback(() => {
    const arr = historyRef.current as unknown as Array<{ strokeId?: string }>;
    for (let i = arr.length - 1; i >= 0; i--) {
      const sid = arr[i]?.strokeId;
      if (sid && !undoneRef.current.has(sid)) {
        const msg: UndoRedoPayload = { type: "undo", by: id, strokeId: sid };
        sendCritical(msg);
        undoneRef.current.add(sid);
  undoOrderRef.current.push(sid);
        replayBoard();
        rebuildTextsFromHistory();
        rebuildImagesFromHistory();
        forceTick(t => t + 1);
        return;
      }
    }
  }, [id, rebuildImagesFromHistory, rebuildTextsFromHistory, replayBoard, sendCritical]);
  const triggerRedo = useCallback(() => {
    const sid = undoOrderRef.current.pop();
    if (sid) {
  const msg: UndoRedoPayload = { type: "redo", by: id, strokeId: sid };
  sendCritical(msg);
      undoneRef.current.delete(sid);
      replayBoard();
    rebuildTextsFromHistory();
      rebuildImagesFromHistory();
      forceTick(t => t + 1);
    }
  }, [id, rebuildImagesFromHistory, rebuildTextsFromHistory, replayBoard, sendCritical]);
  useEffect(() => {
    if (readOnly) return;  
    let lastSent = 0;
  const MIN_INTERVAL = 45;  
    const handler = (e: PointerEvent) => {
  const container = containerRef.current;
  if (!container) return;
  const pos = screenToBoardNorm(e.clientX, e.clientY);
  const nx = pos.x;
  const ny = pos.y;
  selfPos.current = { x: nx, y: ny };
  try { touchParticipant(id, name); } catch {}
  const socket = socketRef.current;
  if (!socket || !socket.connected) return;
  if (!snapshotReadyRef.current || mediaBusy) return;
  const now = performance.now();
  if (now - lastSent < MIN_INTERVAL) return;
  lastSent = now;
  const msg: CursorPayload = { type: "cursor", id, name, x: nx, y: ny, tool, size: tool === "eraser" ? eraserSize : tool === "text" ? textSize : penSize };
  sendCritical(msg);
    };
  const el = containerRef.current;
  const opts: AddEventListenerOptions = { passive: true };
  el?.addEventListener("pointermove", handler as EventListener, opts);
  return () => el?.removeEventListener("pointermove", handler as EventListener, opts);
  }, [eraserSize, id, mediaBusy, name, penSize, readOnly, screenToBoardNorm, sendCritical, textSize, touchParticipant, tool]);
  useEffect(() => {
    const t = setInterval(() => { touchParticipant(id, name); }, 15000);
    return () => clearInterval(t);
  }, [id, name, touchParticipant]);
  const forceSendCursor = useCallback(() => {
    if (readOnly || mediaBusy) return;
    const socket = socketRef.current;
    const pos = selfPos.current;
    if (!snapshotReadyRef.current || !socket || !socket.connected || !pos) return;
    const { x, y } = pos;
    const msg: CursorPayload = {
      type: "cursor",
      id,
      name,
      x,
      y,
      tool,
      size: tool === "eraser" ? eraserSize : tool === "text" ? textSize : penSize,
    };
    sendCritical(msg);
  }, [eraserSize, id, mediaBusy, name, penSize, readOnly, sendCritical, textSize, tool]);
  useEffect(() => {
    if (readOnly) return;  
  const socket = socketRef.current;
  const pos = selfPos.current;
  if (!snapshotReadyRef.current || mediaBusy) return;
  if (!socket || !socket.connected || !pos) return;
    const { x, y } = pos;
    const msg: CursorPayload = {
      type: "cursor",
      id,
      name,
      x,
      y,
      tool,
      size: tool === "eraser" ? eraserSize : tool === "text" ? textSize : penSize,
    };
  sendCritical(msg);
  }, [eraserSize, id, mediaBusy, name, penSize, readOnly, sendCritical, textSize, tool]);
  useEffect(() => {
    forceSendCursor();
  }, [forceSendCursor]);
  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSentRef.current > 450) {
      lastTypingSentRef.current = now;
      sendCritical({ type: "typing", id, name, typing: true });
    }
    if (typingStopTimerRef.current) { clearTimeout(typingStopTimerRef.current); typingStopTimerRef.current = null; }
    typingStopTimerRef.current = window.setTimeout(() => {
      sendCritical({ type: "typing", id, name, typing: false });
      typingStopTimerRef.current = null;
    }, 1100);
  }, [id, name, sendCritical]);
  useEffect(() => {
  const t = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [k, v] of typingPeersRef.current) {
    if (now - v.last > 2000) { typingPeersRef.current.delete(k); changed = true; }
      }
      if (changed) forceTick(n => n + 1);
  }, 500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (readOnly) return;
    const cur = curTextRef2.current;
    const newColor = textChroma.enabled ? chromaColor(textChroma) : textColor;
    if (cur) {
      cur.color = newColor;
      cur.size = textSize;
      cur.font = textFont;
      const outlineClone = cloneTextOutline(textOutline);
      cur.outline = outlineClone;
      if (cur.committed) {
        const tb = committedTextsRef.current.get(cur.textId);
        const upd: TextUpdateEvent = { type: "text_update", id, textId: cur.textId, color: newColor, size: textSize, font: textFont, strokeId: tb?.strokeId, outline: outlineClone };
        sendCritical(upd);
        historyRef.current.push(upd);
        if (tb) committedTextsRef.current.set(cur.textId, { ...tb, color: newColor, size: textSize, font: textFont, outline: outlineClone });
      }
      forceTick(t => t + 1);
      return;
    }
    const ed = editingTextRef.current;
    if (!ed) return;
    ed.color = newColor;
    ed.size = textSize;
    ed.font = textFont;
  const outlineClone = cloneTextOutline(textOutline);
  ed.outline = outlineClone;
  overlayTextsRef.current.set(ed.textId, { textId: ed.textId, x: ed.x, y: ed.y, text: ed.text, color: ed.color, size: ed.size, font: ed.font, width: ed.width, height: ed.height, outline: outlineClone });
  const live: TextLivePayload = { type: "text_live", id, textId: ed.textId, text: ed.text, x: ed.x, y: ed.y, color: ed.color, size: ed.size, font: ed.font, width: ed.width, height: ed.height, outline: outlineClone };
    sendCritical(live);
    forceTick(t => t + 1);
  }, [chromaColor, id, readOnly, sendCritical, textChroma, textColor, textFont, textOutline, textSize]);
  useEffect(() => {
    if (readOnly) return;
    if (tool !== "select" || !selectedTextId) return;
    const cur = committedTextsRef.current.get(selectedTextId);
    if (!cur) return;
    const newColor = textChroma.enabled ? chromaColor(textChroma) : textColor;
    const outlineClone = cloneTextOutline(textOutline);
    const upd: TextUpdateEvent = {
      type: "text_update",
      id,
      textId: selectedTextId,
      color: newColor,
      size: textSize,
      font: textFont,
      strokeId: cur.strokeId,
      chroma: textChroma.enabled ? { ...textChroma } : undefined,
      outline: outlineClone,
    };
    sendCritical(upd);
    historyRef.current.push(upd);
    committedTextsRef.current.set(selectedTextId, { ...cur, color: newColor, size: textSize, font: textFont, outline: outlineClone });
    try { forceTick(t => t + 1); } catch {}
  }, [chromaColor, id, readOnly, sendCritical, selectedTextId, textChroma, textColor, textFont, textOutline, textSize, tool]);
  useEffect(() => {
    const detach = attachPenAndEraser({
      id,
      name,
      toolRef: { current: tool },
      readOnlyRef: { current: readOnly },
      areaRef,
      boardRef,
      penSizeRef: { current: penSize },
      eraserSizeRef: { current: eraserSize },
      penColorRef: { current: penColor },
      penChromaRef: { current: penChroma },
      chromaColor,
      screenToBoardNorm,
      sendCritical,
    });
  return () => { try { if (detach) detach(); } catch {} };
  }, [id, name, tool, readOnly, penSize, eraserSize, penColor, penChroma, chromaColor, screenToBoardNorm, sendCritical]);
  useEffect(() => {
    const { detach } = attachTextTool({
      id,
      toolRef: { current: tool },
      readOnlyRef: { current: readOnly },
      containerRef,
      screenToBoardNorm,
      boardNormToScreen,
      setTextInputActive,
      setTextInputValue,
      textInputRef,
      textInputUi,
      curTextRef2,
      textColorRef: { current: textColor },
      textSizeRef: { current: textSize },
      textFontRef: { current: textFont },
      textChromaRef: { current: textChroma },
      textOutlineRef: { current: textOutline },
      chromaColor,
      committedTextsRef,
      historyRef,
      myStrokesRef,
      setSelectedTextId,
      setSelectedImageId,
      sendCritical,
    });
    return () => { try { detach(); } catch {} };
  }, [id, tool, readOnly, textColor, textSize, textFont, textChroma, textOutline, chromaColor, boardNormToScreen, screenToBoardNorm, sendCritical]);
  useEffect(() => {
    const detach = attachMediaTool({
      id,
      toolRef: { current: tool },
      readOnlyRef: { current: readOnly },
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
    });
    return () => { try { if (detach) detach(); } catch {} };
  }, [id, tool, readOnly, sendCritical, forceTick, screenToBoardNorm]);
  const sendTextImmediate = useCallback((val: string) => {
    const cur = curTextRef2.current;
    if (!cur) return;
    const chromaEnabled = !!textChroma.enabled;
    const chromaSnapshot = chromaEnabled ? { ...textChroma } : undefined;
    const effectiveColor = chromaEnabled ? chromaColor(textChroma) : cur.color;
    const outlineClone = cloneTextOutline(cur.outline, textOutline);
    cur.outline = outlineClone;
    if (!cur.committed) {
      if (val.length === 0) return;  
      const commit: TextCommitEvent = {
        type: "text_commit",
        id,
        textId: cur.textId,
        text: val,
        x: cur.x,
        y: cur.y,
        color: effectiveColor,
        size: cur.size,
        font: cur.font,
        strokeId: cur.strokeId,
        chroma: chromaSnapshot,
        outline: outlineClone,
      };
      sendCritical(commit);
      historyRef.current.push(commit);
      myStrokesRef.current.push(cur.strokeId);
      committedTextsRef.current.set(cur.textId, {
        textId: cur.textId,
        x: cur.x,
        y: cur.y,
        text: val,
        color: effectiveColor,
        size: cur.size,
        font: cur.font,
        strokeId: cur.strokeId,
        outline: outlineClone,
      });
      cur.committed = true;
    } else {
      const strokeId = committedTextsRef.current.get(cur.textId)?.strokeId;
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
        strokeId,
        chroma: chromaSnapshot,
        outline: outlineClone,
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
          color: effectiveColor,
          size: cur.size,
          font: cur.font,
          outline: outlineClone,
        });
      }
    }
    forceTick(t => t + 1);
  }, [chromaColor, id, sendCritical, textChroma, textOutline]);
  useEffect(() => {
    if (readOnly) return;
    if (tool !== "text" && textInputActive) {
      setTextInputActive(false);
      curTextRef2.current = null;
    }
  }, [tool, textInputActive, readOnly]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (readOnly) return;
  const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || (e.target as HTMLElement | null)?.isContentEditable) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (chatOpen && (key === "enter") && !ctrl) {
        chatInputRef2.current?.focus();
        return;
      }
      const redoCombo = (ctrl && (e.shiftKey && key === "z")) || (ctrl && key === "y");
      if (ctrl && key === "z" && !e.shiftKey) {
        e.preventDefault();
        try { triggerUndo(); } catch {}
        unsyncSuppressUntilRef.current = Date.now() + 3000;
        return;
      } else if (redoCombo) {
        e.preventDefault();
        try { triggerRedo(); } catch {}
        unsyncSuppressUntilRef.current = Date.now() + 3000;
        return;
      }
      if (e.key === "Delete" && tool === "select") {
        if (selectedTextIds.length > 0) {
          for (const tid of selectedTextIds) {
            const tb = committedTextsRef.current.get(tid);
            if (!tb) continue;
            const sid = tb.strokeId;
            const msg: UndoRedoPayload = { type: "undo", by: id, strokeId: sid };
            sendCritical(msg);
            undoneRef.current.add(sid);
            if (myStrokesRef.current.includes(sid)) undoOrderRef.current.push(sid);
          }
          rebuildTextsFromHistory();
          setSelectedTextIds([]);
          setSelectedTextId(null);
          forceTick(t => t + 1);
          e.preventDefault();
          return;
        }
        if (selectedTextId) {
          const tb = committedTextsRef.current.get(selectedTextId);
          if (tb) {
            const sid = tb.strokeId;
            const msg: UndoRedoPayload = { type: "undo", by: id, strokeId: sid };
            sendCritical(msg);
            undoneRef.current.add(sid);
            if (myStrokesRef.current.includes(sid)) undoOrderRef.current.push(sid);
            rebuildTextsFromHistory();
            forceTick(t => t + 1);
            return;
          }
        }
        if (selectedImageIds.length > 0) {
          for (const iid of selectedImageIds) {
            const im = committedImagesRef.current.get(iid);
            if (!im) continue;
            const sid = im.strokeId;
            const msg: UndoRedoPayload = { type: "undo", by: id, strokeId: sid };
            sendCritical(msg);
            undoneRef.current.add(sid);
            if (myStrokesRef.current.includes(sid)) undoOrderRef.current.push(sid);
          }
          rebuildImagesFromHistory();
          setSelectedImageIds([]);
          setSelectedImageId(null);
          forceTick(t => t + 1);
          e.preventDefault();
          return;
        }
        if (selectedImageId) {
          const im = committedImagesRef.current.get(selectedImageId);
          if (im) {
            const sid = im.strokeId;
            const msg: UndoRedoPayload = { type: "undo", by: id, strokeId: sid };
            sendCritical(msg);
            undoneRef.current.add(sid);
            if (myStrokesRef.current.includes(sid)) undoOrderRef.current.push(sid);
            rebuildImagesFromHistory();
            forceTick(t => t + 1);
            return;
          }
        }
      }
      if (ctrl && key === "c" && tool === "select") {
        const texts: TextClip[] = [];
        const images: ImageClip[] = [];
        const textIds = selectedTextIds.length ? selectedTextIds : (selectedTextId ? [selectedTextId] : []);
        const imageIds = selectedImageIds.length ? selectedImageIds : (selectedImageId ? [selectedImageId] : []);
        for (const tid of textIds) {
          const v = committedTextsRef.current.get(tid);
          if (!v) continue;
          texts.push({ text: v.text, x: v.x, y: v.y, width: v.width, height: v.height, color: v.color, size: v.size, font: v.font, chroma: v.chroma, outline: v.outline ? cloneTextOutline(v.outline, textOutline) : undefined, rotX: v.rotX, rotY: v.rotY, rotZ: v.rotZ });
        }
        for (const iid of imageIds) {
          const v = committedImagesRef.current.get(iid);
          if (!v) continue;
          images.push({ src: v.src, x: v.x, y: v.y, width: v.width, height: v.height, filter: v.filter, rotX: v.rotX, rotY: v.rotY, rotZ: v.rotZ, mediaKind: v.mediaKind, animated: v.animated, origin: v.origin });
        }
        if (texts.length || images.length) {
          clipboardRef.current = { texts, images };
          pasteBumpRef.current = 0;
        }
        e.preventDefault();
      }
      if (ctrl && key === "v" && tool === "select") {
  const cb = clipboardRef.current;
        if (!cb) return;
        const bump = (++pasteBumpRef.current) * (12 / BOARD_H);
        const newTextIds: string[] = [];
        const newImageIds: string[] = [];
        for (const v of cb.texts) {
          const textId = `${id}-txt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const strokeId = `${id}-text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const outlineClone = v.outline ? cloneTextOutline(v.outline, textOutline) : undefined;
          const commit: TextCommitEvent = { type: "text_commit", id, textId, text: v.text, x: Math.min(1, v.x), y: Math.min(1, v.y + bump), color: v.color, size: v.size, font: v.font, strokeId, width: v.width, height: v.height, chroma: v.chroma, rotX: v.rotX, rotY: v.rotY, rotZ: v.rotZ, outline: outlineClone };
          sendCritical(commit); historyRef.current.push(commit); myStrokesRef.current.push(strokeId);
          committedTextsRef.current.set(textId, { textId, x: commit.x, y: commit.y, width: commit.width, height: commit.height, text: v.text, color: v.color, size: v.size, font: v.font, strokeId, chroma: v.chroma, outline: outlineClone, rotX: v.rotX, rotY: v.rotY, rotZ: v.rotZ });
          newTextIds.push(textId);
        }
        for (const v of cb.images) {
          const imageId = `${id}-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const strokeId = `${id}-image-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const commit: ImageCommitEvent = { type: "image_commit", id, imageId, src: v.src, x: Math.min(1, v.x), y: Math.min(1, v.y + bump), width: v.width, height: v.height, strokeId, filter: v.filter, rotX: v.rotX, rotY: v.rotY, rotZ: v.rotZ, mediaKind: v.mediaKind, animated: v.animated, origin: v.origin };
          sendCritical(commit); historyRef.current.push(commit); myStrokesRef.current.push(strokeId);
          committedImagesRef.current.set(imageId, { imageId, x: commit.x, y: commit.y, width: commit.width, height: commit.height, src: v.src, strokeId, filter: v.filter, rotX: v.rotX, rotY: v.rotY, rotZ: v.rotZ, mediaKind: v.mediaKind, animated: v.animated, origin: v.origin });
          newImageIds.push(imageId);
        }
        setSelectedTextIds(newTextIds);
        setSelectedImageIds(newImageIds);
        setSelectedTextId(newTextIds.length === 1 && newImageIds.length === 0 ? newTextIds[0] : null);
        setSelectedImageId(newImageIds.length === 1 && newTextIds.length === 0 ? newImageIds[0] : null);
        forceTick(t => t + 1);
        e.preventDefault();
      }
      if (e.key === "Escape" && marqueeRef.current) {
        marqueeRef.current = null;
        forceTick(t => t + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen, id, readOnly, rebuildImagesFromHistory, rebuildTextsFromHistory, selectedImageId, selectedImageIds, selectedTextId, selectedTextIds, sendCritical, textOutline, tool, triggerRedo, triggerUndo]);
  const deleteSelected = useCallback(() => {
    if (readOnly || tool !== "select") return;
    if (selectedTextIds.length > 0) {
      for (const tid of selectedTextIds) {
        const tb = committedTextsRef.current.get(tid);
        if (!tb) continue;
        const sid = tb.strokeId;
        const msg: UndoRedoPayload = { type: "undo", by: id, strokeId: sid };
        sendCritical(msg);
        undoneRef.current.add(sid);
        if (myStrokesRef.current.includes(sid)) undoOrderRef.current.push(sid);
      }
      rebuildTextsFromHistory();
      setSelectedTextIds([]);
      setSelectedTextId(null);
      forceTick(t => t + 1);
      return;
    }
    if (selectedTextId) {
      const tb = committedTextsRef.current.get(selectedTextId);
      if (tb) {
        const sid = tb.strokeId;
        const msg: UndoRedoPayload = { type: "undo", by: id, strokeId: sid };
        sendCritical(msg);
        undoneRef.current.add(sid);
        if (myStrokesRef.current.includes(sid)) undoOrderRef.current.push(sid);
        rebuildTextsFromHistory();
        forceTick(t => t + 1);
        return;
      }
    }
    if (selectedImageIds.length > 0) {
      for (const iid of selectedImageIds) {
        const im = committedImagesRef.current.get(iid);
        if (!im) continue;
        const sid = im.strokeId;
        const msg: UndoRedoPayload = { type: "undo", by: id, strokeId: sid };
        sendCritical(msg);
        undoneRef.current.add(sid);
        if (myStrokesRef.current.includes(sid)) undoOrderRef.current.push(sid);
      }
      rebuildImagesFromHistory();
      setSelectedImageIds([]);
      setSelectedImageId(null);
      forceTick(t => t + 1);
      return;
    }
    if (selectedImageId) {
      const im = committedImagesRef.current.get(selectedImageId);
      if (im) {
        const sid = im.strokeId;
        const msg: UndoRedoPayload = { type: "undo", by: id, strokeId: sid };
        sendCritical(msg);
        undoneRef.current.add(sid);
        if (myStrokesRef.current.includes(sid)) undoOrderRef.current.push(sid);
        rebuildImagesFromHistory();
        forceTick(t => t + 1);
        return;
      }
    }
  }, [id, readOnly, rebuildImagesFromHistory, rebuildTextsFromHistory, selectedImageId, selectedImageIds, selectedTextId, selectedTextIds, sendCritical, tool]);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (readOnly) return;
      const st = dragStateRef.current;
      if (!st) return;
  const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
      st.shift = e.shiftKey;
      if (st.entity === "text") {
        const cur = committedTextsRef.current.get(st.id);
        if (!cur) return;
        if (st.kind === "move") {
          const dx = nx - st.startX;
          const dy = ny - st.startY;
          const next = { ...cur, x: st.origin.x + dx, y: st.origin.y + dy };
          committedTextsRef.current.set(st.id, next);
          const upd: TextUpdateEvent = { type: "text_update", id, textId: st.id, x: next.x, y: next.y, strokeId: cur.strokeId };
          const now = performance.now();
          if (now - lastDragSentRef.current >= DRAG_SEND_INTERVAL_MS) {
            lastDragSentRef.current = now;
            sendCritical(upd);
            historyRef.current.push(upd as unknown as HistoryEvent);
          } else {
            pendingDragUpdateRef.current = upd;
            if (!dragFlushRafRef.current) {
              dragFlushRafRef.current = requestAnimationFrame(() => {
                dragFlushRafRef.current = 0;
                const pend = pendingDragUpdateRef.current;
                if (!pend) return;
                if (performance.now() - lastDragSentRef.current >= DRAG_SEND_INTERVAL_MS) {
                  lastDragSentRef.current = performance.now();
                  sendCritical(pend);
                  historyRef.current.push(pend as unknown as HistoryEvent);
                  pendingDragUpdateRef.current = null;
                } else {
                  if (!dragFlushRafRef.current) dragFlushRafRef.current = requestAnimationFrame(() => {
                    dragFlushRafRef.current = 0;
                    const p2 = pendingDragUpdateRef.current;
                    if (!p2) return;
                    lastDragSentRef.current = performance.now();
                    sendCritical(p2);
                    historyRef.current.push(p2 as unknown as HistoryEvent);
                    pendingDragUpdateRef.current = null;
                  });
                }
              });
            }
          }
          forceTick(t => t + 1);  
        } else if (st.kind === "resize") {
          const dw = nx - st.startX;
          const dh = ny - st.startY;
          const nextW = Math.max(50 / BOARD_W, (st.origin.width ?? 0.2) + dw);
          const nextH = Math.max(30 / BOARD_H, (st.origin.height ?? 0.1) + dh);
          const next = { ...cur, width: nextW, height: nextH };
          committedTextsRef.current.set(st.id, next);
          const upd: TextUpdateEvent = { type: "text_update", id, textId: st.id, width: nextW, height: nextH, strokeId: cur.strokeId };
          const now = performance.now();
          if (now - lastDragSentRef.current >= DRAG_SEND_INTERVAL_MS) {
            lastDragSentRef.current = now;
            sendCritical(upd);
            historyRef.current.push(upd as unknown as HistoryEvent);
          } else {
            pendingDragUpdateRef.current = upd;
            if (!dragFlushRafRef.current) {
              dragFlushRafRef.current = requestAnimationFrame(() => {
                dragFlushRafRef.current = 0;
                const pend = pendingDragUpdateRef.current;
                if (!pend) return;
                if (performance.now() - lastDragSentRef.current >= DRAG_SEND_INTERVAL_MS) {
                  lastDragSentRef.current = performance.now();
                  sendCritical(pend);
                  historyRef.current.push(pend as unknown as HistoryEvent);
                  pendingDragUpdateRef.current = null;
                } else {
                  if (!dragFlushRafRef.current) dragFlushRafRef.current = requestAnimationFrame(() => {
                    dragFlushRafRef.current = 0;
                    const p2 = pendingDragUpdateRef.current;
                    if (!p2) return;
                    lastDragSentRef.current = performance.now();
                    sendCritical(p2);
                    historyRef.current.push(p2 as unknown as HistoryEvent);
                    pendingDragUpdateRef.current = null;
                  });
                }
              });
            }
          }
          forceTick(t => t + 1);
        }
      } else if (st.entity === "image") {
        const cur = committedImagesRef.current.get(st.id);
        if (!cur) return;
        if (st.kind === "move") {
          const dx = nx - st.startX;
          const dy = ny - st.startY;
          const next = { ...cur, x: st.origin.x + dx, y: st.origin.y + dy };
          committedImagesRef.current.set(st.id, next);
          const upd: ImageUpdateEvent = { type: "image_update", id, imageId: st.id, x: next.x, y: next.y, strokeId: cur.strokeId };
          const now = performance.now();
          if (now - lastDragSentRef.current >= DRAG_SEND_INTERVAL_MS) {
            lastDragSentRef.current = now;
            sendCritical(upd);
            historyRef.current.push(upd as unknown as HistoryEvent);
          } else {
            pendingDragUpdateRef.current = upd;
            if (!dragFlushRafRef.current) {
              dragFlushRafRef.current = requestAnimationFrame(() => {
                dragFlushRafRef.current = 0;
                const pend = pendingDragUpdateRef.current;
                if (!pend) return;
                if (performance.now() - lastDragSentRef.current >= DRAG_SEND_INTERVAL_MS) {
                  lastDragSentRef.current = performance.now();
                  sendCritical(pend);
                  historyRef.current.push(pend as unknown as HistoryEvent);
                  pendingDragUpdateRef.current = null;
                } else {
                  if (!dragFlushRafRef.current) dragFlushRafRef.current = requestAnimationFrame(() => {
                    dragFlushRafRef.current = 0;
                    const p2 = pendingDragUpdateRef.current;
                    if (!p2) return;
                    lastDragSentRef.current = performance.now();
                    sendCritical(p2);
                    historyRef.current.push(p2 as unknown as HistoryEvent);
                    pendingDragUpdateRef.current = null;
                  });
                }
              });
            }
          }
          forceTick(t => t + 1);
        } else if (st.kind === "resize") {
          const minW = 10 / BOARD_W;
          const minH = 10 / BOARD_H;
          const maxW = 1;
          const maxH = 1;
          const baseX = st.origin.x;
          const baseY = st.origin.y;
          const baseW = st.origin.width ?? cur.width;
          const baseH = st.origin.height ?? cur.height;
          const aspect = (committedImagesRef.current.get(st.id)?.aspect) || st.origin.aspect || (cur.width / Math.max(1e-6, cur.height));
          let left = baseX;
          let top = baseY;
          let width = baseW;
          let height = baseH;
          const rawDx = nx - st.startX;
          const rawDy = ny - st.startY;
          let dx = rawDx;
          let dy = rawDy;
          const rotZ = ((cur.rotZ ?? 0) % 360 + 360) % 360;
          if (rotZ !== 0) {
            const angleRad = (rotZ * Math.PI) / 180;
            const cosA = Math.cos(angleRad);
            const sinA = Math.sin(angleRad);
            const dxPx = rawDx * BOARD_W;
            const dyPx = rawDy * BOARD_H;
            const localDxPx = dxPx * cosA + dyPx * sinA;
            const localDyPx = -dxPx * sinA + dyPx * cosA;
            dx = localDxPx / BOARD_W;
            dy = localDyPx / BOARD_H;
          }
          const anchor = st.anchor || "br";
          const handle = st.handle || anchor;
          const handleHoriz = horizontalComponent(handle);
          const anchorHoriz = horizontalComponent(anchor);
          if (handleHoriz && anchorHoriz && handleHoriz !== anchorHoriz) {
            dx = -dx;
          }
          const handleVert = verticalComponent(handle);
          const anchorVert = verticalComponent(anchor);
          if (handleVert && anchorVert && handleVert !== anchorVert) {
            dy = -dy;
          }
          const applyClamp = () => {
            const clampedW = Math.max(minW, Math.min(maxW, width));
            const clampedH = Math.max(minH, Math.min(maxH, height));
            if (clampedW !== width) {
              if (anchor === "l" || anchor === "tl" || anchor === "bl") {
                const rightFixed = baseX + baseW;
                left = rightFixed - clampedW;
              }
              width = clampedW;
            }
            if (clampedH !== height) {
              if (anchor === "t" || anchor === "tl" || anchor === "tr") {
                const bottomFixed = baseY + baseH;
                top = bottomFixed - clampedH;
              }
              height = clampedH;
            }
          };
          const keepAspectFromWidth = () => { height = (width * BOARD_W) / (Math.max(1e-6, aspect) * BOARD_H); };
          const keepAspectFromHeight = () => { width = (height * Math.max(1e-6, aspect) * BOARD_H) / BOARD_W; };
          if (anchor === "br") {
            width = baseW + dx;
            height = baseH + dy;
            if (st.shift) keepAspectFromWidth();
          } else if (anchor === "tr") {
            width = baseW + dx;
            if (st.shift) { keepAspectFromWidth(); top = baseY + (baseH - height); }
            else { height = baseH - dy; top = baseY + dy; }
          } else if (anchor === "bl") {
            height = baseH + dy;
            if (st.shift) { keepAspectFromHeight(); left = baseX + (baseW - width); }
            else { width = baseW - dx; left = baseX + dx; }
          } else if (anchor === "tl") {
            if (st.shift) {
              width = baseW - dx; left = baseX + dx;
              keepAspectFromWidth(); top = baseY + (baseH - height);
            } else {
              width = baseW - dx; left = baseX + dx;
              height = baseH - dy; top = baseY + dy;
            }
          } else if (anchor === "r") {
            width = baseW + dx;
            if (st.shift) keepAspectFromWidth();
          } else if (anchor === "l") {
            width = baseW - dx; left = baseX + dx;
            if (st.shift) { keepAspectFromWidth(); left = baseX + (baseW - width); }
          } else if (anchor === "b") {
            height = baseH + dy;
            if (st.shift) keepAspectFromHeight();
          } else if (anchor === "t") {
            height = baseH - dy; top = baseY + dy;
            if (st.shift) { keepAspectFromHeight(); top = baseY + (baseH - height); }
          }
          applyClamp();
          const next = { ...cur, x: left, y: top, width, height };
          committedImagesRef.current.set(st.id, next);
          const upd: ImageUpdateEvent = { type: "image_update", id, imageId: st.id, x: next.x, y: next.y, width: next.width, height: next.height, strokeId: cur.strokeId };
          const now = performance.now();
          if (now - lastDragSentRef.current >= DRAG_SEND_INTERVAL_MS) {
            lastDragSentRef.current = now;
            sendCritical(upd);
            historyRef.current.push(upd as unknown as HistoryEvent);
          } else {
            pendingDragUpdateRef.current = upd;
            if (!dragFlushRafRef.current) {
              dragFlushRafRef.current = requestAnimationFrame(() => {
                dragFlushRafRef.current = 0;
                const pend = pendingDragUpdateRef.current;
                if (!pend) return;
                if (performance.now() - lastDragSentRef.current >= DRAG_SEND_INTERVAL_MS) {
                  lastDragSentRef.current = performance.now();
                  sendCritical(pend);
                  historyRef.current.push(pend as unknown as HistoryEvent);
                  pendingDragUpdateRef.current = null;
                } else {
                  if (!dragFlushRafRef.current) dragFlushRafRef.current = requestAnimationFrame(() => {
                    dragFlushRafRef.current = 0;
                    const p2 = pendingDragUpdateRef.current;
                    if (!p2) return;
                    lastDragSentRef.current = performance.now();
                    sendCritical(p2);
                    historyRef.current.push(p2 as unknown as HistoryEvent);
                    pendingDragUpdateRef.current = null;
                  });
                }
              });
            }
          }
          forceTick(t => t + 1);
        }
      }
    };
    const onUp = () => {
      const prev = dragStateRef.current;
      dragStateRef.current = null;
      try {
        if (pendingDragUpdateRef.current) {
          const upd = pendingDragUpdateRef.current;
          sendCritical(upd);
          historyRef.current.push(upd as unknown as HistoryEvent);
          pendingDragUpdateRef.current = null;
        }
        if (dragFlushRafRef.current) { cancelAnimationFrame(dragFlushRafRef.current); dragFlushRafRef.current = 0; }
      } catch {}
      if (!prev) return;
      if (prev.entity === "text") {
        const st = dvdTextStateRef.current.get(prev.id);
        if (st) st.pausedByDrag = false;
        const ctrl: AnimControlPayload = { type: "anim_control", id, entity: "text", targetId: prev.id, dvdPaused: false };
        sendCritical(ctrl);
      } else if (prev.entity === "image") {
        const st = dvdImageStateRef.current.get(prev.id);
        if (st) st.pausedByDrag = false;
        const ctrl: AnimControlPayload = { type: "anim_control", id, entity: "image", targetId: prev.id, dvdPaused: false };
        sendCritical(ctrl);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [id, readOnly, screenToBoardNorm, sendCritical]);
  useEffect(() => { rebuildTextsFromHistory(); rebuildImagesFromHistory(); }, [rebuildTextsFromHistory, rebuildImagesFromHistory]);
  return (
    <div
      className="relative w-full h-full"
      data-whiteboard-root
      ref={containerRef}
      onPointerDown={e => {
  const t = e.target as HTMLElement | null;
  if (t && t.closest('[data-ui-panel]')) return;
        const boardRect = boardRef.current?.getBoundingClientRect();
        if (!boardRect) return;
        const target = e.target as HTMLElement;
        if (target && (target.closest('[data-committed-text]') || target.closest('[data-image-entity]'))) return;
        const x = e.clientX;
        const y = e.clientY;
        if (x < boardRect.left || x > boardRect.right || y < boardRect.top || y > boardRect.bottom) {
          setSelectedTextId(null);
          setSelectedImageId(null);
          setSelectedTextIds([]);
          setSelectedImageIds([]);
        }
      }}
    >
      { }
      {!readOnly && (
        <button
          type="button"
          onClick={() => setShowShortcuts(true)}
          className="absolute top-4 left-4 z-40 w-9 h-9 rounded-full text-lg leading-none flex items-center justify-center floating-circle-button"
          title="Keyboard shortcuts"
        >
          ?
        </button>
      )}
      { }
      {!readOnly && (
        <div
          className="absolute top-4 left-1/2 -translate-x-1/2 z-40 rounded-md px-2 py-1 flex items-center gap-2 shadow-lg"
          data-ui-panel
          onPointerDown={e => e.stopPropagation()}
        >
          <button
            type="button"
            className="px-2 py-1 rounded panel-button"
            title="Undo (Ctrl + Z)"
            aria-label="Undo"
            onClick={() => { unsyncSuppressUntilRef.current = Date.now() + 3000; try { triggerUndo(); } catch {} }}
          >
            ↶ Undo
          </button>
          <div className="w-px h-4 panel-divider" />
          <button
            type="button"
            className="px-2 py-1 rounded panel-button"
            title="Redo (Ctrl + Shift + Z / Ctrl + Y)"
            aria-label="Redo"
            onClick={() => { unsyncSuppressUntilRef.current = Date.now() + 3000; try { triggerRedo(); } catch {} }}
          >
            Redo ↷
          </button>
        </div>
      )}
      {!readOnly && (
        <div
          className="absolute top-3 right-3 z-40 flex items-center gap-2"
          onPointerDown={e => e.stopPropagation()}
        >
          <button
            onClick={handleThemeToggle}
            className="w-8 h-8 rounded-full flex items-center justify-center shadow-lg floating-circle-button"
            title={isDarkTheme ? "Switch to light theme" : "Switch to dark theme"}
            aria-label="Toggle theme"
          >
            {isDarkTheme ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="h-8 rounded-full px-3 text-xs font-medium shadow-lg floating-circle-button"
            title="Sign out"
          >
            Sign out
          </button>
        </div>
      )}
      { }
      {!readOnly && (
        <div className="absolute left-3 bottom-3 z-40" onPointerDown={e => e.stopPropagation()}>
          {chatOpen && (
            <div className="mb-2 w-72 max-w-[85vw] translate-y-[-4px]">
              <div className="bg-white/95 dark:bg-slate-900/92 backdrop-blur rounded-md overflow-hidden text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 shadow-xl" data-ui-panel>
                <div className="flex flex-col max-h-[34vh]">
                  <div ref={chatListRef} className="px-2.5 py-1.5 space-y-1 overflow-auto" style={{ maxHeight: 200 }}>
                    {chatLog.map((m, i) => (
                      <div key={i} className={`text-[12px] leading-4 ${m.kind === "sys" ? "text-slate-500 dark:text-slate-300" : ""}`}>
                        {m.kind === "sys" ? (
                          <span>• {m.text} <span className="opacity-60 ml-1">{fmtClock(m.ts)}</span></span>
                        ) : (
                          <span>
                            <b className="opacity-90 mr-1 text-slate-800 dark:text-slate-100">{m.name}:</b>
                            {m.text}
                            <span className="opacity-60 ml-1">{fmtClock(m.ts)}</span>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  { }
                  <div className="px-2.5 h-4 text-[11px] text-slate-500 dark:text-slate-300">
                    {(() => {
                      const arr = Array.from(typingPeersRef.current.values()).map(v => v.name).filter(Boolean);
                      if (arr.length === 0) return null;
                      if (arr.length === 1) return <span>{arr[0]} is typing...</span>;
                      if (arr.length === 2) return <span>{arr[0]} and {arr[1]} are typing...</span>;
                      if (arr.length === 3) return <span>{arr[0]}, {arr[1]}, and {arr[2]} are typing...</span>;
                      return <span>Several people are typing...</span>;
                    })()}
                  </div>
                  <div className="p-1.5 border-t border-slate-200/70 dark:border-slate-700/70">
                    <form onSubmit={e => {
                      e.preventDefault();
                      const text = chatInput.trim();
                      if (!text) return;
                      const mid = `${id}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
                      const msg: ChatMessage = { type: "chat", id, name, text, ts: Date.now(), mid };
                      chatSeenRef.current.add(mid);
                      sendCritical(msg);
                      const item: ChatLogItem = { kind: "msg", text, name, id, ts: msg.ts };
                      addChatItem(item);
                      setChatInput("");
                      sendCritical({ type: "typing", id, name, typing: false });
                      requestAnimationFrame(() => scrollChatToBottom("smooth"));
                    }} className="flex gap-1.5 items-center">
                      <input ref={chatInputRef2} id="chatInput" value={chatInput} onChange={e => { setChatInput(e.target.value); notifyTyping(); }} onBlur={() => { if (typingStopTimerRef.current) { clearTimeout(typingStopTimerRef.current); typingStopTimerRef.current = null; } sendCritical({ type: "typing", id, name, typing: false }); }} placeholder="Type a message…" className="flex-1 px-2 py-1.5 rounded text-[12px] outline-none border" data-theme-control="field" />
                      <button type="submit" className="px-2.5 py-1.5 rounded text-[12px] font-medium transition-colors" data-theme-variant="primary">Send</button>
                    </form>
                  </div>
                </div>
              </div>
            </div>
          )}
          { }
          <div className="w-72 max-w-[85vw] relative">
            <div className="bg-white/80 dark:bg-slate-900/85 backdrop-blur rounded-md text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 shadow-lg flex items-center justify-between px-2.5 py-1.5" data-ui-panel>
              <div className="flex items-center gap-2">
                { }
                {(() => { const r = getRoster(); return (
                  <div className="relative leading-none" onMouseEnter={() => setRosterHover(true)} onMouseLeave={() => setRosterHover(false)}>
                    <span className="text-[11px] text-slate-600 dark:text-slate-300 align-middle">({r.count})</span>
                    {rosterHover && (
                      <div className="absolute left-0 bottom-[120%] z-50 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 text-[12px] rounded-md shadow-lg border border-slate-200 dark:border-slate-700 p-2 min-w-[200px] whitespace-nowrap pointer-events-auto">
                        <div className="mb-1 text-slate-500 dark:text-slate-300">Participants</div>
                        {r.active.length === 0 && r.passive.length === 0 && (
                          <div className="text-slate-400 dark:text-slate-500">No one else is here</div>
                        )}
                        {r.active.map(p => (
                          <div key={`a-${p.id}`} className="flex items-center gap-1">
                            <span>{p.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ); })()}
                <span className="text-xs font-semibold tracking-wide leading-none align-middle">Chat</span>
                {!chatOpen && unreadCount > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[11px] leading-[18px] text-center">{unreadCount}</span>
                )}
              </div>
              <button type="button" onClick={() => setChatOpen(o => !o)} className="text-[11px] font-medium px-1 py-0.5 rounded transition-colors" data-theme-variant="neutral">
                {chatOpen ? "Close" : "Open"}
              </button>
            </div>
          </div>
        </div>
      )}
      {(imageUploading || mediaProcessing || previewPreparing) && (
  <div className="absolute inset-0 z-[110] flex items-center justify-center" style={{ background: 'var(--overlay-scrim)' }}>
          <div className="bg-black/75 text-white rounded-lg shadow-xl p-5 w-[min(90vw,420px)]" data-ui-panel>
            <div className="flex items-center gap-3">
              <div className="w-6 h-6 border-4 border-white/25 border-t-white rounded-full animate-spin" />
              <div>
                <div className="text-base font-semibold">Preparing media</div>
                <div className="text-sm opacity-85">
                  {mediaPhase === 'analyze' && 'Analyzing file…'}
                  {mediaPhase === 'lookup' && 'Checking server storage…'}
                  {mediaPhase === 'upload' && 'Uploading…'}
                  {mediaPhase === 'process' && 'Processing…'}
                  {mediaPhase === 'preview' && 'Preparing preview…'}
                  {!mediaPhase && (imageUploading ? 'Uploading…' : mediaProcessing ? 'Processing…' : 'Preparing preview…')}
                </div>
              </div>
            </div>
            <div className="mt-3">
              <div className="h-2 w-full bg-white/15 rounded overflow-hidden">
                {imageUploadProgress == null ? (
                  <div className="h-2 w-2/5 rounded animate-pulse" style={{ backgroundColor: themePalette.progressFill, opacity: 0.8 }} />
                ) : (
                  <div className="h-2 rounded" style={{ backgroundColor: themePalette.progressFill, width: `${Math.max(2, Math.min(100, Math.round(imageUploadProgress * 100)))}%`, transition: 'width 0.2s ease' }} />
                )}
              </div>
              <div className="text-[12px] opacity-80 mt-1">
                {(() => {
                  if (imageUploading) {
                    if (imageUploadProgress != null) return `Uploading… ${Math.round(imageUploadProgress * 100)}%`;
                    return 'Uploading…';
                  }
                  if (mediaProcessing) return 'Processing…';
                  if (previewPreparing) return 'Preparing preview…';
                  return '';
                })()}
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-white text-sm"
                  onClick={() => {
                    try { if (currentUploadTokenRef.current) { currentUploadTokenRef.current.aborted = true; } } catch {}
                    try { currentUploadXhrRef.current?.abort(); } catch {}
                    setImageUploading(false);
                    setImageUploadProgress(null);
                    setMediaProcessing(false);
                    setPreviewPreparing(false);
                    setMediaPhase(null);
                    pendingImageRef.current = null;
                    imagePreviewRef.current = null;
                    currentUploadXhrRef.current = null;
                    currentUploadTokenRef.current = null;
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      { }
      {showShortcuts && (
        <div
          className="absolute inset-0 z-[90] flex items-center justify-center"
          style={{ background: "var(--overlay-scrim)" }}
          onClick={() => setShowShortcuts(false)}
        >
          <div
            className="bg-white text-black rounded-lg shadow-xl max-w-xl w-[90%] p-5 relative"
            data-ui-panel
            onClick={e => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowShortcuts(false)}
              className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/10 hover:bg-black/20 flex items-center justify-center"
              aria-label="Close"
            >
              ✕
            </button>
            <h3 className="text-lg font-semibold mb-3">Keyboard shortcuts</h3>
            <ul className="text-sm space-y-1">
              <li><b>Ctrl + Z</b> — Undo</li>
              <li><b>Ctrl + Shift + Z</b> or <b>Ctrl + Y</b> — Redo</li>
              <li><b>Delete</b> — Delete the selected item</li>
              <li><b>Ctrl + C</b> — Copy in Select mode</li>
              <li><b>Ctrl + V</b> — Paste in Select mode</li>
              <li><b>Esc</b> — Cancel editing or preview</li>
              <li><b>Enter</b> — Insert a line break in text</li>
              <li><b>Shift</b> — Preserve aspect ratio while resizing media</li>
              <li><b>Mouse wheel</b> — Scale the media preview</li>
            </ul>
          </div>
        </div>
      )}
      { }
      {chromaKeyEditTarget && (() => {
        const sid = chromaKeyEditTarget;
        const im = committedImagesRef.current.get(sid);
        if (!im) return null;
        const cur = imageChromaKeyStateRef.current.get(sid) ?? { enabled: true, color: '#00ff00', tolerance: 80, feather: 20, spill: 40 };
        imageChromaKeyStateRef.current.set(sid, cur);
        const setParam = (next: Partial<ImageChromaKeyState>) => {
          const now = { ...cur, ...next } as ImageChromaKeyState;
          imageChromaKeyStateRef.current.set(sid, now);
          const base = committedImagesRef.current.get(sid);
          const upd: ImageUpdateEvent = {
            type: 'image_update', id, imageId: sid, strokeId: base?.strokeId,
            chromaKeyEnabled: now.enabled,
            chromaKeyColor: now.color, chromaKeyTolerance: now.tolerance, chromaKeyFeather: now.feather, chromaKeySpill: now.spill,
          };
          sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1);
        };
        const pickWithEyeDropper = async () => {
          try {
            if (typeof window !== 'undefined' && window.EyeDropper) {
              const ed = new window.EyeDropper();
              const res = await ed.open();
              if (res?.sRGBHex) { setParam({ color: res.sRGBHex }); setChromaPicking(false); }
            } else {
              setChromaPicking(true);
            }
          } catch {
            setChromaPicking(true);
          }
        };
        return (
          <div className="absolute inset-0 z-[120] flex items-center justify-center" style={{ background: 'var(--overlay-scrim)' }} onClick={() => { setChromaPicking(false); setChromaKeyEditTarget(null); }}>
            <div className="bg-white text-black rounded-lg shadow-2xl w-[min(95vw,960px)] max-h-[85vh] p-0 overflow-hidden" data-ui-panel onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-2 border-b">
                <div className="font-semibold">Edit chroma key</div>
                <button type="button" className="w-8 h-8 rounded bg-black/5 hover:bg-black/10" onClick={() => { setChromaPicking(false); setChromaKeyEditTarget(null); }}>✕</button>
              </div>
              <div className="flex flex-col md:flex-row">
                <div className="flex-1 bg-black/90 flex items-center justify-center p-3 min-h-[260px]">
                  {(() => { const ar = (im.naturalW && im.naturalH) ? (im.naturalW / Math.max(1e-6, im.naturalH)) : (im.aspect ?? (im.width / Math.max(1e-6, im.height))); return (
                  <div className="w-full bg-black" style={{ width: '100%', maxWidth: 680, maxHeight: '70vh', aspectRatio: `${ar}` }}>
                    <ChromaKeyCanvas
                      src={im.src}
                      kind={im.mediaKind === 'video' ? 'video' : 'image'}
                      params={{ color: cur.color, tolerance: cur.tolerance, feather: cur.feather, spill: cur.spill }}
                      clickToPick={chromaPicking}
                      onPickColor={(hex) => { setParam({ color: hex }); setChromaPicking(false); }}
                      className="w-full h-full"
                      options={{ targetMaskPixels: 120_000, maxFps: 36, minFps: 18, largeFrameSkipModulo: 2 }}
                    />
                  </div> ); })()}
                </div>
                <div className="w-full md:w-[320px] p-4 border-l space-y-3">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={!!cur.enabled} onChange={e => setParam({ enabled: e.target.checked })} />
                    <span className="text-sm">Chroma key enabled</span>
                  </div>
                  { }
                  <div className="flex items-center gap-2">
                    <label className="text-sm">Color</label>
                    <input type="color" value={cur.color} onChange={e => setParam({ color: e.target.value })} className="w-10 h-7 p-0 bg-transparent border border-black/10 rounded" />
                    {!chromaPicking ? (
                      <button type="button" className="px-2 py-1 rounded bg-black/5 hover:bg-black/10 text-sm" onClick={pickWithEyeDropper}>Eyedropper</button>
                    ) : (
                      <button type="button" className="px-2 py-1 rounded bg-yellow-200/60 hover:bg-yellow-200 text-sm" onClick={() => setChromaPicking(false)}>Cancel picking</button>
                    )}
                  </div>
                  { }
                  <div>
                    <label className="text-sm">Tolerans: {cur.tolerance}</label>
                    <input type="range" min={0} max={255} value={cur.tolerance} onChange={e => setParam({ tolerance: Number(e.target.value) })} className="w-full" />
                  </div>
                  <div>
                    <label className="text-sm">Feather: {cur.feather}</label>
                    <input type="range" min={0} max={255} value={cur.feather} onChange={e => setParam({ feather: Number(e.target.value) })} className="w-full" />
                  </div>
                  <div>
                    <label className="text-sm">Spill Azaltma: {cur.spill}%</label>
                    <input type="range" min={0} max={100} value={cur.spill} onChange={e => setParam({ spill: Number(e.target.value) })} className="w-full" />
                  </div>
                  <div className="pt-2 flex justify-end gap-2">
                    <button type="button" className="px-3 py-1.5 rounded bg-black/5 hover:bg-black/10" onClick={() => { setChromaPicking(false); setChromaKeyEditTarget(null); }}>Cancel</button>
                    <button type="button" className="px-3 py-1.5 rounded bg-black text-white hover:opacity-90" onClick={() => { setChromaPicking(false); setChromaKeyEditTarget(null); }}>Done</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      { }
  {connectionLost && !readOnly && (
  <div className="absolute inset-0 z-[100] flex items-center justify-center" style={{ background: "var(--overlay-scrim)" }}>
          <div className="flex flex-col items-center gap-4 text-white">
            { }
            <div className="w-14 h-14 border-4 border-white/20 border-t-white rounded-full animate-spin" />
            <div className="text-center">
            <div className="text-lg font-semibold">Connection lost</div>
              <div className="text-sm opacity-80">Reconnecting…</div>
            </div>
          </div>
        </div>
      )}
      {connectionLost && readOnly && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center pointer-events-none">
          <div className="rounded-xl px-6 py-4" style={{ background: "rgba(220, 38, 38, 0.9)" }}>
            <div className="flex items-center gap-3">
              { }
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="w-8 h-8 text-white animate-pulse"
                fill="currentColor"
                role="img"
              >
                <path d="M23,23H1c-0.4,0-0.7-0.2-0.9-0.5c-0.2-0.3-0.2-0.7,0-1l11-20c0.4-0.6,1.4-0.6,1.8,0l11,20c0.2,0.3,0.2,0.7,0,1 C23.7,22.8,23.4,23,23,23z M2.7,21h18.6L12,4.1L2.7,21z" />
                <path d="M12,16c-0.6,0-1-0.4-1-1v-5c0-0.6,0.4-1,1-1s1,0.4,1,1v5C13,15.6,12.6,16,12,16z" />
                <circle cx="12" cy="18" r="1" />
              </svg>
              <div className="text-white">
                <div className="font-semibold">Connection lost</div>
                <div className="text-sm opacity-90">Reconnecting…</div>
              </div>
            </div>
          </div>
        </div>
      )}
      {snapshotLoading && (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm z-40 flex items-center justify-center">
          <div className="flex items-center gap-3 text-white">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="animate-spin">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
              <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
            </svg>
            <div>
              <div className="text-lg font-semibold">Loading</div>
              <div className="text-sm opacity-90">
                {snapshotProgress ? 'Loading board history…' : mediaProgress ? 'Loading media files…' : 'Preparing…'}
              </div>
              {(snapshotProgress || mediaProgress) && (() => {
                let pct = 0;
                if (snapshotProgress && !mediaProgress) {
                  pct = (snapshotProgress.got / Math.max(1, snapshotProgress.total)) * 100 * (mediaProgress ? 0.5 : 1);
                } else if (!snapshotProgress && mediaProgress) {
                  pct = (mediaProgress.got / Math.max(1, mediaProgress.total)) * 100;
                } else if (snapshotProgress && mediaProgress) {
                  const snapPct = snapshotProgress.got / Math.max(1, snapshotProgress.total);
                  const mediaPct = mediaProgress.got / Math.max(1, mediaProgress.total);
                  pct = (snapPct * 50) + (mediaPct * 50);
                }
                pct = Math.max(0, Math.min(100, Math.floor(pct)));
                return (
                  <div className="mt-2 w-64 max-w-[70vw]">
                    <div className="h-2 w-full rounded" style={{ backgroundColor: themePalette.progressTrack }}>
                      <div className="h-2 rounded" style={{ width: `${pct}%`, backgroundColor: themePalette.progressFill }} />
                    </div>
                    <div className="text-[11px] opacity-80 mt-1 flex justify-between">
                      {snapshotProgress && <span>Snapshot: {snapshotProgress.got}/{snapshotProgress.total}</span>}
                      {mediaProgress && <span>Media: {mediaProgress.got}/{mediaProgress.total}</span>}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
      { }
      { }
      {!readOnly && unsyncShown && !connectionLost && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-[95] max-w-[92%]">
          <div className="flex items-start gap-4 bg-yellow-400/95 text-black rounded-md px-3 py-2 shadow-lg">
            <div className="flex-1 min-w-0">
              <div className="font-semibold">The board may be out of sync</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" onClick={repairResync} className="px-2 py-1 rounded bg-black/20 hover:bg-black/30 text-sm">Repair</button>
              <button type="button" onClick={() => { unsyncRef.current.shown = false; setUnsyncShown(false); }} className="px-2 py-1 rounded bg-black/10 hover:bg-black/20 text-sm">Close</button>
            </div>
          </div>
        </div>
      )}
  { }
  { }
  { }
  {!readOnly && (
    <div
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 rounded-md px-2 py-1 flex items-center gap-2"
      data-ui-panel
      onPointerDown={e => e.stopPropagation()}
    >
      <button
        type="button"
        className="px-2 py-1 rounded panel-button"
        title="Zoom in (Ctrl +)"
        onClick={() => {
          const area = areaRef.current; if (!area) return; const crect = area.getBoundingClientRect();
          const cx = crect.left + crect.width / 2; const cy = crect.top + crect.height / 2; const s = scaleRef.current * 1.1;
          const oldS = scaleRef.current; const newS = Math.max(0.25, Math.min(4, s)); const pan = panRef.current;
          const worldX = (cx - crect.left - pan.x) / Math.max(1e-6, oldS); const worldY = (cy - crect.top - pan.y) / Math.max(1e-6, oldS);
          const nx = cx - crect.left - worldX * newS; const ny = cy - crect.top - worldY * newS;
          panRef.current = { x: nx, y: ny }; scaleRef.current = newS; setViewTransform({ x: nx, y: ny, s: newS });
        }}
      >
        +
      </button>
      <button
        type="button"
        className="px-2 py-1 rounded panel-button"
        title="Zoom out (Ctrl -)"
        onClick={() => {
          const area = areaRef.current; if (!area) return; const crect = area.getBoundingClientRect();
          const cx = crect.left + crect.width / 2; const cy = crect.top + crect.height / 2; const s = scaleRef.current / 1.1;
          const oldS = scaleRef.current; const newS = Math.max(0.25, Math.min(4, s)); const pan = panRef.current;
          const worldX = (cx - crect.left - pan.x) / Math.max(1e-6, oldS); const worldY = (cy - crect.top - pan.y) / Math.max(1e-6, oldS);
          const nx = cx - crect.left - worldX * newS; const ny = cy - crect.top - worldY * newS;
          panRef.current = { x: nx, y: ny }; scaleRef.current = newS; setViewTransform({ x: nx, y: ny, s: newS });
        }}
      >
        -
      </button>
  <span className="px-2 text-sm" data-theme-strong>{Math.round((viewTransform.s || 1) * 100)}%</span>
          <button
            type="button"
    className="px-2 py-1 rounded panel-button"
            title={showGrid ? "Grid: On" : "Grid: Off"}
            onClick={() => setShowGrid(v => !v)}
          >
            Toggle grid
          </button>
      <button
        type="button"
        className="px-2 py-1 rounded panel-button"
        title="Fit to screen (Ctrl 0)"
        onClick={() => {
          const area = areaRef.current; if (!area) return; const crect = area.getBoundingClientRect(); const cw = crect.width, ch = crect.height;
          const ns = Math.min(cw / BOARD_W, ch / BOARD_H); const nx = Math.max(0, (cw - BOARD_W * ns) / 2); const ny = Math.max(0, (ch - BOARD_H * ns) / 2);
          panRef.current = { x: nx, y: ny }; scaleRef.current = ns; setViewTransform({ x: nx, y: ny, s: ns });
        }}
      >
        Fit
      </button>
      <button
        type="button"
        className="px-2 py-1 rounded panel-button"
        title="1:1 (100%)"
        onClick={() => {
          const area = areaRef.current; if (!area) return; const crect = area.getBoundingClientRect(); const cw = crect.width, ch = crect.height;
          const ns = 1; const nx = Math.max(0, (cw - BOARD_W * ns) / 2); const ny = Math.max(0, (ch - BOARD_H * ns) / 2);
          panRef.current = { x: nx, y: ny }; scaleRef.current = ns; setViewTransform({ x: nx, y: ny, s: ns });
        }}
      >
        1:1
      </button>
      <button
        type="button"
        className="px-2 py-1 rounded panel-button"
        title="Center (1920×1080)"
        onClick={() => {
          const area = areaRef.current; if (!area) return; const crect = area.getBoundingClientRect(); const cw = crect.width, ch = crect.height;
          const s = viewTransform.s || 1; const nx = Math.max(0, (cw - BOARD_W * s) / 2); const ny = Math.max(0, (ch - BOARD_H * s) / 2);
          panRef.current = { x: nx, y: ny }; setViewTransform(v => ({ ...v, x: nx, y: ny }));
        }}
      >
        Center
      </button>
    </div>
  )}
  { }
  <div
    className="absolute inset-0 select-none"
    ref={areaRef}
    style={{ background: readOnly ? undefined : "var(--area-bg)", transition: "background-color 0.4s ease" }}
  >
        <div
          ref={stageRef}
          className="relative"
          style={{
            width: 1920,
            height: 1080,
            transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.s})`,
            transformOrigin: "0 0",
            overflow: readOnly ? "hidden" : "visible",
            boxShadow: themePalette.boardShadow,
            borderRadius: 18,
            transition: "box-shadow 0.4s ease"
          }}
          onPointerDown={e => {
            if (tool === "select") {
              const target = e.target as HTMLElement;
              const isCommittedText = target?.id?.startsWith?.("committed-") ?? false;
              const isImageEntity = target?.hasAttribute?.("data-image-entity") || target?.closest?.("[data-image-entity]");
              const withinCanvas = target === boardRef.current;
              if (withinCanvas || (!isCommittedText && !isImageEntity)) {
                setSelectedTextId(null);
                setSelectedImageId(null);
                setSelectedTextIds([]);
                setSelectedImageIds([]);
              }
            }
          }}
        >
          <canvas
            ref={boardRef}
            className={`touch-none ${readOnly ? "cursor-default" : "cursor-none"}`}
            style={{
              width: 1920,
              height: 1080,
              backgroundColor: readOnly ? "transparent" : themePalette.boardBackground,
              backgroundImage: readOnly ? "none" : (showGrid
                ? [
                    `repeating-linear-gradient(0deg, ${themePalette.boardGridMinor} 0, ${themePalette.boardGridMinor} 1px, transparent 1px, transparent 40px)`,
                    `repeating-linear-gradient(90deg, ${themePalette.boardGridMinor} 0, ${themePalette.boardGridMinor} 1px, transparent 1px, transparent 40px)`,
                    `repeating-linear-gradient(0deg, ${themePalette.boardGridMajor} 0, ${themePalette.boardGridMajor} 1px, transparent 1px, transparent 200px)`,
                    `repeating-linear-gradient(90deg, ${themePalette.boardGridMajor} 0, ${themePalette.boardGridMajor} 1px, transparent 1px, transparent 200px)`
                  ].join(",")
                : undefined as unknown as string),
              transition: "background-color 0.4s ease",
              borderRadius: 18
            }}
          />
          { }
          { }
          {(() => {
            const allItems = [
              ...Array.from(committedTextsRef.current.values()).map(v => ({ ...v, type: 'text' as const })),
              ...Array.from(committedImagesRef.current.values()).map(v => ({ ...v, type: 'image' as const }))
            ].sort((a, b) => {
              const az = a.zIndex ?? (a.type === 'text' ? 20 : 14);
              const bz = b.zIndex ?? (b.type === 'text' ? 20 : 14);
              return az - bz;
            });

            return allItems.map(item => {
              if (item.type === 'text') {
                const tb = item;
                const isSelSingle = selectedTextId === tb.textId && tool === "select";
                const isSelMulti = tool === "select" && selectedTextIds.includes(tb.textId);
                const isSel = isSelSingle || isSelMulti;
                const allowInteract = tool === "select";
                const outlineCfg = tb.outline;
                const outlineStyles: CSSProperties = {};
                if (outlineCfg?.enabled) {
                  const outlineColor = outlineCfg.chroma?.enabled ? chromaColor(outlineCfg.chroma) : outlineCfg.color;
                  const sizeForScale = tb.size || OUTLINE_BASE_FONT_PX;
                  const effectiveStroke = effectiveOutlineValue(outlineCfg.width, sizeForScale);
                  const effectiveFeather = effectiveOutlineValue(outlineCfg.feather, sizeForScale);
                  if (effectiveStroke > 0) {
                    outlineStyles.WebkitTextStroke = `${effectiveStroke}px ${outlineColor}`;
                  }
                  if (effectiveFeather > 0) {
                    outlineStyles.textShadow = `0 0 ${effectiveFeather}px ${outlineColor}`;
                  } else if (effectiveStroke > 0) {
                    outlineStyles.textShadow = `0 0 0 ${outlineColor}`;
                  }
                }
                return (
                  <div
                    key={tb.textId}
                    id={`committed-${tb.textId}`}
                    data-committed-text
                    onContextMenu={e => {
                      e.preventDefault();
                      if (!readOnly) setContextMenu({ x: e.clientX, y: e.clientY, type: "text", id: tb.textId });
                    }}
                    onPointerDown={e => {
                      if (!allowInteract) return;
                      e.stopPropagation();
                      const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
                      setSelectedImageId(null);
                      setSelectedImageIds([]);
                      setSelectedTextId(tb.textId);
                      setSelectedTextIds([tb.textId]);
                      setTextColor(tb.color);
                      setTextSize(tb.size);
                      setTextFont(withFontFallback(tb.font));
                      const outlineForSelection = tb.outline
                        ? cloneTextOutline(tb.outline, textOutline)
                        : (() => {
                            const base = cloneTextOutline(textOutline);
                            if (base.chroma) base.chroma = { ...base.chroma, enabled: false };
                            return { ...base, enabled: false };
                          })();
                      setTextOutline(outlineForSelection);
                      dragStateRef.current = { entity: "text", kind: "move", id: tb.textId, startX: nx, startY: ny, origin: { x: tb.x, y: tb.y, width: tb.width, height: tb.height } };
                      const st = dvdTextStateRef.current.get(tb.textId);
                      if (st) st.pausedByDrag = true;
                      const ctrl: AnimControlPayload = { type: "anim_control", id, entity: "text", targetId: tb.textId, dvdPaused: true };
                      sendCritical(ctrl);
                    }}
                    onDoubleClick={() => {
                      const cur = committedTextsRef.current.get(tb.textId);
                      if (!cur) return;
                      setTool("text");
                      const outlineClone = cloneTextOutline(cur.outline, textOutline);
                      curTextRef2.current = { textId: cur.textId, strokeId: cur.strokeId, x: cur.x, y: cur.y, size: cur.size, color: cur.color, font: cur.font, outline: outlineClone, lastSent: 0, committed: true };
                      setTextInputValue(cur.text);
                      setSelectedTextId(cur.textId);
                      setSelectedImageId(null);
                      setTextColor(cur.color);
                      setTextSize(cur.size);
                      setTextFont(withFontFallback(cur.font));
                      setTextOutline(outlineClone);
                      const screen = boardNormToScreen(cur.x, cur.y);
                      const container = containerRef.current;
                      if (container) {
                        const rect = container.getBoundingClientRect();
                        const px = screen.x - rect.left;
                        const py = screen.y - rect.top;
                        const clientW = rect.width;
                        let left = px;
                        if (left + textInputUi.current.width > clientW - 10) left = Math.max(60, clientW - textInputUi.current.width - 10);
                        textInputUi.current.left = left;
                        textInputUi.current.top = Math.max(0, py - cur.size - 8);
                      }
                      setTextInputActive(true);
                      requestAnimationFrame(() => textInputRef.current?.focus());
                    }}
                    style={{
                      position: "absolute",
                      left: `${tb.x * 100}%`,
                      top: `${tb.y * 100}%`,
                      pointerEvents: allowInteract ? "auto" : "none",
                      width: tb.width ? `${tb.width * BOARD_W}px` : undefined,
                      height: tb.height ? `${tb.height * BOARD_H}px` : undefined,
                      color: tb.chroma?.enabled ? chromaColor(tb.chroma) : tb.color,
                      fontSize: tb.size,
                      fontFamily: withFontFallback(tb.font),
                      lineHeight: 1.2,
                      display: "inline-block",
                      cursor: allowInteract ? "move" : "default",
                      whiteSpace: "pre-wrap",
                      background: "transparent",
                      padding: 4,
                      outline: isSel ? "3px solid #3b82f6" : "none",
                      outlineOffset: "2px",
                      boxShadow: isSel ? "0 0 12px rgba(59,130,246,0.8)" : undefined,
                      userSelect: "none",
                      zIndex: tb.zIndex ?? 20,
                      transformStyle: "preserve-3d",
                      transform: `perspective(1000px) rotateX(${tb.rotX ?? 0}deg) rotateY(${tb.rotY ?? 0}deg) rotateZ(${tb.rotZ ?? 0}deg)`,
                      ...outlineStyles,
                    }}
                  >
                    {tb.text}
                    {isSel && (
                      <div
                        onPointerDown={e => {
                          e.stopPropagation();
                          if (!allowInteract) return;
                          const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
                          dragStateRef.current = { entity: "text", kind: "resize", id: tb.textId, startX: nx, startY: ny, origin: { x: tb.x, y: tb.y, width: tb.width, height: tb.height } };
                        }}
                        style={{ position: "absolute", right: -8, bottom: -8, width: 14, height: 14, background: "#3b82f6", border: "2px solid #fff", borderRadius: "50%", cursor: "nwse-resize", zIndex: 30 }}
                      />
                    )}
                  </div>
                );
                } else {
                const im = item as CommittedImage;
                const isSelSingle = selectedImageId === im.imageId && tool === "select";
                const isSelMulti = tool === "select" && selectedImageIds.includes(im.imageId);
                const isSel = isSelSingle || isSelMulti;
                const allowInteract = !readOnly && tool === "select";
                const sanitizedSrc = normalizeMediaSrc(im.src);
                if (!sanitizedSrc) {
                  brokenImageIdsRef.current.add(im.imageId);
                  return null;
                }
                return (
                  <div
                    key={im.imageId}
                    data-image-entity
                    data-image-id={im.imageId}
                    onContextMenu={e => {
                      e.preventDefault();
                      if (!readOnly) setContextMenu({ x: e.clientX, y: e.clientY, type: "image", id: im.imageId });
                    }}
                    style={{
                      position: "absolute",
                      left: `${im.x * 100}%`,
                      top: `${im.y * 100}%`,
                      width: `${im.width * BOARD_W}px`,
                      height: `${im.height * BOARD_H}px`,
                      pointerEvents: allowInteract ? "auto" : "none",
                      cursor: allowInteract ? "move" : "default",
                      outline: isSel ? "3px solid #3b82f6" : "none",
                      outlineOffset: "2px",
                      boxShadow: isSel ? "0 0 12px rgba(59,130,246,0.8)" : undefined,
                      userSelect: "none",
                      zIndex: im.zIndex ?? 14,
                      transformStyle: "preserve-3d",
                      transform: `perspective(1000px) rotateX(${im.rotX ?? 0}deg) rotateY(${im.rotY ?? 0}deg) rotateZ(${im.rotZ ?? 0}deg)`,
                    }}
                    onPointerDown={e => {
                      if (!allowInteract) return;
                      e.stopPropagation();
                      const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
                      setSelectedImageId(im.imageId);
                      setSelectedTextId(null);
                      setSelectedImageIds([im.imageId]);
                      setSelectedTextIds([]);
                      const stored = committedImagesRef.current.get(im.imageId);
                      const asp = stored?.aspect ?? (im.width / Math.max(1e-6, im.height));
                      dragStateRef.current = { entity: "image", kind: "move", id: im.imageId, startX: nx, startY: ny, shift: e.shiftKey, origin: { x: im.x, y: im.y, width: im.width, height: im.height, aspect: asp } };
                      ensureImageNaturalInfo(im.imageId);
                      const __st = dvdImageStateRef.current.get(im.imageId);
                      if (__st) __st.pausedByDrag = true;
                      const ctrl: AnimControlPayload = { type: "anim_control", id, entity: "image", targetId: im.imageId, dvdPaused: true };
                      sendCritical(ctrl);
                    }}
                  >
                    { }
                    {(() => {
                      const cur = committedImagesRef.current.get(im.imageId);
                      const notReady = im.mediaKind === 'video' ? false : !(cur?.naturalW && cur?.naturalH);
                      const broken = brokenImageIdsRef.current.has(im.imageId);
                      if (!notReady && !broken) return null;
                      return (
                        <div style={{ position: 'absolute', inset: 0, border: '2px dashed rgba(255,255,255,0.4)', background: broken ? 'rgba(220,38,38,0.2)' : 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 22, height: 22, border: '3px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                            <div style={{ fontSize: 12, opacity: 0.9 }}>{broken ? 'Media failed to load' : 'Loading…'}</div>
                          </div>
                        </div>
                      );
                    })()}
                    {(() => { const ck = imageChromaKeyStateRef.current.get(im.imageId); return ck?.enabled; })() ? (
                      <ChromaKeyCanvas
                        src={sanitizedSrc}
                        kind={im.mediaKind === 'video' ? 'video' : 'image'}
                        params={(() => { const cur = imageChromaKeyStateRef.current.get(im.imageId) ?? { enabled: false, color: '#00ff00', tolerance: 80, feather: 20, spill: 40 }; return { color: cur.color, tolerance: cur.tolerance, feather: cur.feather, spill: cur.spill }; })()}
                        filter={(im.filter ?? 'none') === 'rainbow'
                          ? { type: 'rainbow', speed: (imageChromaStateRef.current.get(im.imageId)?.speed ?? 120), saturation: (imageChromaStateRef.current.get(im.imageId)?.saturation ?? 180), lightness: (imageChromaStateRef.current.get(im.imageId)?.lightness ?? 100) }
                          : { type: 'css', value: (IMAGE_FILTERS[im.filter ?? 'none'] ?? 'none') }}
                        style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
                        options={{ targetMaskPixels: 120_000, maxFps: 36, minFps: 18, largeFrameSkipModulo: 2, showPreviewBadge: true }}
                      />
                    ) : im.mediaKind === 'video' ? (
                      <video
                        src={sanitizedSrc}
                        muted
                        playsInline
                        controls={false}
                        autoPlay
                        loop
                        preload="auto"
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "fill",
                          display: "block",
                          pointerEvents: "none",
                          filter: (im.filter ?? "none") === "rainbow"
                            ? (() => {
                                const st = imageChromaStateRef.current.get(im.imageId) ?? { speed: 120, saturation: 180, lightness: 100 };
                                const elapsed = (Date.now() % 100000) / 1000;
                                const hue = ((elapsed * (st.speed || 120)) % 360 + 360) % 360;
                                const sat = Math.max(0, st.saturation ?? 180);
                                const br = Math.max(0, st.lightness ?? 100);
                                return `hue-rotate(${hue}deg) saturate(${sat}%) brightness(${br}%)`;
                              })()
                            : (IMAGE_FILTERS[im.filter ?? "none"] ?? "none"),
                        }}
                        onLoadedMetadata={() => { try { ensureImageNaturalInfo(im.imageId); } catch {} }}
                        onError={(e) => {
                          try {
                            const key = `${im.imageId}|${sanitizedSrc}`;
                            if (!retriedMediaRef.current.has(key)) {
                              retriedMediaRef.current.add(key);
                              const el = e.currentTarget as HTMLVideoElement;
                              const bust = sanitizedSrc.includes("?") ? `${sanitizedSrc}&r=${Date.now()}` : `${sanitizedSrc}?r=${Date.now()}`;
                              el.src = bust;
                              return;
                            }
                            brokenImageIdsRef.current.add(im.imageId);
                            forceTick(t => t + 1);
                          } catch {}
                        }}
                      />
                    ) : (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={sanitizedSrc}
                        alt=""
                        draggable={false}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "fill",
                          display: "block",
                          pointerEvents: "none",
                          filter: (im.filter ?? "none") === "rainbow"
                            ? (() => {
                                const st = imageChromaStateRef.current.get(im.imageId) ?? { speed: 120, saturation: 180, lightness: 100 };
                                const elapsed = (Date.now() % 100000) / 1000;
                                const hue = ((elapsed * (st.speed || 120)) % 360 + 360) % 360;
                                const sat = Math.max(0, st.saturation ?? 180);
                                const br = Math.max(0, st.lightness ?? 100);
                                return `hue-rotate(${hue}deg) saturate(${sat}%) brightness(${br}%)`;
                              })()
                            : (IMAGE_FILTERS[im.filter ?? "none"] ?? "none"),
                        }}
                        onLoad={() => { try { ensureImageNaturalInfo(im.imageId); } catch {} }}
                        onError={(e) => {
                          try {
                            const key = `${im.imageId}|${sanitizedSrc}`;
                            if (!retriedMediaRef.current.has(key)) {
                              retriedMediaRef.current.add(key);
                              const el = e.currentTarget as HTMLImageElement;
                              const bust = sanitizedSrc.includes("?") ? `${sanitizedSrc}&r=${Date.now()}` : `${sanitizedSrc}?r=${Date.now()}`;
                              el.src = bust;
                              return;
                            }
                            brokenImageIdsRef.current.add(im.imageId);
                            forceTick(t => t + 1);
                          } catch {}
                        }}
                      />
                    )}
                    { }
                    {isSel && !readOnly && (
                      <>
                        {[
                          { key: "tl", style: { left: -6, top: -6, cursor: "nwse-resize" } },
                          { key: "tr", style: { right: -6, top: -6, cursor: "nesw-resize" } },
                          { key: "bl", style: { left: -6, bottom: -6, cursor: "nesw-resize" } },
                          { key: "br", style: { right: -6, bottom: -6, cursor: "nwse-resize" } },
                          { key: "l", style: { left: -6, top: "50%", transform: "translateY(-50%)", cursor: "ew-resize" } },
                          { key: "r", style: { right: -6, top: "50%", transform: "translateY(-50%)", cursor: "ew-resize" } },
                          { key: "t", style: { top: -6, left: "50%", transform: "translateX(-50%)", cursor: "ns-resize" } },
                          { key: "b", style: { bottom: -6, left: "50%", transform: "translateX(-50%)", cursor: "ns-resize" } },
                        ].map(h => (
                          <div
                            key={h.key}
                            onPointerDown={e => {
                              e.stopPropagation();
                              if (!allowInteract) return;
                              const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
                              const stored = committedImagesRef.current.get(im.imageId);
                              const asp = stored?.aspect ?? (im.width / Math.max(1e-6, im.height));
                              const handleKey = h.key as ImageHandleKey;
                              const mapping = computeHandleAnchorMapping(stored?.rotZ ?? im.rotZ ?? 0);
                              const resolvedAnchor = mapping[handleKey] ?? handleKey;
                              dragStateRef.current = {
                                entity: "image",
                                kind: "resize",
                                id: im.imageId,
                                startX: nx,
                                startY: ny,
                                shift: e.shiftKey,
                                anchor: resolvedAnchor,
                                handle: handleKey,
                                origin: { x: im.x, y: im.y, width: im.width, height: im.height, aspect: asp }
                              };
                            }}
                            style={{ position: "absolute", width: `${12 / Math.max(0.25, Math.min(4, viewTransform.s || 1))}px`, height: `${12 / Math.max(0.25, Math.min(4, viewTransform.s || 1))}px`, background: "#3b82f6", borderRadius: 2, pointerEvents: "auto", zIndex: 27, ...(h.style as React.CSSProperties) }}
                          />
                        ))}
                      </>
                    )}
                  </div>
                );
              }
            });
          })()}

          {/* IMAGES_PLACEHOLDER */}
          {tool === "media" && pendingImageRef.current && imagePreviewRef.current && (() => {
            const { x, y, scale } = imagePreviewRef.current!;
            const pending = pendingImageRef.current!;
            const pendingSrc = normalizeMediaSrc(pending.src);
            if (!pendingSrc) {
              return null;
            }
            let w = (pending.naturalW * scale) / BOARD_W;
            let h = (pending.naturalH * scale) / BOARD_H;
            if (w > 1 || h > 1) {
              const s = Math.min(1 / w, 1 / h);
              w *= s; h *= s;
            }
            return (
              <div
                style={{ position: "absolute", left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * BOARD_W}px`, height: `${h * BOARD_H}px`, transform: "translate(0, 0)", opacity: 0.2, zIndex: 23, pointerEvents: 'none' }}
              >
                {pending.kind === 'video' ? (
                  <video src={pendingSrc} muted playsInline controls={false} autoPlay loop preload="auto" style={{ width: "100%", height: "100%", objectFit: "fill", display: "block", pointerEvents: 'none' }} />
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={pendingSrc} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "fill", display: "block" }} />
                )}
              </div>
            );
          })()}
          {[...committedImagesRef.current.values()].sort((a, b) => (a.zIndex || 14) - (b.zIndex || 14)).map(im => {
            const isSelSingle = selectedImageId === im.imageId && tool === "select";
            const isSelMulti = tool === "select" && selectedImageIds.includes(im.imageId);
            const isSel = isSelSingle || isSelMulti;
    const allowInteract = !readOnly && tool === "select";
            const sanitizedSrc = normalizeMediaSrc(im.src);
            if (!sanitizedSrc) {
              brokenImageIdsRef.current.add(im.imageId);
              return null;
            }
            return (
              <div
                key={im.imageId}
                data-image-entity
                data-image-id={im.imageId}
                onContextMenu={e => {
                  e.preventDefault();
                  if (!readOnly) setContextMenu({ x: e.clientX, y: e.clientY, type: "image", id: im.imageId });
                }}
                style={{
                  position: "absolute",
                  left: `${im.x * 100}%`,
                  top: `${im.y * 100}%`,
                  width: `${im.width * BOARD_W}px`,
                  height: `${im.height * BOARD_H}px`,
                  pointerEvents: allowInteract ? "auto" : "none",
                  cursor: allowInteract ? "move" : "default",
                  border: isSel ? "1px solid #3b82f6" : "none",
                  boxShadow: isSel ? "0 0 0 2px rgba(59,130,246,0.3)" : undefined,
                  userSelect: "none",
                  zIndex: im.zIndex ?? 14,
                  transformStyle: "preserve-3d",
                  transform: `perspective(1000px) rotateX(${im.rotX ?? 0}deg) rotateY(${im.rotY ?? 0}deg) rotateZ(${im.rotZ ?? 0}deg)`,
                }}
                onPointerDown={e => {
                  if (!allowInteract) return;
                  const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
                  setSelectedImageId(im.imageId);
                  setSelectedTextId(null);
                  setSelectedImageIds([im.imageId]);
                  setSelectedTextIds([]);
                  const stored = committedImagesRef.current.get(im.imageId);
                  const asp = stored?.aspect ?? (im.width / Math.max(1e-6, im.height));
                  dragStateRef.current = { entity: "image", kind: "move", id: im.imageId, startX: nx, startY: ny, shift: e.shiftKey, origin: { x: im.x, y: im.y, width: im.width, height: im.height, aspect: asp } };
                  ensureImageNaturalInfo(im.imageId);
                  const __st = dvdImageStateRef.current.get(im.imageId);
                  if (__st) __st.pausedByDrag = true;
                  const ctrl: AnimControlPayload = { type: "anim_control", id, entity: "image", targetId: im.imageId, dvdPaused: true };
                  sendCritical(ctrl);
                }}
              >
                { }
                {(() => {
                  const cur = committedImagesRef.current.get(im.imageId);
                  const notReady = im.mediaKind === 'video' ? false : !(cur?.naturalW && cur?.naturalH);
                  const broken = brokenImageIdsRef.current.has(im.imageId);
                  if (!notReady && !broken) return null;
                  return (
                    <div style={{ position: 'absolute', inset: 0, border: '2px dashed rgba(255,255,255,0.4)', background: broken ? 'rgba(220,38,38,0.2)' : 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 22, height: 22, border: '3px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                        <div style={{ fontSize: 12, opacity: 0.9 }}>{broken ? 'Media failed to load' : 'Loading…'}</div>
                      </div>
                    </div>
                  );
                })()}
  {(() => { const ck = imageChromaKeyStateRef.current.get(im.imageId); return ck?.enabled; })() ? (
                  <ChromaKeyCanvas
                    src={sanitizedSrc}
                    kind={im.mediaKind === 'video' ? 'video' : 'image'}
                    params={(() => { const cur = imageChromaKeyStateRef.current.get(im.imageId) ?? { enabled: false, color: '#00ff00', tolerance: 80, feather: 20, spill: 40 }; return { color: cur.color, tolerance: cur.tolerance, feather: cur.feather, spill: cur.spill }; })()}
        filter={(im.filter ?? 'none') === 'rainbow'
          ? { type: 'rainbow', speed: (imageChromaStateRef.current.get(im.imageId)?.speed ?? 120), saturation: (imageChromaStateRef.current.get(im.imageId)?.saturation ?? 180), lightness: (imageChromaStateRef.current.get(im.imageId)?.lightness ?? 100) }
          : { type: 'css', value: (IMAGE_FILTERS[im.filter ?? 'none'] ?? 'none') }}
        style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
        options={{ targetMaskPixels: 120_000, maxFps: 36, minFps: 18, largeFrameSkipModulo: 2, showPreviewBadge: true }}
                  />
                ) : im.mediaKind === 'video' ? (
                  <video
                    src={sanitizedSrc}
          muted
          playsInline
          controls={false}
          autoPlay
          loop
          preload="auto"
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "fill",
                      display: "block",
                      pointerEvents: "none",
                      filter: (im.filter ?? "none") === "rainbow"
                        ? (() => {
                            const st = imageChromaStateRef.current.get(im.imageId) ?? { speed: 120, saturation: 180, lightness: 100 };
                            const elapsed = (Date.now() % 100000) / 1000;
                            const hue = ((elapsed * (st.speed || 120)) % 360 + 360) % 360;
                            const sat = Math.max(0, st.saturation ?? 180);
                            const br = Math.max(0, st.lightness ?? 100);
                            return `hue-rotate(${hue}deg) saturate(${sat}%) brightness(${br}%)`;
                          })()
                        : (IMAGE_FILTERS[im.filter ?? "none"] ?? "none"),
                    }}
                    onLoadedMetadata={() => { try { ensureImageNaturalInfo(im.imageId); } catch {} }}
                    onError={(e) => {
                      try {
                        const key = `${im.imageId}|${sanitizedSrc}`;
                        if (!retriedMediaRef.current.has(key)) {
                          retriedMediaRef.current.add(key);
                          const el = e.currentTarget as HTMLVideoElement;
                          const bust = sanitizedSrc.includes("?") ? `${sanitizedSrc}&r=${Date.now()}` : `${sanitizedSrc}?r=${Date.now()}`;
                          el.src = bust;
                          return;
                        }
                        brokenImageIdsRef.current.add(im.imageId);
                        forceTick(t => t + 1);
                      } catch {}
                    }}
                  />
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={sanitizedSrc}
                    alt=""
                    draggable={false}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "fill",
                      display: "block",
                      pointerEvents: "none",
                      filter: (im.filter ?? "none") === "rainbow"
                        ? (() => {
                            const st = imageChromaStateRef.current.get(im.imageId) ?? { speed: 120, saturation: 180, lightness: 100 };
                            const elapsed = (Date.now() % 100000) / 1000;
                            const hue = ((elapsed * (st.speed || 120)) % 360 + 360) % 360;
                            const sat = Math.max(0, st.saturation ?? 180);
                            const br = Math.max(0, st.lightness ?? 100);
                            return `hue-rotate(${hue}deg) saturate(${sat}%) brightness(${br}%)`;
                          })()
                        : (IMAGE_FILTERS[im.filter ?? "none"] ?? "none"),
                    }}
                    onLoad={() => { try { ensureImageNaturalInfo(im.imageId); } catch {} }}
                    onError={(e) => {
                      try {
                        const key = `${im.imageId}|${sanitizedSrc}`;
                        if (!retriedMediaRef.current.has(key)) {
                          retriedMediaRef.current.add(key);
                          const el = e.currentTarget as HTMLImageElement;
                          const bust = sanitizedSrc.includes("?") ? `${sanitizedSrc}&r=${Date.now()}` : `${sanitizedSrc}?r=${Date.now()}`;
                          el.src = bust;
                          return;
                        }
                        brokenImageIdsRef.current.add(im.imageId);
                        forceTick(t => t + 1);
                      } catch {}
                    }}
                  />
                )}
                { }
    {isSel && !readOnly && (
                  <>
  {[
                      { key: "tl", style: { left: -6, top: -6, cursor: "nwse-resize" } },
                      { key: "tr", style: { right: -6, top: -6, cursor: "nesw-resize" } },
                      { key: "bl", style: { left: -6, bottom: -6, cursor: "nesw-resize" } },
                      { key: "br", style: { right: -6, bottom: -6, cursor: "nwse-resize" } },
                      { key: "l", style: { left: -6, top: "50%", transform: "translateY(-50%)", cursor: "ew-resize" } },
                      { key: "r", style: { right: -6, top: "50%", transform: "translateY(-50%)", cursor: "ew-resize" } },
                      { key: "t", style: { top: -6, left: "50%", transform: "translateX(-50%)", cursor: "ns-resize" } },
                      { key: "b", style: { bottom: -6, left: "50%", transform: "translateX(-50%)", cursor: "ns-resize" } },
        ].map(h => (
                      <div
                        key={h.key}
                        onPointerDown={e => {
                          e.stopPropagation();
                          if (!allowInteract) return;
                          const { x: nx, y: ny } = screenToBoardNorm(e.clientX, e.clientY);
                          const stored = committedImagesRef.current.get(im.imageId);
                          const asp = stored?.aspect ?? (im.width / Math.max(1e-6, im.height));
                          const handleKey = h.key as ImageHandleKey;
                          const mapping = computeHandleAnchorMapping(stored?.rotZ ?? im.rotZ ?? 0);
                          const resolvedAnchor = mapping[handleKey] ?? handleKey;
                          dragStateRef.current = {
                            entity: "image",
                            kind: "resize",
                            id: im.imageId,
                            startX: nx,
                            startY: ny,
                            shift: e.shiftKey,
                            anchor: resolvedAnchor,
                            handle: handleKey,
                            origin: { x: im.x, y: im.y, width: im.width, height: im.height, aspect: asp }
                          };
                        }}
      style={{ position: "absolute", width: `${12 / Math.max(0.25, Math.min(4, viewTransform.s || 1))}px`, height: `${12 / Math.max(0.25, Math.min(4, viewTransform.s || 1))}px`, background: "#3b82f6", borderRadius: 2, pointerEvents: "auto", ...(h.style as React.CSSProperties) }}
                      />
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
  { }
  <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-[9999]" />
  { }
  {tool === "select" && marqueeRef.current && (
    (() => {
      const m = marqueeRef.current!;
      const s = viewTransform.s || 1;
      const x1 = m.start.x * BOARD_W * s + viewTransform.x;
      const y1 = m.start.y * BOARD_H * s + viewTransform.y;
      const x2 = m.end.x * BOARD_W * s + viewTransform.x;
      const y2 = m.end.y * BOARD_H * s + viewTransform.y;
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      return (
        <div className="absolute inset-0 z-20 pointer-events-none">
          <div style={{ position: "absolute", left, top, width: w, height: h, border: "1px dashed #2563eb", background: "rgba(37,99,235,0.1)" }} />
        </div>
      );
    })()
  )}
      { }
      {!readOnly && (
        <div
          className="absolute top-1/2 -translate-y-1/2 left-4 z-20 rounded-xl shadow-xl"
          data-ui-panel
          onPointerDown={e => e.stopPropagation()}
        >
          <div className="flex flex-col gap-1 p-2">
            {TOOLBAR_ITEMS.map(item => {
              const isActive = tool === item.key;
              const accent = TOOL_BADGE_BG[item.key];
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTool(item.key)}
                  className={`flex w-36 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium tool-button ${isActive ? "tool-button-active" : ""}`}
                  style={isActive ? { backgroundColor: accent } : undefined}
                  title={item.title}
                >
                  <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-base"
                    style={{
                      backgroundColor: isActive ? "rgba(255,255,255,0.22)" : themePalette.chipBackground,
                      color: isActive ? "#ffffff" : themePalette.chipText,
                    }}
                  >
                    <ToolIcon tool={item.key} className="h-3.5 w-3.5" />
                  </span>
                  <span className="truncate" data-theme-strong={isActive ? "" : undefined}>{TOOL_LABELS[item.key]}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      { }
      {!readOnly && tool === "pen" && (
        <div
          className="absolute top-1/2 -translate-y-1/2 right-4 z-30 w-[22rem]"
          onPointerDown={e => e.stopPropagation()}
        >
          <div className="rounded-2xl border border-slate-200/70 bg-white/95 px-5 py-4 text-slate-900 shadow-2xl backdrop-blur" data-ui-panel>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold tracking-wide text-slate-700">Pen</span>
              <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Settings</span>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Color</label>
                <div className="flex items-center gap-3">
                  <div
                    className="relative h-10 w-14 min-w-[3.5rem] overflow-hidden rounded-lg border border-slate-200 shadow-inner"
                    style={{ backgroundColor: penChroma.enabled ? chromaColor(penChroma) : penColor }}
                  >
                    <input
                      type="color"
                      value={penColor}
                      onChange={e => setPenColor(e.target.value)}
                      className="absolute inset-0 cursor-pointer opacity-0"
                      disabled={penChroma.enabled}
                      aria-label="Pen color"
                      title="Pen color"
                    />
                  </div>
                  <input
                    type="text"
                    value={penColor}
                    onChange={e => setPenColor(e.target.value)}
                    className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200 disabled:opacity-60"
                    disabled={penChroma.enabled}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
                  <input
                    id="chroma-toggle"
                    type="checkbox"
                    checked={penChroma.enabled}
                    onChange={e => setPenChroma({ ...penChroma, enabled: e.target.checked, startAt: Date.now() })}
                    className="accent-slate-900"
                  />
                  <span>Chroma animation</span>
                </label>
                {penChroma.enabled && (
                  <div className="grid gap-3 rounded-xl bg-slate-50/70 px-3 py-3">
                    <label className="text-xs font-medium text-slate-500">
                      Speed: {penChroma.speed}°/s
                      <input
                        type="range"
                        min={10}
                        max={720}
                        value={penChroma.speed}
                        onChange={e => setPenChroma({ ...penChroma, speed: Number(e.target.value) })}
                        className="mt-1 w-full accent-slate-900"
                      />
                    </label>
                    <label className="text-xs font-medium text-slate-500">
                      Doygunluk: {penChroma.saturation}%
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={penChroma.saturation}
                        onChange={e => setPenChroma({ ...penChroma, saturation: Number(e.target.value) })}
                        className="mt-1 w-full accent-slate-900"
                      />
                    </label>
                    <label className="text-xs font-medium text-slate-500">
                      Lightness: {penChroma.lightness}%
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={penChroma.lightness}
                        onChange={e => setPenChroma({ ...penChroma, lightness: Number(e.target.value) })}
                        className="mt-1 w-full accent-slate-900"
                      />
                    </label>
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Width: {penSize}px</label>
                <input
                  type="range"
                  min={1}
                  max={24}
                  value={penSize}
                  onChange={e => setPenSize(Number(e.target.value))}
                  className="w-full accent-slate-900"
                  aria-label="Pen width"
                />
              </div>
            </div>
          </div>
        </div>
      )}
      {!readOnly && tool === "eraser" && (
        <div
          className="absolute top-1/2 -translate-y-1/2 right-4 z-30 w-64"
          onPointerDown={e => e.stopPropagation()}
        >
          <div className="rounded-2xl border border-slate-200/70 bg-white/95 px-4 py-4 text-slate-900 shadow-2xl backdrop-blur" data-ui-panel>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold tracking-wide text-slate-700">Eraser</span>
              <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Settings</span>
            </div>
            <div className="space-y-2">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Size: {eraserSize}px</label>
              <input
                type="range"
                min={4}
                max={64}
                value={eraserSize}
                onChange={e => setEraserSize(Number(e.target.value))}
                className="w-full accent-slate-900"
                aria-label="Eraser size"
              />
            </div>
          </div>
        </div>
      )}
  {!readOnly && ((tool === "text" && !selectedTextId && !editingTextRef.current) || (tool === "select" && selectedTextId)) && (
        (() => {
          if (selectedTextId) {
            const edLive = editingTextRef.current && editingTextRef.current.textId === selectedTextId ? editingTextRef.current : null;
            const tb = committedTextsRef.current.get(selectedTextId) || null;
            const color = edLive ? edLive.color : tb?.color ?? textColor;
            const size = edLive ? edLive.size : tb?.size ?? textSize;
            const font = edLive ? edLive.font : tb?.font ?? textFont;
            const outlineSource = edLive?.outline ?? tb?.outline ?? null;
            const outline = outlineSource
              ? cloneTextOutline(outlineSource, textOutline)
              : (() => {
                  const base = cloneTextOutline(textOutline);
                  base.enabled = false;
                  return base;
                })();
            const update = (next: Partial<{ color: string; size: number; font: string }>) => {
              if (edLive) {
                if (next.color !== undefined) edLive.color = next.color;
                if (next.size !== undefined) edLive.size = next.size;
                if (next.font !== undefined) edLive.font = next.font;
                overlayTextsRef.current.set(edLive.textId, { textId: edLive.textId, x: edLive.x, y: edLive.y, text: edLive.text, color: edLive.color, size: edLive.size, font: edLive.font, width: edLive.width, height: edLive.height, outline: edLive.outline });
                const live: TextLivePayload = { type: "text_live", id, textId: edLive.textId, text: edLive.text, x: edLive.x, y: edLive.y, color: edLive.color, size: edLive.size, font: edLive.font, width: edLive.width, height: edLive.height, outline: edLive.outline };
                sendCritical(live);
                forceTick(t => t + 1);
              } else if (tb) {
                const cur = committedTextsRef.current.get(tb.textId);
                if (!cur) return;
                const nextTb = { ...cur, ...next } as typeof cur;
                committedTextsRef.current.set(tb.textId, nextTb);
                const upd: TextUpdateEvent = { type: "text_update", id, textId: tb.textId, ...(next.color ? { color: next.color } : {}), ...(next.size !== undefined ? { size: next.size } : {}), ...(next.font ? { font: next.font } : {}), strokeId: tb.strokeId };
                sendCritical(upd);
                historyRef.current.push(upd);
                forceTick(t => t + 1);
              }
            };
            const applyOutline = (mutate: (draft: TextOutlineConfig) => void) => {
              const base = cloneTextOutline(outlineSource ?? outline, textOutline);
              mutate(base);
              const next = cloneTextOutline(base, textOutline);
              if (edLive) {
                edLive.outline = next;
                overlayTextsRef.current.set(edLive.textId, { textId: edLive.textId, x: edLive.x, y: edLive.y, text: edLive.text, color: edLive.color, size: edLive.size, font: edLive.font, width: edLive.width, height: edLive.height, outline: next });
                const live: TextLivePayload = { type: "text_live", id, textId: edLive.textId, text: edLive.text, x: edLive.x, y: edLive.y, color: edLive.color, size: edLive.size, font: edLive.font, width: edLive.width, height: edLive.height, outline: next };
                sendCritical(live);
              } else if (tb) {
                const cur = committedTextsRef.current.get(tb.textId);
                if (!cur) return;
                const nextTb = { ...cur, outline: next };
                committedTextsRef.current.set(tb.textId, nextTb);
                const upd: TextUpdateEvent = { type: "text_update", id, textId: tb.textId, outline: next, strokeId: tb.strokeId };
                sendCritical(upd);
                historyRef.current.push(upd);
              }
              forceTick(t => t + 1);
            };
            return (
              <div
                className="absolute top-1/2 -translate-y-1/2 right-4 z-30 w-[22rem]"
                onPointerDown={e => e.stopPropagation()}
              >
                <div className="rounded-2xl border border-slate-200/70 bg-white/95 px-5 py-4 text-slate-900 shadow-2xl backdrop-blur" data-ui-panel>
                  <div className="mb-4 flex items-center justify-between">
                    <span className="text-sm font-semibold tracking-wide text-slate-700">Text</span>
                    <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Settings</span>
                  </div>
                  <div className="space-y-4 text-xs text-slate-600">
                  <div className="space-y-2">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Color</label>
                    <div className="flex items-center gap-3">
                      <div className="relative h-10 w-12 overflow-hidden rounded-lg border border-slate-200 shadow-inner" style={{ backgroundColor: (tb?.chroma?.enabled ? chromaColor(tb.chroma) : color) }}>
                        <input type="color" value={color} onChange={e => update({ color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" disabled={tb?.chroma?.enabled} />
                      </div>
                      <input type="text" value={color} onChange={e => update({ color: e.target.value })} className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200 disabled:opacity-60" disabled={tb?.chroma?.enabled} />
                    </div>
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
                      <input id="chroma-toggle-selected-text-2" type="checkbox" checked={!!tb?.chroma?.enabled} onChange={e => {
                        const cur = committedTextsRef.current.get(selectedTextId!);
                        if (!cur) return;
                        const chroma = e.target.checked
                          ? (cur.chroma ?? { enabled: true, speed: 120, saturation: 100, lightness: 50, startAt: Date.now() })
                          : undefined;
                        committedTextsRef.current.set(selectedTextId!, { ...cur, chroma: chroma ? { ...chroma, enabled: true, startAt: Date.now() } : undefined });
                        const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, chroma: chroma };
                        sendCritical(upd);
                        historyRef.current.push(upd);
                        forceTick(t => t + 1);
                      }} className="accent-slate-900" />
                      <span>Chroma mode</span>
                    </label>
                    {tb?.chroma?.enabled && (
                      <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                        <div>
                          <label className="text-xs font-medium text-slate-500">Speed: {tb.chroma.speed}°/s</label>
                          <input type="range" min={10} max={720} value={tb.chroma.speed} onChange={e => {
                            const cur = committedTextsRef.current.get(selectedTextId!);
                            if (!cur || !cur.chroma) return;
                            const chroma = { ...cur.chroma, speed: Number(e.target.value) };
                            committedTextsRef.current.set(selectedTextId!, { ...cur, chroma });
                            const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, chroma };
                            sendCritical(upd);
                            historyRef.current.push(upd);
                            forceTick(t => t + 1);
                          }} className="mt-1 w-full accent-slate-900" />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-slate-500">Doygunluk: {tb.chroma.saturation}%</label>
                          <input type="range" min={0} max={100} value={tb.chroma.saturation} onChange={e => {
                            const cur = committedTextsRef.current.get(selectedTextId!);
                            if (!cur || !cur.chroma) return;
                            const chroma = { ...cur.chroma, saturation: Number(e.target.value) };
                            committedTextsRef.current.set(selectedTextId!, { ...cur, chroma });
                            const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, chroma };
                            sendCritical(upd);
                            historyRef.current.push(upd);
                            forceTick(t => t + 1);
                          }} className="mt-1 w-full accent-slate-900" />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-slate-500">Lightness: {tb.chroma.lightness}%</label>
                          <input type="range" min={0} max={100} value={tb.chroma.lightness} onChange={e => {
                            const cur = committedTextsRef.current.get(selectedTextId!);
                            if (!cur || !cur.chroma) return;
                            const chroma = { ...cur.chroma, lightness: Number(e.target.value) };
                            committedTextsRef.current.set(selectedTextId!, { ...cur, chroma });
                            const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, chroma };
                            sendCritical(upd);
                            historyRef.current.push(upd);
                            forceTick(t => t + 1);
                          }} className="mt-1 w-full accent-slate-900" />
                        </div>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 text-xs">
                      <input
                        id="outline-toggle-selected-text"
                        type="checkbox"
                        checked={outline.enabled}
                        onChange={e => applyOutline(draft => { draft.enabled = e.target.checked; })}
                      />
                      <label htmlFor="outline-toggle-selected-text">Outline</label>
                    </div>
                    {outline.enabled && (
                      <div className="mt-2 space-y-2">
                        <div>
                          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Outline color</label>
                          <div className="flex items-center gap-3">
                            <div className="relative h-10 w-12 overflow-hidden rounded-lg border border-slate-200 shadow-inner" style={{ backgroundColor: outline.chroma?.enabled ? chromaColor(outline.chroma) : outline.color }}>
                              <input
                                type="color"
                                value={outline.color}
                                onChange={e => applyOutline(draft => { draft.color = e.target.value; })}
                                className="absolute inset-0 cursor-pointer opacity-0"
                                disabled={!!outline.chroma?.enabled}
                              />
                            </div>
                            <input
                              type="text"
                              value={outline.color}
                              onChange={e => applyOutline(draft => { draft.color = e.target.value; })}
                              className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200 disabled:opacity-60"
                              disabled={!!outline.chroma?.enabled}
                            />
                          </div>
                          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                            <input
                              id="outline-chroma-toggle-selected-text-2"
                              type="checkbox"
                              checked={!!outline.chroma?.enabled}
                              onChange={e => applyOutline(draft => {
                                if (e.target.checked) {
                                  const base = draft.chroma ?? { enabled: true, speed: 120, saturation: 100, lightness: 50, startAt: Date.now() };
                                  draft.chroma = { ...base, enabled: true, startAt: Date.now() };
                                } else {
                                  draft.chroma = undefined;
                                }
                              })}
                              className="accent-slate-900"
                            />
                            <label htmlFor="outline-chroma-toggle-selected-text-2">Chroma mode</label>
                          </div>
                          {outline.chroma?.enabled && (
                            <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                              <div>
                                <label className="text-xs font-medium text-slate-500">Speed: {outline.chroma.speed}°/s</label>
                                <input
                                  type="range"
                                  min={10}
                                  max={720}
                                  value={outline.chroma.speed}
                                  onChange={e => applyOutline(draft => {
                                    if (!draft.chroma) {
                                      const base = outline.chroma ?? { enabled: true, speed: 120, saturation: 100, lightness: 50, startAt: Date.now() };
                                      draft.chroma = { ...base, enabled: true };
                                    }
                                    draft.chroma.speed = Number(e.target.value);
                                  })}
                                  className="mt-1 w-full accent-slate-900"
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium text-slate-500">Doygunluk: {outline.chroma.saturation}%</label>
                                <input
                                  type="range"
                                  min={0}
                                  max={100}
                                  value={outline.chroma.saturation}
                                  onChange={e => applyOutline(draft => {
                                    if (!draft.chroma) {
                                      const base = outline.chroma ?? { enabled: true, speed: 120, saturation: 100, lightness: 50, startAt: Date.now() };
                                      draft.chroma = { ...base, enabled: true };
                                    }
                                    draft.chroma.saturation = Number(e.target.value);
                                  })}
                                  className="mt-1 w-full accent-slate-900"
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium text-slate-500">Lightness: {outline.chroma.lightness}%</label>
                                <input
                                  type="range"
                                  min={0}
                                  max={100}
                                  value={outline.chroma.lightness}
                                  onChange={e => applyOutline(draft => {
                                    if (!draft.chroma) {
                                      const base = outline.chroma ?? { enabled: true, speed: 120, saturation: 100, lightness: 50, startAt: Date.now() };
                                      draft.chroma = { ...base, enabled: true };
                                    }
                                    draft.chroma.lightness = Number(e.target.value);
                                  })}
                                  className="mt-1 w-full accent-slate-900"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="text-xs font-medium text-slate-500">
                            Width: {outline.width}px (effective ≈ {Math.round(effectiveOutlineValue(outline.width, tb?.size ?? textSize) * 10) / 10}px)
                          </label>
                          <input
                            type="range"
                            min={0}
                            max={32}
                            value={outline.width}
                            onChange={e => applyOutline(draft => { draft.width = Number(e.target.value); })}
                            className="mt-1 w-full accent-slate-900"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-slate-500">
                            Feather: {outline.feather}px (effective ≈ {Math.round(effectiveOutlineValue(outline.feather, tb?.size ?? textSize) * 10) / 10}px)
                          </label>
                          <input
                            type="range"
                            min={0}
                            max={30}
                            value={outline.feather}
                            onChange={e => applyOutline(draft => { draft.feather = Number(e.target.value); })}
                            className="mt-1 w-full accent-slate-900"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
                      <input
                        id="dvd-toggle-text-2"
                        type="checkbox"
                        checked={!!dvdTextStateRef.current.get(selectedTextId!)?.enabled}
                        onChange={e => {
                          const st = ensureDvdState("text", selectedTextId!);
                          st.enabled = e.target.checked;
                          st.lastSent = 0;
                          st.controlled = true;
                          dvdTextStateRef.current.set(selectedTextId!, st);
                          const tb = committedTextsRef.current.get(selectedTextId!);
                          const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, dvdEnabled: st.enabled, dvdSpeed: st.speed, dvdVx: st.vx, dvdVy: st.vy, strokeId: tb?.strokeId };
                          sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent);
                          forceTick(t => t + 1);
                        }}
                        className="accent-slate-900"
                      />
                      <span>DVD mode</span>
                    </label>
                    {dvdTextStateRef.current.get(selectedTextId!)?.enabled && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                        <label className="text-xs font-medium text-slate-500">Speed: {Math.round((dvdTextStateRef.current.get(selectedTextId!)?.speed ?? 240))} px/s</label>
                        <input
                          type="range"
                          min={40}
                          max={800}
                          value={dvdTextStateRef.current.get(selectedTextId!)?.speed ?? 240}
                          onChange={e => {
                            const st = ensureDvdState("text", selectedTextId!);
                            const sp = Number(e.target.value);
                            st.speed = sp;
                            const ang = Math.atan2(st.vy * BOARD_H, st.vx * BOARD_W);
                            st.vx = Math.cos(ang) * (sp / BOARD_W);
                            st.vy = Math.sin(ang) * (sp / BOARD_H);
                            dvdTextStateRef.current.set(selectedTextId!, st);
                            st.controlled = true;
                            const tb = committedTextsRef.current.get(selectedTextId!);
                            const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, dvdSpeed: st.speed, dvdVx: st.vx, dvdVy: st.vy, strokeId: tb?.strokeId };
                            sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent);
                            forceTick(t => t + 1);
                          }}
                          className="mt-2 w-full accent-slate-900"
                        />
                      </div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Size: {size}px</label>
                    <input type="range" min={10} max={128} value={size} onChange={e => update({ size: Number(e.target.value) })} className="w-full accent-slate-900" />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-xs font-medium text-slate-500">Rot X</label>
                      <input type="range" min={-180} max={180} value={tb?.rotX ?? 0} onChange={e => {
                        const cur = committedTextsRef.current.get(selectedTextId!);
                        if (!cur) return;
                        const rotX = Number(e.target.value);
                        committedTextsRef.current.set(selectedTextId!, { ...cur, rotX });
                        const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotX, strokeId: cur.strokeId };
                        sendCritical(upd); historyRef.current.push(upd); forceTick(t => t + 1);
                      }} className="mt-1 w-full accent-slate-900" />
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[11px] font-medium text-slate-500">
                        <button type="button" className="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
                          onClick={() => {
                            const cur = committedTextsRef.current.get(selectedTextId!); if (!cur) return;
                            committedTextsRef.current.set(selectedTextId!, { ...cur, rotX: 0 });
                            const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotX: 0, strokeId: cur.strokeId };
                            sendCritical(upd); historyRef.current.push(upd); forceTick(t => t + 1);
                          }}>Reset</button>
                        <label className="inline-flex items-center gap-1 whitespace-nowrap">
                          <input type="checkbox" checked={!!rotTextStateRef.current.get(selectedTextId!)?.x.enabled}
                            onChange={e => { const st = ensureRotState("text", selectedTextId!); st.x.enabled = e.target.checked; st.controlled = true; rotTextStateRef.current.set(selectedTextId!, st); const tb = committedTextsRef.current.get(selectedTextId!); const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotXAnimEnabled: st.x.enabled, rotXAnimSpeed: st.x.speed, rotXAnimMin: st.x.min, rotXAnimMax: st.x.max, rotXAnimDir: st.x.dir, strokeId: tb?.strokeId }; sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1); }}
                            className="accent-slate-900" />
                          <span>Rotation animation</span>
                        </label>
                        <label className="inline-flex items-center gap-1 whitespace-nowrap">
                          <input type="checkbox" checked={rotTextStateRef.current.get(selectedTextId!)?.x.dir === -1}
                            onChange={e => { const st = ensureRotState("text", selectedTextId!); st.x.dir = e.target.checked ? -1 : 1; st.controlled = true; rotTextStateRef.current.set(selectedTextId!, st); const tb = committedTextsRef.current.get(selectedTextId!); const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotXAnimDir: st.x.dir, strokeId: tb?.strokeId }; sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1); }}
                            className="accent-slate-900" />
                          <span>Reverse direction</span>
                        </label>
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-500">Rot Y</label>
                      <input type="range" min={-180} max={180} value={tb?.rotY ?? 0} onChange={e => {
                        const cur = committedTextsRef.current.get(selectedTextId!);
                        if (!cur) return;
                        const rotY = Number(e.target.value);
                        committedTextsRef.current.set(selectedTextId!, { ...cur, rotY });
                        const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotY, strokeId: cur.strokeId };
                        sendCritical(upd); historyRef.current.push(upd); forceTick(t => t + 1);
                      }} className="mt-1 w-full accent-slate-900" />
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[11px] font-medium text-slate-500">
                        <button type="button" className="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
                          onClick={() => {
                            const cur = committedTextsRef.current.get(selectedTextId!); if (!cur) return;
                            committedTextsRef.current.set(selectedTextId!, { ...cur, rotY: 0 });
                            const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotY: 0, strokeId: cur.strokeId };
                            sendCritical(upd); historyRef.current.push(upd); forceTick(t => t + 1);
                          }}>Reset</button>
                        <label className="inline-flex items-center gap-1 whitespace-nowrap">
                          <input type="checkbox" checked={!!rotTextStateRef.current.get(selectedTextId!)?.y.enabled}
                            onChange={e => { const st = ensureRotState("text", selectedTextId!); st.y.enabled = e.target.checked; st.controlled = true; rotTextStateRef.current.set(selectedTextId!, st); const tb = committedTextsRef.current.get(selectedTextId!); const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotYAnimEnabled: st.y.enabled, rotYAnimSpeed: st.y.speed, rotYAnimMin: st.y.min, rotYAnimMax: st.y.max, rotYAnimDir: st.y.dir, strokeId: tb?.strokeId }; sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1); }}
                            className="accent-slate-900" />
                          <span>Rotation animation</span>
                        </label>
                        <label className="inline-flex items-center gap-1 whitespace-nowrap">
                          <input type="checkbox" checked={rotTextStateRef.current.get(selectedTextId!)?.y.dir === -1}
                            onChange={e => { const st = ensureRotState("text", selectedTextId!); st.y.dir = e.target.checked ? -1 : 1; st.controlled = true; rotTextStateRef.current.set(selectedTextId!, st); const tb = committedTextsRef.current.get(selectedTextId!); const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotYAnimDir: st.y.dir, strokeId: tb?.strokeId }; sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1); }}
                            className="accent-slate-900" />
                          <span>Reverse direction</span>
                        </label>
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-500">Rot Z</label>
                      <input type="range" min={-180} max={180} value={tb?.rotZ ?? 0} onChange={e => {
                        const cur = committedTextsRef.current.get(selectedTextId!);
                        if (!cur) return;
                        const rotZ = Number(e.target.value);
                        committedTextsRef.current.set(selectedTextId!, { ...cur, rotZ });
                        const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotZ, strokeId: cur.strokeId };
                        sendCritical(upd); historyRef.current.push(upd); forceTick(t => t + 1);
                      }} className="mt-1 w-full accent-slate-900" />
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[11px] font-medium text-slate-500">
                        <button type="button" className="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
                          onClick={() => {
                            const cur = committedTextsRef.current.get(selectedTextId!); if (!cur) return;
                            committedTextsRef.current.set(selectedTextId!, { ...cur, rotZ: 0 });
                            const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotZ: 0, strokeId: cur.strokeId };
                            sendCritical(upd); historyRef.current.push(upd); forceTick(t => t + 1);
                          }}>Reset</button>
                        <label className="inline-flex items-center gap-1 whitespace-nowrap">
                          <input type="checkbox" checked={!!rotTextStateRef.current.get(selectedTextId!)?.z.enabled}
                            onChange={e => { const st = ensureRotState("text", selectedTextId!); st.z.enabled = e.target.checked; st.controlled = true; rotTextStateRef.current.set(selectedTextId!, st); const tb = committedTextsRef.current.get(selectedTextId!); const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotZAnimEnabled: st.z.enabled, rotZAnimSpeed: st.z.speed, rotZAnimMin: st.z.min, rotZAnimMax: st.z.max, rotZAnimDir: st.z.dir, strokeId: tb?.strokeId }; sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1); }}
                            className="accent-slate-900" />
                          <span>Rotation animation</span>
                        </label>
                        <label className="inline-flex items-center gap-1 whitespace-nowrap">
                          <input type="checkbox" checked={rotTextStateRef.current.get(selectedTextId!)?.z.dir === -1}
                            onChange={e => { const st = ensureRotState("text", selectedTextId!); st.z.dir = e.target.checked ? -1 : 1; st.controlled = true; rotTextStateRef.current.set(selectedTextId!, st); const tb = committedTextsRef.current.get(selectedTextId!); const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId!, rotZAnimDir: st.z.dir, strokeId: tb?.strokeId }; sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1); }}
                            className="accent-slate-900" />
                          <span>Reverse direction</span>
                        </label>
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Font</label>
                    <select value={font} onChange={e => { const val = e.target.value; const found = FONT_OPTIONS.find(o => o.value === val); if (found) loadGoogleFont(found.label); update({ font: val }); }} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200">
                      {FONT_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <div className="mt-2">
                      <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
                        <input type="checkbox" className="accent-slate-900" checked={fontCycleOn} onChange={e => {
                          const on = e.target.checked; setFontCycleOn(on);
                          if (selectedTextId) {
                            const st = fontCycleStateRef.current.get(selectedTextId) || { enabled: false, ms: fontCycleMs };
                            st.enabled = on; st.ms = fontCycleMs; fontCycleStateRef.current.set(selectedTextId, st);
                            try { sendCritical({ type: "font_cycle_control", id, targetId: selectedTextId, enabled: on, ms: st.ms }); } catch {}
                          }
                        }} />
                        <span>Font cycle</span>
                      </label>
                      {fontCycleOn && (
                        <div className="mt-2 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                          <span className="text-[11px] font-medium text-slate-500">Speed</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={fontCycleSpeed}
                            onChange={e => { const sp = Number(e.target.value); const ms = msFromSpeed(sp); setFontCycleSpeed(sp); setFontCycleMs(ms);
                              if (selectedTextId) { const st = fontCycleStateRef.current.get(selectedTextId) || { enabled: fontCycleOn, ms }; st.ms = ms; st.enabled = fontCycleOn; fontCycleStateRef.current.set(selectedTextId, st); try { sendCritical({ type: "font_cycle_control", id, targetId: selectedTextId, ms }); } catch {} }
                            }}
                            className="h-2 w-28 accent-slate-900"
                          />
                          <span className="w-12 text-right text-[11px] font-medium tabular-nums text-slate-500">{fontCycleMs}ms</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="pt-2" style={{ borderTop: `1px solid ${themePalette.panelDivider}` }}>
                    <button
                      type="button"
                      onClick={deleteSelected}
                      className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition active:scale-[0.98]"
                      style={{
                        backgroundColor: isDarkTheme ? 'rgba(239, 68, 68, 0.15)' : 'rgba(254, 226, 226, 1)',
                        color: isDarkTheme ? '#fca5a5' : '#dc2626',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.backgroundColor = isDarkTheme ? 'rgba(239, 68, 68, 0.25)' : 'rgba(254, 202, 202, 1)';
                        e.currentTarget.style.color = isDarkTheme ? '#fecaca' : '#b91c1c';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.backgroundColor = isDarkTheme ? 'rgba(239, 68, 68, 0.15)' : 'rgba(254, 226, 226, 1)';
                        e.currentTarget.style.color = isDarkTheme ? '#fca5a5' : '#dc2626';
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                </div>
              </div>
            );
          }
          if (tool !== "text") return null;
          return (
            <div
              className="absolute top-1/2 -translate-y-1/2 right-4 z-20 w-[22rem]"
              onPointerDown={e => e.stopPropagation()}
            >
              <div className="rounded-2xl border border-slate-200/70 bg-white/95 px-5 py-4 text-slate-900 shadow-2xl backdrop-blur" data-ui-panel>
                <div className="mb-4 flex items-center justify-between">
                    <span className="text-sm font-semibold tracking-wide text-slate-700">Text</span>
                  <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Settings</span>
                </div>
                <div className="space-y-4 text-xs text-slate-600">
                  <div className="space-y-2">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Color</label>
                    <div className="flex items-center gap-3">
                      <div className="relative h-10 w-12 overflow-hidden rounded-lg border border-slate-200 shadow-inner" style={{ backgroundColor: textChroma.enabled ? chromaColor(textChroma) : textColor }}>
                        <input
                          type="color"
                          value={textColor}
                          onChange={e => setTextColor(e.target.value)}
                          className="absolute inset-0 cursor-pointer opacity-0"
                          disabled={textChroma.enabled}
                        />
                      </div>
                      <input
                        type="text"
                        value={textColor}
                        onChange={e => setTextColor(e.target.value)}
                        className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200 disabled:opacity-60"
                        disabled={textChroma.enabled}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
                      <input
                        id="chroma-toggle-text"
                        type="checkbox"
                        checked={textChroma.enabled}
                        onChange={e => setTextChroma({ ...textChroma, enabled: e.target.checked, startAt: Date.now() })}
                        className="accent-slate-900"
                      />
                      <span>Chroma mode</span>
                    </label>
                    {textChroma.enabled && (
                      <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                        <label className="text-xs font-medium text-slate-500">
                          Speed: {textChroma.speed}°/s
                          <input
                            type="range"
                            min={10}
                            max={720}
                            value={textChroma.speed}
                            onChange={e => setTextChroma({ ...textChroma, speed: Number(e.target.value) })}
                            className="mt-1 w-full accent-slate-900"
                          />
                        </label>
                        <label className="text-xs font-medium text-slate-500">
                          Doygunluk: {textChroma.saturation}%
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={textChroma.saturation}
                            onChange={e => setTextChroma({ ...textChroma, saturation: Number(e.target.value) })}
                            className="mt-1 w-full accent-slate-900"
                          />
                        </label>
                        <label className="text-xs font-medium text-slate-500">
                          Lightness: {textChroma.lightness}%
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={textChroma.lightness}
                            onChange={e => setTextChroma({ ...textChroma, lightness: Number(e.target.value) })}
                            className="mt-1 w-full accent-slate-900"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
                      <input
                        id="outline-toggle-default"
                        type="checkbox"
                        checked={textOutline.enabled}
                        onChange={e => setTextOutline(prev => {
                          const chroma = prev.chroma ? { ...prev.chroma } : undefined;
                          return { ...prev, enabled: e.target.checked, chroma };
                        })}
                        className="accent-slate-900"
                      />
                      <span>Outline</span>
                    </label>
                    {textOutline.enabled && (
                      <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                        <div className="space-y-2">
                          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Outline color</label>
                          <div className="flex items-center gap-3">
                            <div className="relative h-10 w-12 overflow-hidden rounded-lg border border-slate-200 shadow-inner" style={{ backgroundColor: textOutline.chroma?.enabled ? chromaColor(textOutline.chroma) : textOutline.color }}>
                              <input
                                type="color"
                                value={textOutline.color}
                                onChange={e => setTextOutline(prev => {
                                  const chroma = prev.chroma ? { ...prev.chroma } : undefined;
                                  return { ...prev, color: e.target.value, chroma };
                                })}
                                className="absolute inset-0 cursor-pointer opacity-0"
                                disabled={!!textOutline.chroma?.enabled}
                              />
                            </div>
                            <input
                              type="text"
                              value={textOutline.color}
                              onChange={e => setTextOutline(prev => {
                                const chroma = prev.chroma ? { ...prev.chroma } : undefined;
                                return { ...prev, color: e.target.value, chroma };
                              })}
                              className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200 disabled:opacity-60"
                              disabled={!!textOutline.chroma?.enabled}
                            />
                          </div>
                          <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
                            <input
                              id="outline-chroma-toggle"
                              type="checkbox"
                              checked={!!textOutline.chroma?.enabled}
                              onChange={e => setTextOutline(prev => {
                                if (e.target.checked) {
                                  const base = prev.chroma ?? { enabled: true, speed: 120, saturation: 100, lightness: 50, startAt: Date.now() };
                                  return { ...prev, chroma: { ...base, enabled: true, startAt: Date.now() } };
                                }
                                return { ...prev, chroma: undefined };
                              })}
                              className="accent-slate-900"
                            />
                            <span>Chroma mode</span>
                          </label>
                          {textOutline.chroma?.enabled && (
                            <div className="space-y-3 rounded-xl border border-slate-200 bg-white/80 px-3 py-3">
                              <label className="text-xs font-medium text-slate-500">
                                Speed: {textOutline.chroma.speed}°/s
                                <input
                                  type="range"
                                  min={10}
                                  max={720}
                                  value={textOutline.chroma.speed}
                                  onChange={e => setTextOutline(prev => {
                                    const chroma = prev.chroma ? { ...prev.chroma, speed: Number(e.target.value) } : { enabled: true, speed: Number(e.target.value), saturation: 100, lightness: 50, startAt: Date.now() };
                                    return { ...prev, chroma };
                                  })}
                                  className="mt-1 w-full accent-slate-900"
                                />
                              </label>
                              <label className="text-xs font-medium text-slate-500">
                                Doygunluk: {textOutline.chroma.saturation}%
                                <input
                                  type="range"
                                  min={0}
                                  max={100}
                                  value={textOutline.chroma.saturation}
                                  onChange={e => setTextOutline(prev => {
                                    const chroma = prev.chroma ? { ...prev.chroma, saturation: Number(e.target.value) } : { enabled: true, speed: 120, saturation: Number(e.target.value), lightness: 50, startAt: Date.now() };
                                    return { ...prev, chroma };
                                  })}
                                  className="mt-1 w-full accent-slate-900"
                                />
                              </label>
                              <label className="text-xs font-medium text-slate-500">
                                Lightness: {textOutline.chroma.lightness}%
                                <input
                                  type="range"
                                  min={0}
                                  max={100}
                                  value={textOutline.chroma.lightness}
                                  onChange={e => setTextOutline(prev => {
                                    const chroma = prev.chroma ? { ...prev.chroma, lightness: Number(e.target.value) } : { enabled: true, speed: 120, saturation: 100, lightness: Number(e.target.value), startAt: Date.now() };
                                    return { ...prev, chroma };
                                  })}
                                  className="mt-1 w-full accent-slate-900"
                                />
                              </label>
                            </div>
                          )}
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-medium text-slate-500">
                            Width: {textOutline.width}px (effective ≈ {Math.round(effectiveOutlineValue(textOutline.width, textSize) * 10) / 10}px)
                          </label>
                          <input
                            type="range"
                            min={0}
                            max={32}
                            value={textOutline.width}
                            onChange={e => setTextOutline(prev => {
                              const chroma = prev.chroma ? { ...prev.chroma } : undefined;
                              return { ...prev, width: Number(e.target.value), chroma };
                            })}
                            className="w-full accent-slate-900"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-medium text-slate-500">
                            Feather: {textOutline.feather}px (effective ≈ {Math.round(effectiveOutlineValue(textOutline.feather, textSize) * 10) / 10}px)
                          </label>
                          <input
                            type="range"
                            min={0}
                            max={30}
                            value={textOutline.feather}
                            onChange={e => setTextOutline(prev => {
                              const chroma = prev.chroma ? { ...prev.chroma } : undefined;
                              return { ...prev, feather: Number(e.target.value), chroma };
                            })}
                            className="w-full accent-slate-900"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Size: {textSize}px</label>
                    <input
                      type="range"
                      min={10}
                      max={128}
                      value={textSize}
                      onChange={e => setTextSize(Number(e.target.value))}
                      className="w-full accent-slate-900"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Font</label>
                    <select
                      value={textFont}
                      onChange={e => {
                        const val = e.target.value;
                        const found = FONT_OPTIONS.find(o => o.value === val);
                        if (found) loadGoogleFont(found.label);
                        setTextFont(withFontFallback(val));
                      }}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
                      aria-label="Text font"
                    >
                      {FONT_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
                        <input
                          type="checkbox"
                          className="accent-slate-900"
                          checked={fontCycleOn}
                          onChange={e => {
                            const on = e.target.checked; setFontCycleOn(on);
                            if (selectedTextId) {
                              const cur = committedTextsRef.current.get(selectedTextId);
                              const st = fontCycleStateRef.current.get(selectedTextId) || { enabled: false, ms: fontCycleMs };
                              if (on) {
                                if (cur && !st.baseFont) st.baseFont = cur.font;
                                st.enabled = true; st.ms = fontCycleMs; fontCycleStateRef.current.set(selectedTextId, st);
                                try { sendCritical({ type: "font_cycle_control", id, targetId: selectedTextId, enabled: true, ms: st.ms }); } catch {}
                              } else {
                                st.enabled = false; fontCycleStateRef.current.set(selectedTextId, st);
                                try { sendCritical({ type: "font_cycle_control", id, targetId: selectedTextId, enabled: false, ms: st.ms }); } catch {}
                                if (cur && st.baseFont && cur.font !== st.baseFont) {
                                  committedTextsRef.current.set(selectedTextId, { ...cur, font: st.baseFont });
                                  const upd: TextUpdateEvent = { type: "text_update", id, textId: selectedTextId, font: st.baseFont, strokeId: cur.strokeId };
                                  sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1);
                                }
                              }
                            }
                          }}
                        />
                        <span>Font cycle</span>
                      </label>
                      {fontCycleOn && (
                        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                          <span className="text-[11px] font-medium text-slate-500">Speed</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={fontCycleSpeed}
                            onChange={e => {
                              const sp = Number(e.target.value);
                              const ms = msFromSpeed(sp);
                              setFontCycleSpeed(sp);
                              setFontCycleMs(ms);
                              if (selectedTextId) {
                                const st = fontCycleStateRef.current.get(selectedTextId) || { enabled: fontCycleOn, ms };
                                st.ms = ms;
                                st.enabled = fontCycleOn;
                                fontCycleStateRef.current.set(selectedTextId, st);
                                try { sendCritical({ type: "font_cycle_control", id, targetId: selectedTextId, ms }); } catch {}
                              }
                            }}
                            className="h-2 w-28 accent-slate-900"
                          />
                          <span className="w-12 text-right text-[11px] font-medium tabular-nums text-slate-500">{fontCycleMs}ms</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-400">Text: Enter inserts a line break; Escape cancels. Double-click existing text to edit it.</p>
                </div>
              </div>
            </div>
          );
        })()
      )}
      {tool === "media" && !selectedImageId && !(imageUploading || mediaProcessing || previewPreparing) && (
        <div
          className="absolute top-1/2 -translate-y-1/2 right-4 z-20 w-[26rem]"
          data-ui-panel
          onPointerDown={e => e.stopPropagation()}
        >
          <div className="rounded-2xl border border-slate-200/70 bg-white/95 px-5 py-4 text-slate-900 shadow-2xl backdrop-blur">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-semibold tracking-wide text-slate-700">Media</span>
              <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Upload</span>
            </div>
            <div className="space-y-4 text-xs text-slate-600">
              <div className="space-y-2">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Choose media (PNG/JPEG/GIF/WebP/AVIF/MP4/WebM)</label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => !(imageUploading || mediaProcessing || previewPreparing) && fileInputRef.current?.click()}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium shadow-sm transition ${imageUploading || mediaProcessing || previewPreparing ? 'cursor-not-allowed border-slate-100 bg-slate-100 text-slate-300' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-900'}`}
                    disabled={imageUploading || mediaProcessing || previewPreparing}
                  >
                    {(imageUploading || mediaProcessing || previewPreparing) ? 'Busy…' : 'Choose file'}
                  </button>
                  {pendingImageName && (
                    <span className="truncate text-xs font-medium text-slate-500">{pendingImageName}</span>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Or add from a link</label>
                <div className="flex items-center gap-2">
                  <input id="media-url-input" type="url" placeholder="https://… (image or video)" className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200" />
                  <button
                    type="button"
                    className={`rounded-lg border px-3 py-2 text-sm font-medium shadow-sm transition ${previewPreparing ? 'cursor-not-allowed border-slate-100 bg-slate-100 text-slate-300' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-900'}`}
                    disabled={previewPreparing}
                    onClick={async () => {
                      try {
                        const el = document.getElementById('media-url-input') as HTMLInputElement | null;
                        const raw = (el?.value || '').trim();
                        if (!raw) return;
                        setPreviewPreparing(true); setMediaPhase('preview'); mediaBusyRef.current = true;
                        let parsed: URL;
                        try { parsed = new URL(raw); } catch { alert('Invalid URL'); setPreviewPreparing(false); setMediaPhase(null); mediaBusyRef.current = false; return; }
                        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { alert('Only HTTP and HTTPS links are supported'); setPreviewPreparing(false); setMediaPhase(null); mediaBusyRef.current = false; return; }
                        let fileUrl = parsed.toString();
                        let resolvedContentType: string | null = null;
                        try {
                          const res = await fetch(`/api/media/resolve?url=${encodeURIComponent(fileUrl)}`, {
                            method: 'GET',
                            headers: apiAuthorizationHeaders,
                          });
                          if (res.ok) {
                            const js = await res.json();
                            if (js && typeof js.url === 'string' && (js.url.startsWith('http://') || js.url.startsWith('https://'))) {
                              fileUrl = js.url;
                              if (typeof js.contentType === 'string') resolvedContentType = js.contentType;
                            }
                          }
                        } catch {}
                        setMediaPhase('process');
                        const storedResponse = await fetch('/api/media', {
                          method: 'POST',
                          headers: { ...apiAuthorizationHeaders, 'content-type': 'application/json' },
                          body: JSON.stringify({ url: fileUrl }),
                        });
                        const storedMedia = await storedResponse.json().catch(() => null);
                        if (!storedResponse.ok || !storedMedia) {
                          throw new Error(typeof storedMedia?.error === 'string' ? storedMedia.error : 'Remote media could not be stored');
                        }
                        fileUrl = String(storedMedia.path || storedMedia.url || '');
                        if (!fileUrl) throw new Error('The media service returned an invalid URL');
                        if (typeof storedMedia.contentType === 'string') resolvedContentType = storedMedia.contentType;
                        const previewUrl = normalizeMediaSrc(fileUrl);
                        const ensurePreviewAtCursor = () => {
                          const pos = selfPos.current || { x: 0.5, y: 0.5 };
                          if (!imagePreviewRef.current) imagePreviewRef.current = { x: pos.x, y: pos.y, scale: 1 };
                          forceTick(t => t + 1);
                        };
                        const isVideo = (resolvedContentType ? resolvedContentType.startsWith('video/') : false)
                          || /\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(fileUrl)
                          || /[?&#](type|format)=(mp4|webm)/i.test(fileUrl);
                        const animatedFromUrl = !isVideo && looksAnimatedImage(fileUrl, resolvedContentType);
                        if (isVideo) {
                          try {
                            const dims = await new Promise<{ w: number; h: number }>((resolve) => {
                              const v = document.createElement('video');
                              v.preload = 'metadata';
                              const tm = window.setTimeout(() => resolve({ w: 640, h: 360 }), 12000);
                              v.onloadedmetadata = () => { window.clearTimeout(tm); resolve({ w: v.videoWidth || 640, h: v.videoHeight || 360 }); };
                              v.onerror = () => { window.clearTimeout(tm); resolve({ w: 640, h: 360 }); };
                              v.src = previewUrl;
                            });
                            pendingImageRef.current = { src: fileUrl, naturalW: dims.w, naturalH: dims.h, kind: 'video', origin: 'link' };
                          } catch {
                            pendingImageRef.current = { src: fileUrl, naturalW: 640, naturalH: 360, kind: 'video', origin: 'link' };
                          }
                        } else {
                          try {
                            const dims = await new Promise<{ w: number; h: number }>((resolve) => {
                              const im = new Image();
                              im.onload = () => resolve({ w: im.naturalWidth || 100, h: im.naturalHeight || 100 });
                              im.onerror = () => resolve({ w: 640, h: 360 });
                              try { im.crossOrigin = 'anonymous'; } catch {}
                              im.src = previewUrl;
                            });
                            pendingImageRef.current = { src: fileUrl, naturalW: dims.w, naturalH: dims.h, kind: 'image', animated: animatedFromUrl, origin: 'link' };
                          } catch {
                            pendingImageRef.current = { src: fileUrl, naturalW: 640, naturalH: 360, kind: 'image', animated: animatedFromUrl, origin: 'link' };
                          }
                        }
                        setPreviewPreparing(false); setMediaPhase(null); mediaBusyRef.current = false;
                        ensurePreviewAtCursor();
                      } catch (e) {
                        setPreviewPreparing(false); setMediaPhase(null); mediaBusyRef.current = false;
                        alert((e as Error)?.message || 'Unable to add the URL');
                      }
                    }}>Add</button>
                </div>
              </div>
              { }
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/mp4,video/webm"
                className="hidden"
                onChange={async e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setPendingImageName(file.name);
                  setPreviewPreparing(true);
                  setMediaPhase('analyze');
                  mediaBusyRef.current = true;
                  const buf = await file.arrayBuffer();
                  const u8 = new Uint8Array(buf);
                  const fname = file.name || '';
                  const ftype = (file.type || '').toLowerCase();
                  const isVideo = ftype.startsWith('video/') || /\.(mp4|webm)$/i.test(fname);
                  const isGif = ftype === 'image/gif' || /\.gif$/i.test(fname);
                  const isWebp = ftype === 'image/webp' || /\.webp$/i.test(fname);
                  let isApng = false;
                  if (ftype === 'image/png' || /\.png$/i.test(fname)) {
                    try {
                      const head = u8.subarray(0, Math.min(65536, u8.length));
                      const txt = new TextDecoder('latin1').decode(head);
                      isApng = txt.indexOf('acTL') !== -1;
                    } catch {}
                  }
                  const animated = !isVideo && (isGif || isWebp || isApng);
                  const ensurePreviewAtCursor = () => {
                    const pos = selfPos.current || { x: 0.5, y: 0.5 };
                    if (!imagePreviewRef.current) imagePreviewRef.current = { x: pos.x, y: pos.y, scale: 1 };
                    forceTick(t => t + 1);
                  };
                  const upload = async (blob: Blob): Promise<string> => {
                    const myToken = { id: Math.random().toString(36).slice(2), aborted: false };
                    currentUploadTokenRef.current = myToken;
                    setImageUploading(true);
                    setImageUploadProgress(0);
                    setMediaPhase('upload');
                    const doUploadRaw = () => new Promise<string>((resolve, reject) => {
                      try {
                        if (myToken.aborted) return reject(new Error('upload aborted'));
                        const xhr = new XMLHttpRequest();
                        xhr.open('POST', '/api/media');
                        xhr.timeout = 180000;
                        if (socketToken) xhr.setRequestHeader('authorization', `Bearer ${socketToken}`);
                        try { xhr.setRequestHeader('content-type', (blob.type && blob.type.length > 0) ? blob.type : 'application/octet-stream'); } catch {}
                        currentUploadXhrRef.current = xhr;
                        xhr.upload.onprogress = (ev) => {
                          if (currentUploadTokenRef.current?.id !== myToken.id || myToken.aborted) return;
                          if (ev.lengthComputable) {
                            const frac = ev.total > 0 ? ev.loaded / ev.total : 0;
                            setImageUploadProgress(frac);
                          } else {
                            setImageUploadProgress(null);
                          }
                        };
                        xhr.onerror = () => reject(new Error('upload failed'));
                        xhr.ontimeout = () => reject(new Error('upload timeout'));
                        xhr.onabort = () => reject(new Error('upload aborted'));
                        xhr.onload = () => {
                          try {
                            if (xhr.status < 200 || xhr.status >= 300) {
                              try {
                                const j = JSON.parse(xhr.responseText);
                                if (j && j.error) return reject(new Error(String(j.error)));
                              } catch {}
                              return reject(new Error(`upload failed (${xhr.status})`));
                            }
                            const j = JSON.parse(xhr.responseText);
                            resolve(String(j.path || j.url));
                          } catch {
                            reject(new Error('upload parse failed'));
                          }
                        };
                        xhr.onloadend = () => { if (currentUploadTokenRef.current?.id === myToken.id && !myToken.aborted) setImageUploadProgress(1); };
                        xhr.send(blob);
                      } catch (err) {
                        reject(err instanceof Error ? err : new Error('upload error'));
                      }
                    });
                    try {
                      const maxAttempts = 3;
                      let lastErr: unknown = null;
                      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                        try {
                          if (myToken.aborted) throw new Error('upload aborted');
                          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                            await new Promise<void>((resolve) => {
                              const onVis = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVis); resolve(); } };
                              document.addEventListener('visibilitychange', onVis);
                            });
                          }
                          const res = await doUploadRaw();
                          return res;
                        } catch (e) {
                          lastErr = e;
                          const msg = (e as Error)?.message || '';
                          if (myToken.aborted) break;
                          if (/413|too large/i.test(msg)) break;
                          if (attempt < maxAttempts) {
                            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                              await new Promise<void>((resolve) => {
                                const onVis = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVis); resolve(); } };
                                document.addEventListener('visibilitychange', onVis);
                              });
                            } else {
                              const delay = 400 * attempt;  
                              await new Promise(r => setTimeout(r, delay));
                            }
                            continue;
                          }
                          break;
                        }
                      }
                      throw lastErr instanceof Error ? lastErr : new Error('upload failed');
                    } finally {
                    if (currentUploadTokenRef.current?.id === myToken.id) {
                      setImageUploading(false);
                      setImageUploadProgress(null);
                      currentUploadXhrRef.current = null;
                      currentUploadTokenRef.current = null;
                    }
                    }
                  };
                  if (isVideo) {
                    const key = await sha256Hex(buf);
                    try {
                      setMediaPhase('lookup');
                      const res = await fetch(`/api/media/lookup?hash=${key}`, { headers: apiAuthorizationHeaders });
                      if (res.ok) {
                        const j = await res.json();
                        const mediaUrl = typeof j?.path === 'string' ? j.path : j?.url;
                        if (j?.exists && typeof mediaUrl === 'string') {
                          pendingImageRef.current = { src: mediaUrl, naturalW: 640, naturalH: 360, kind: 'video' };
                          recentMediaRef.current.set(key, { url: mediaUrl, kind: 'video', w: 640, h: 360, contentType: j.contentType || (file.type || 'video/mp4') });
                          ensurePreviewAtCursor();
                          setPreviewPreparing(false); setMediaPhase(null); mediaBusyRef.current = false;
                          return;
                        }
                      }
                    } catch {}
                    const cached = recentMediaRef.current.get(key);
                    if (cached && cached.kind === 'video') {
                      pendingImageRef.current = { src: cached.url, naturalW: cached.w, naturalH: cached.h, kind: 'video' };
                      ensurePreviewAtCursor();
                      setPreviewPreparing(false); mediaBusyRef.current = false;
                      return;
                    }
                    const blob = new Blob([buf], { type: file.type || 'application/octet-stream' });
                    const url = await upload(blob);
                    setMediaProcessing(true); mediaBusyRef.current = true;
                    setPreviewPreparing(true); setMediaPhase('process');
                    try {
                      const vid = document.createElement('video');
                      const revoke = () => { try { URL.revokeObjectURL(vid.src); } catch {} };
                      const done = () => { setMediaProcessing(false); setMediaBusyFalse(); };
                      await new Promise<{ w: number; h: number }>((resolve, reject) => {
                        const tm = window.setTimeout(() => { reject(new Error('video probe timeout')); }, 15000);
                        vid.preload = 'metadata';
                        vid.onloadedmetadata = () => { window.clearTimeout(tm); resolve({ w: vid.videoWidth || 640, h: vid.videoHeight || 360 }); };
                        vid.onerror = () => { window.clearTimeout(tm); reject(new Error('video error')); };
                        vid.src = URL.createObjectURL(blob);
                      }).then(dims => {
                        pendingImageRef.current = { src: url, naturalW: dims.w, naturalH: dims.h, kind: 'video' };
                        recentMediaRef.current.set(key, { url, kind: 'video', w: dims.w, h: dims.h, contentType: file.type || 'video/mp4' });
                      }).catch(() => {
                        pendingImageRef.current = { src: url, naturalW: 640, naturalH: 360, kind: 'video' };
                        recentMediaRef.current.set(key, { url, kind: 'video', w: 640, h: 360, contentType: file.type || 'video/mp4' });
                      }).finally(() => { revoke(); done(); setPreviewPreparing(false); setMediaPhase(null); ensurePreviewAtCursor(); });
                    } catch {
                      setMediaProcessing(false); mediaBusyRef.current = false;
                      pendingImageRef.current = { src: url, naturalW: 640, naturalH: 360, kind: 'video' };
                      recentMediaRef.current.set(key, { url, kind: 'video', w: 640, h: 360, contentType: file.type || 'video/mp4' });
                      setPreviewPreparing(false); setMediaPhase(null);
                      ensurePreviewAtCursor();
                    }
                  } else if (animated) {
                    const key = await sha256Hex(buf);
                    try {
                      setMediaPhase('lookup');
                      const res = await fetch(`/api/media/lookup?hash=${key}`, { headers: apiAuthorizationHeaders });
                      if (res.ok) {
                        const j = await res.json();
                        const mediaUrl = typeof j?.path === 'string' ? j.path : j?.url;
                        if (j?.exists && typeof mediaUrl === 'string') {
                          let dims = { w: 640, h: 360 };
                          try {
                            dims = await new Promise<{ w: number; h: number }>((resolve, reject) => { const im = new Image(); im.onload = () => resolve({ w: im.naturalWidth || 100, h: im.naturalHeight || 100 }); im.onerror = reject; im.src = normalizeMediaSrc(mediaUrl); });
                          } catch {}
                          const animatedLookup = animated || looksAnimatedImage(mediaUrl, j.contentType);
                          pendingImageRef.current = { src: mediaUrl, naturalW: dims.w, naturalH: dims.h, kind: 'image', animated: animatedLookup };
                          recentMediaRef.current.set(key, { url: mediaUrl, kind: 'image', w: dims.w, h: dims.h, contentType: j.contentType || (file.type || 'image/png'), animated: animatedLookup });
                          ensurePreviewAtCursor();
                          setPreviewPreparing(false); setMediaPhase(null); mediaBusyRef.current = false;
                          return;
                        }
                      }
                    } catch {}
                    const cached = recentMediaRef.current.get(key);
                    if (cached && cached.kind === 'image') {
                      pendingImageRef.current = { src: cached.url, naturalW: cached.w, naturalH: cached.h, kind: 'image', animated: cached.animated };
                      ensurePreviewAtCursor();
                      setPreviewPreparing(false); mediaBusyRef.current = false;
                      return;
                    }
                    const blob = new Blob([buf], { type: file.type || 'application/octet-stream' });
                    const url = await upload(blob);
                    setMediaProcessing(true); mediaBusyRef.current = true;
                    setPreviewPreparing(true); setMediaPhase('process');
                    const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
                      const im = new Image();
                      im.onload = () => resolve({ w: im.naturalWidth || 100, h: im.naturalHeight || 100 });
                      im.onerror = reject;
                      im.src = URL.createObjectURL(blob);
                    }).catch(() => ({ w: 640, h: 360 })).finally(() => { setMediaProcessing(false); mediaBusyRef.current = false; });
                    pendingImageRef.current = { src: url, naturalW: dims.w, naturalH: dims.h, kind: 'image', animated };
                    recentMediaRef.current.set(key, { url, kind: 'image', w: dims.w, h: dims.h, contentType: file.type || 'image/png', animated });
                    try {
                      setMediaPhase('preview');
                      await new Promise<void>((resolve, reject) => {
                        const test = new Image();
                        test.onload = () => resolve();
                        test.onerror = reject;
                        test.src = normalizeMediaSrc(url);
                      });
                    } catch {}
                    setPreviewPreparing(false); setMediaPhase(null);
                    ensurePreviewAtCursor();
                  } else {
                    const key = await sha256Hex(buf);
                    try {
                      setMediaPhase('lookup');
                      const res = await fetch(`/api/media/lookup?hash=${key}`, { headers: apiAuthorizationHeaders });
                      if (res.ok) {
                        const j = await res.json();
                        const mediaUrl = typeof j?.path === 'string' ? j.path : j?.url;
                        if (j?.exists && typeof mediaUrl === 'string') {
                          let dims = { w: 640, h: 360 };
                          try {
                            dims = await new Promise<{ w: number; h: number }>((resolve, reject) => { const im = new Image(); im.onload = () => resolve({ w: im.naturalWidth || 100, h: im.naturalHeight || 100 }); im.onerror = reject; im.src = normalizeMediaSrc(mediaUrl); });
                          } catch {}
                          const animatedLookup = animated || looksAnimatedImage(mediaUrl, j.contentType);
                          pendingImageRef.current = { src: mediaUrl, naturalW: dims.w, naturalH: dims.h, kind: 'image', animated: animatedLookup };
                          recentMediaRef.current.set(key, { url: mediaUrl, kind: 'image', w: dims.w, h: dims.h, contentType: j.contentType || ((file.type || '').toLowerCase().includes('png') ? 'image/png' : 'image/jpeg'), animated: animatedLookup });
                          setPreviewPreparing(false); setMediaPhase(null); mediaBusyRef.current = false;
                          ensurePreviewAtCursor();
                          return;
                        }
                      }
                    } catch {}
                    const cached = recentMediaRef.current.get(key);
                    if (cached && cached.kind === 'image') {
                      pendingImageRef.current = { src: cached.url, naturalW: cached.w, naturalH: cached.h, kind: 'image', animated: cached.animated };
                      if (!imagePreviewRef.current) imagePreviewRef.current = { x: (selfPos.current?.x ?? 0.5), y: (selfPos.current?.y ?? 0.5), scale: 1 };
                      setPreviewPreparing(false); setMediaPhase(null); mediaBusyRef.current = false;
                      return;
                    }
                    const origBlob = new Blob([buf], { type: file.type || 'application/octet-stream' });
                    let w = 640, h = 360;  
                    let outBlob: Blob | null = null;
                    try {
                      const dataUrl = await new Promise<string>(res => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(origBlob); });
                      const img = await new Promise<HTMLImageElement>((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = dataUrl; });
                      const MAX_W = 1920, MAX_H = 1080;
                      w = Math.max(1, img.naturalWidth || w);
                      h = Math.max(1, img.naturalHeight || h);
                      const scale = Math.min(1, MAX_W / Math.max(1, w), MAX_H / Math.max(1, h));
                      w = Math.max(1, Math.floor(w * scale));
                      h = Math.max(1, Math.floor(h * scale));
                      const canvas = document.createElement('canvas');
                      canvas.width = w; canvas.height = h;
                      const ctx = canvas.getContext('2d');
                      if (!ctx) throw new Error('no canvas');
                      ctx.drawImage(img, 0, 0, w, h);
                      const mime = (file.type || '').toLowerCase().includes('png') ? 'image/png' : 'image/jpeg';
                      const quality = mime === 'image/jpeg' ? 0.75 : 0.92;
                      const toBlob = (m: string, q?: number) => new Promise<Blob | null>(res => canvas.toBlob(b => res(b), m, q));
                      let tmp = await toBlob(mime, quality);
                      if (!tmp) throw new Error('encode failed');
                      if (tmp.size > 10 * 1024 * 1024 && mime === 'image/jpeg') {
                        const tmp2 = await toBlob('image/jpeg', 0.6);
                        if (tmp2) tmp = tmp2;
                      }
                      outBlob = tmp;
                    } catch {
                      outBlob = origBlob;
                    }
                    const url = await upload(outBlob);
                    setPreviewPreparing(true); setMediaPhase('preview');
                    try {
                      await new Promise<void>((resolve, reject) => {
                        const test = new Image();
                        test.onload = () => resolve();
                        test.onerror = reject;
                        test.src = normalizeMediaSrc(url);
                      });
                    } catch {}
                    pendingImageRef.current = { src: url, naturalW: w, naturalH: h, kind: 'image', animated };
                    recentMediaRef.current.set(key, { url, kind: 'image', w, h, contentType: (file.type || '').toLowerCase().includes('png') ? 'image/png' : 'image/jpeg', animated });
                    setPreviewPreparing(false); setMediaPhase(null);
                    ensurePreviewAtCursor();
                  }
                }}
              />
              <p className="text-[11px] opacity-75 mt-1">After choosing media, click the board to place it while preserving its aspect ratio.</p>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Tip</label>
              <p className="text-[11px] opacity-75">Place the media and switch to Select to adjust filters and rotation.</p>
            </div>
          </div>
        </div>
      )}
      { }
  {tool === "select" && selectedImageId && !selectedTextId && (() => {
        const im = committedImagesRef.current.get(selectedImageId) || null;
        if (!im) return null;
        return (
          <div className="absolute top-1/2 -translate-y-1/2 right-4 z-30 w-[24rem]" onPointerDown={e => e.stopPropagation()}>
            <div className="rounded-2xl border border-slate-200/70 bg-white/95 px-5 py-4 text-slate-900 shadow-2xl backdrop-blur" data-ui-panel>
              <div className="mb-4 flex items-center justify-between">
                <span className="text-sm font-semibold tracking-wide text-slate-700">Media</span>
                <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Settings</span>
              </div>
              <div className="space-y-4 text-xs text-slate-600">
                <div className="grid grid-cols-2 gap-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <div>
                    <div>Type</div>
                    <div className="text-sm font-semibold normal-case tracking-normal text-slate-600">{im.mediaKind === 'video' ? 'Video' : 'Image'}</div>
                  </div>
                  <div>
                    <div>Dimensions</div>
                    <div className="text-sm font-semibold normal-case tracking-normal text-slate-600">{Math.round(im.width * BOARD_W)} × {Math.round(im.height * BOARD_H)} px</div>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Filter</label>
                  <select
                    value={im.filter ?? "none"}
                    onChange={e => {
                      const cur = committedImagesRef.current.get(selectedImageId);
                      if (!cur) return;
                      const filter = e.target.value;
                      const next = { ...cur, filter };
                      committedImagesRef.current.set(selectedImageId, next);
                      const upd: ImageUpdateEvent = { type: "image_update", id, imageId: selectedImageId, filter, strokeId: cur.strokeId };
                      sendCritical(upd); historyRef.current.push(upd); forceTick(t => t + 1);
                    }}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
                  >
                    {Object.keys(IMAGE_FILTERS).map(k => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </div>
                {(() => {
                  const sid = selectedImageId as string;
                  const cur = imageChromaKeyStateRef.current.get(sid) ?? { enabled: false, color: '#00ff00', tolerance: 80, feather: 20, spill: 40 };
                  imageChromaKeyStateRef.current.set(sid, cur);
                  const setEnabled = (enabled: boolean) => {
                    const now = { ...cur, enabled } as ImageChromaKeyState;
                    imageChromaKeyStateRef.current.set(sid, now);
                    const base = committedImagesRef.current.get(sid);
                    const upd: ImageUpdateEvent = { type: 'image_update', id, imageId: sid, strokeId: base?.strokeId, chromaKeyEnabled: enabled };
                    sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1);
                  };
                  return (
                    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                      <label className="flex items-center justify-between text-xs font-medium text-slate-500">
                        <span className="flex items-center gap-2">
                          <input type="checkbox" checked={!!cur.enabled} onChange={e => setEnabled(e.target.checked)} className="accent-slate-900" />
                          <span>Chroma Key</span>
                        </span>
                        <button
                          type="button"
                          className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed"
                          onClick={() => setChromaKeyEditTarget(sid)}
                          disabled={!cur.enabled}
                        >
                          Edit
                        </button>
                      </label>
                      {cur.enabled && (
                        <p className="text-[11px] text-slate-500">Use the color picker for precise adjustments.</p>
                      )}
                    </div>
                  );
                })()}
                {(im.filter ?? "none") === "rainbow" && (
                  <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Rainbow settings</div>
                    {(() => {
                      const cur = imageChromaStateRef.current.get(selectedImageId) ?? { speed: 120, saturation: 180, lightness: 100 };
                      imageChromaStateRef.current.set(selectedImageId, cur);
                      return (
                        <>
                          <div>
                            <label className="text-xs font-medium text-slate-500">Speed: {cur.speed}°/s</label>
                            <input
                              type="range"
                              min={10}
                              max={720}
                              value={cur.speed}
                              onChange={e => {
                                const st = imageChromaStateRef.current.get(selectedImageId)!; st.speed = Number(e.target.value);
                                imageChromaStateRef.current.set(selectedImageId, st);
                                const curImg = committedImagesRef.current.get(selectedImageId);
                                const upd: ImageUpdateEvent = { type: "image_update", id, imageId: selectedImageId, strokeId: curImg?.strokeId, chromaSpeed: st.speed };
                                sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1);
                              }}
                              className="mt-1 w-full accent-slate-900"
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-slate-500">Doygunluk: {cur.saturation}%</label>
                            <input
                              type="range"
                              min={0}
                              max={300}
                              value={cur.saturation}
                              onChange={e => {
                                const st = imageChromaStateRef.current.get(selectedImageId)!; st.saturation = Number(e.target.value);
                                imageChromaStateRef.current.set(selectedImageId, st);
                                const curImg = committedImagesRef.current.get(selectedImageId);
                                const upd: ImageUpdateEvent = { type: "image_update", id, imageId: selectedImageId, strokeId: curImg?.strokeId, chromaSaturation: st.saturation };
                                sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1);
                              }}
                              className="mt-1 w-full accent-slate-900"
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-slate-500">Lightness: {cur.lightness}%</label>
                            <input
                              type="range"
                              min={0}
                              max={200}
                              value={cur.lightness}
                              onChange={e => {
                                const st = imageChromaStateRef.current.get(selectedImageId)!; st.lightness = Number(e.target.value);
                                imageChromaStateRef.current.set(selectedImageId, st);
                                const curImg = committedImagesRef.current.get(selectedImageId);
                                const upd: ImageUpdateEvent = { type: "image_update", id, imageId: selectedImageId, strokeId: curImg?.strokeId, chromaLightness: st.lightness };
                                sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1);
                              }}
                              className="mt-1 w-full accent-slate-900"
                            />
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
                <div className="space-y-3">
                  <label className="flex items-center gap-2 text-xs font-medium text-slate-500">
                    <input
                      id="dvd-toggle-image"
                      type="checkbox"
                      checked={!!dvdImageStateRef.current.get(selectedImageId)?.enabled}
                      onChange={e => {
                        const st = ensureDvdState("image", selectedImageId);
                        st.enabled = e.target.checked;
                        st.lastSent = 0;
                        st.controlled = true;
                        dvdImageStateRef.current.set(selectedImageId, st);
                        const cur = committedImagesRef.current.get(selectedImageId);
                        const upd: ImageUpdateEvent = { type: "image_update", id, imageId: selectedImageId, dvdEnabled: st.enabled, dvdSpeed: st.speed, dvdVx: st.vx, dvdVy: st.vy, strokeId: cur?.strokeId };
                        sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent);
                        forceTick(t => t + 1);
                      }}
                      className="accent-slate-900"
                    />
                    <span>DVD mode</span>
                  </label>
                  {dvdImageStateRef.current.get(selectedImageId)?.enabled && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                      <label className="text-xs font-medium text-slate-500">Speed: {Math.round((dvdImageStateRef.current.get(selectedImageId)?.speed ?? 240))} px/s</label>
                      <input
                        type="range"
                        min={40}
                        max={1200}
                        value={dvdImageStateRef.current.get(selectedImageId)?.speed ?? 240}
                        onChange={e => {
                          const st = ensureDvdState("image", selectedImageId);
                          const sp = Number(e.target.value);
                          st.speed = sp;
                          const ang = Math.atan2(st.vy * BOARD_H, st.vx * BOARD_W);
                          st.vx = Math.cos(ang) * (sp / BOARD_W);
                          st.vy = Math.sin(ang) * (sp / BOARD_H);
                          dvdImageStateRef.current.set(selectedImageId, st);
                          st.controlled = true;
                          const cur = committedImagesRef.current.get(selectedImageId);
                          const upd: ImageUpdateEvent = { type: "image_update", id, imageId: selectedImageId, dvdSpeed: st.speed, dvdVx: st.vx, dvdVy: st.vy, strokeId: cur?.strokeId };
                          sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent);
                          forceTick(t => t + 1);
                        }}
                        className="mt-2 w-full accent-slate-900"
                      />
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(["x", "y", "z"] as const).map(axis => (
                    <div key={axis}>
                      <label className="text-xs font-medium text-slate-500">Rot {axis.toUpperCase()}</label>
                      <input
                        type="range"
                        min={-180}
                        max={180}
                        value={(axis === "x" ? im.rotX : axis === "y" ? im.rotY : im.rotZ) ?? 0}
                        onChange={e => {
                          const cur = committedImagesRef.current.get(selectedImageId);
                          if (!cur) return;
                          const value = Number(e.target.value);
                          const key = axis === "x" ? "rotX" : axis === "y" ? "rotY" : "rotZ";
                          const next = { ...cur, [key]: value } as typeof cur;
                          committedImagesRef.current.set(selectedImageId, next);
                          const upd: ImageUpdateEvent = { type: "image_update", id, imageId: selectedImageId, [key]: value, strokeId: cur.strokeId } as ImageUpdateEvent;
                          sendCritical(upd); historyRef.current.push(upd); forceTick(t => t + 1);
                        }}
                        className="mt-1 w-full accent-slate-900"
                      />
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-1 text-[11px] font-medium text-slate-500">
                        <button
                          type="button"
                          className="rounded-lg border border-slate-200 px-2 py-1 text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
                          onClick={() => {
                            const cur = committedImagesRef.current.get(selectedImageId); if (!cur) return;
                            const key = axis === "x" ? "rotX" : axis === "y" ? "rotY" : "rotZ";
                            const reset = { ...cur, [key]: 0 } as typeof cur;
                            committedImagesRef.current.set(selectedImageId, reset);
                            const upd: ImageUpdateEvent = { type: "image_update", id, imageId: selectedImageId, [key]: 0, strokeId: cur.strokeId } as ImageUpdateEvent;
                            sendCritical(upd); historyRef.current.push(upd); forceTick(t => t + 1);
                          }}
                        >
                          Reset
                        </button>
                        <label className="inline-flex items-center gap-1 whitespace-nowrap">
                          <input
                            type="checkbox"
                            checked={!!rotImageStateRef.current.get(selectedImageId)?.[axis].enabled}
                            onChange={e => {
                              const st = ensureRotState("image", selectedImageId);
                              st[axis].enabled = e.target.checked;
                              st.controlled = true;
                              rotImageStateRef.current.set(selectedImageId, st);
                              const cur = committedImagesRef.current.get(selectedImageId);
                              const animField = axis === "x" ? "rotXAnimEnabled" : axis === "y" ? "rotYAnimEnabled" : "rotZAnimEnabled";
                              const speedField = axis === "x" ? "rotXAnimSpeed" : axis === "y" ? "rotYAnimSpeed" : "rotZAnimSpeed";
                              const minField = axis === "x" ? "rotXAnimMin" : axis === "y" ? "rotYAnimMin" : "rotZAnimMin";
                              const maxField = axis === "x" ? "rotXAnimMax" : axis === "y" ? "rotYAnimMax" : "rotZAnimMax";
                              const dirField = axis === "x" ? "rotXAnimDir" : axis === "y" ? "rotYAnimDir" : "rotZAnimDir";
                              const upd: ImageUpdateEvent = {
                                type: "image_update",
                                id,
                                imageId: selectedImageId,
                                [animField]: st[axis].enabled,
                                [speedField]: st[axis].speed,
                                [minField]: st[axis].min,
                                [maxField]: st[axis].max,
                                [dirField]: st[axis].dir,
                                strokeId: cur?.strokeId,
                              } as ImageUpdateEvent;
                              sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1);
                            }}
                            className="accent-slate-900"
                          />
                          <span>Rotation animation</span>
                        </label>
                        <label className="inline-flex items-center gap-1 whitespace-nowrap ml-2">
                          <input
                            type="checkbox"
                            checked={rotImageStateRef.current.get(selectedImageId)?.[axis].dir === -1}
                            onChange={e => {
                              const st = ensureRotState("image", selectedImageId);
                              st[axis].dir = e.target.checked ? -1 : 1;
                              st.controlled = true;
                              rotImageStateRef.current.set(selectedImageId, st);
                              const cur = committedImagesRef.current.get(selectedImageId);
                              const dirField = axis === "x" ? "rotXAnimDir" : axis === "y" ? "rotYAnimDir" : "rotZAnimDir";
                              const upd: ImageUpdateEvent = {
                                type: "image_update",
                                id,
                                imageId: selectedImageId,
                                [dirField]: st[axis].dir,
                                strokeId: cur?.strokeId,
                              } as ImageUpdateEvent;
                              sendCritical(upd); historyRef.current.push(upd as unknown as HistoryEvent); forceTick(t => t + 1);
                            }}
                            className="accent-slate-900"
                          />
                          <span>Reverse direction</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="pt-2" style={{ borderTop: `1px solid ${themePalette.panelDivider}` }}>
                  <button
                    type="button"
                    onClick={deleteSelected}
                    className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition active:scale-[0.98]"
                    style={{
                      backgroundColor: isDarkTheme ? 'rgba(239, 68, 68, 0.15)' : 'rgba(254, 226, 226, 1)',
                      color: isDarkTheme ? '#fca5a5' : '#dc2626',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.backgroundColor = isDarkTheme ? 'rgba(239, 68, 68, 0.25)' : 'rgba(254, 202, 202, 1)';
                      e.currentTarget.style.color = isDarkTheme ? '#fecaca' : '#b91c1c';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.backgroundColor = isDarkTheme ? 'rgba(239, 68, 68, 0.15)' : 'rgba(254, 226, 226, 1)';
                      e.currentTarget.style.color = isDarkTheme ? '#fca5a5' : '#dc2626';
                    }}
                  >
                  Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      { }
  {!readOnly && (
  <input
        ref={textInputRef}
        type="text"
        value={textInputValue}
        onChange={e => {
          const v = e.target.value;
          setTextInputValue(v);
          sendTextImmediate(v);
        }}
        onKeyDown={e => {
          if (e.key === "Enter") {
            const cur = curTextRef2.current;
            const currentVal = (e.currentTarget as HTMLInputElement).value;
            if (cur) {
              sendTextImmediate(currentVal);
              const nextY = Math.min(1, cur.y + (1.5 * cur.size) / BOARD_H);
              const newTextId = `${id}-txt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              const newStrokeId = `${id}-text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              const outlineClone = cloneTextOutline(cur.outline, textOutline);
              curTextRef2.current = { textId: newTextId, strokeId: newStrokeId, x: cur.x, y: nextY, size: cur.size, color: cur.color, font: cur.font, outline: outlineClone, lastSent: 0, committed: false };
              setSelectedTextId(newTextId);
              setSelectedImageId(null);
              setTextInputValue("");
              const container = containerRef.current;
              if (container) {
                const crect = container.getBoundingClientRect();
                const screen = boardNormToScreen(cur.x, nextY);
                const px = screen.x - crect.left;
                const py = screen.y - crect.top;
                const clientW = crect.width;
                let left = px;
                if (left + textInputUi.current.width > clientW - 10) left = Math.max(60, clientW - textInputUi.current.width - 10);
                textInputUi.current.left = left;
                textInputUi.current.top = Math.max(0, py - cur.size - 8);
              }
              requestAnimationFrame(() => textInputRef.current?.focus());
            }
            e.preventDefault();
          } else if (e.key === "Escape") {
            setTextInputActive(false);
            curTextRef2.current = null;
            e.preventDefault();
          }
        }}
        onBlur={() => { setTextInputActive(false); curTextRef2.current = null; }}
        style={{
          position: "absolute",
          display: textInputActive ? "block" : "none",
          top: textInputUi.current.top,
          left: textInputUi.current.left,
          width: textInputUi.current.width,
          zIndex: 60,
          backgroundColor: "#fff",
          color: textChroma.enabled ? chromaColor(textChroma) : "#555",
          border: "1px solid rgba(0,0,0,0.2)",
          borderRadius: 4,
          padding: "6px 10px",
          boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
        } as React.CSSProperties}
        id="textToolInput"
        autoComplete="off"
      />
      )}
      { }

      {contextMenu && !readOnly && (        <div
          className="fixed inset-0 z-[9999]"
          onPointerDown={() => setContextMenu(null)}
          onContextMenu={e => { e.preventDefault(); setContextMenu(null); }}
        >
          <div
            className="absolute bg-slate-800 text-white rounded shadow-lg flex flex-col py-1"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={e => e.stopPropagation()}
          >
            {[
              { label: "Bring to front", action: 'front' },
              { label: "Send to back", action: 'back' }
            ].map(btn => (
              <button
                key={btn.label}
                className="px-4 py-2 text-left hover:bg-slate-700 text-sm"
                onClick={() => {
                  const isImage = contextMenu.type === "image";
                  const allItems = [...committedImagesRef.current.values(), ...committedTextsRef.current.values()] as Array<CommittedImage | CommittedText>;
                  const target = allItems.find(c => ('imageId' in c ? c.imageId : c.textId) === contextMenu.id);
                  if (target) {
                    const currentZ = target.zIndex || (isImage ? 14 : 20);
                    const allZ = allItems.map(c => c.zIndex || ('imageId' in c ? 14 : 20));
                    let newZ = currentZ;

                    if (btn.action === 'front') {
                      newZ = Math.max(...allZ, currentZ) + 1;
                    } else if (btn.action === 'back') {
                      newZ = Math.min(...allZ, currentZ) - 1;
                    }

                    if (newZ !== currentZ) {
                      if (isImage) {
                        const upd: ImageUpdateEvent = { type: "image_update", id: Math.random().toString(36).slice(2), imageId: contextMenu.id, zIndex: newZ };
                        sendCritical(upd);
                        historyRef.current.push(upd as unknown as HistoryEvent);
                        const cur = committedImagesRef.current.get(contextMenu.id);
                        if (cur) {
                          committedImagesRef.current.set(contextMenu.id, { ...cur, zIndex: newZ });
                        }
                        forceTick(t => t + 1);
                      } else {
                        const upd: TextUpdateEvent = { type: "text_update", id: Math.random().toString(36).slice(2), textId: contextMenu.id, zIndex: newZ };
                        sendCritical(upd);
                        historyRef.current.push(upd as unknown as HistoryEvent);
                        const cur = committedTextsRef.current.get(contextMenu.id);
                        if (cur) {
                          committedTextsRef.current.set(contextMenu.id, { ...cur, zIndex: newZ });
                        }
                        forceTick(t => t + 1);
                      }
                    }
                  }
                  setContextMenu(null);
                }}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
