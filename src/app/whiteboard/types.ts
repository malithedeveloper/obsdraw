export type Tool = "select" | "pen" | "eraser" | "text" | "media" | "hand";
export type LatencyStats = {
  pingMs: number | null;
  avgPingMs: number | null;
  upstreamMs: number | null;
  downstreamMs: number | null;
  serverProcessMs: number | null;
  sendPending: number;
  sendBacklogMs: number;
  receiveGapMs: number;
  bufferedEvents: number;
};
export type ChromaConfig = {
  enabled: boolean;
  speed: number;  
  saturation: number;  
  lightness: number;  
  startAt: number;  
};
export type TextOutlineConfig = {
  enabled: boolean;
  color: string;
  width: number;  
  feather: number;  
  chroma?: ChromaConfig;
};
export type CursorPayload = {
  type: "cursor";
  id: string;
  name: string;
  x: number;  
  y: number;  
  tool?: Tool;
  size?: number;
};
export type StrokePayload = {
  type: "stroke";
  id: string;
  color: string;
  size: number;
  phase: "start" | "draw" | "end";
  x: number;  
  y: number;  
  mode: "draw" | "erase";
  strokeId: string;
};
export type UndoRedoPayload = { type: "undo" | "redo"; by: string; strokeId: string };
export type TextLivePayload = {
  type: "text_live";
  id: string;
  textId: string;
  text: string;
  x: number;
  y: number;
  color: string;
  size: number;
  font: string;
  width?: number;
  height?: number;
  outline?: TextOutlineConfig;
  zIndex?: number;
};
export type TextCommitEvent = {
  type: "text_commit";
  id: string;
  textId: string;
  text: string;
  x: number;
  y: number;
  color: string;
  size: number;
  font: string;
  strokeId: string;
  width?: number;
  height?: number;
  chroma?: ChromaConfig;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  outline?: TextOutlineConfig;
  zIndex?: number;
};
export type TextUpdateEvent = {
  type: "text_update";
  id: string;
  textId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  color?: string;
  size?: number;
  font?: string;
  strokeId?: string;
  chroma?: ChromaConfig;
  outline?: TextOutlineConfig;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  dvdEnabled?: boolean;
  dvdSpeed?: number;
  dvdVx?: number;  
  dvdVy?: number;  
  rotXAnimEnabled?: boolean;
  rotXAnimSpeed?: number;
  rotXAnimMin?: number;
  rotXAnimMax?: number;
  rotXAnimDir?: 1 | -1;
  rotYAnimEnabled?: boolean;
  rotYAnimSpeed?: number;
  rotYAnimMin?: number;
  rotYAnimMax?: number;
  rotYAnimDir?: 1 | -1;
  rotZAnimEnabled?: boolean;
  rotZAnimSpeed?: number;
  rotZAnimMin?: number;
  rotZAnimMax?: number;
  rotZAnimDir?: 1 | -1;
  zIndex?: number;
};
export type ImageCommitEvent = {
  type: "image_commit";
  id: string;
  imageId: string;
  src: string;  
  x: number;  
  y: number;  
  width: number;  
  height: number;  
  strokeId: string;
  filter?: string;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  mediaKind?: "image" | "video";
  animated?: boolean;
  origin?: "link" | "upload";
  zIndex?: number;
};
export type ImageUpdateEvent = {
  type: "image_update";
  id: string;
  imageId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  strokeId?: string;
  filter?: string;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  dvdEnabled?: boolean;
  dvdSpeed?: number;
  dvdVx?: number;  
  dvdVy?: number;  
  rotXAnimEnabled?: boolean;
  rotXAnimSpeed?: number;
  rotXAnimMin?: number;
  rotXAnimMax?: number;
  rotXAnimDir?: 1 | -1;
  rotYAnimEnabled?: boolean;
  rotYAnimSpeed?: number;
  rotYAnimMin?: number;
  rotYAnimMax?: number;
  rotYAnimDir?: 1 | -1;
  rotZAnimEnabled?: boolean;
  rotZAnimSpeed?: number;
  rotZAnimMin?: number;
  rotZAnimMax?: number;
  rotZAnimDir?: 1 | -1;
  chromaSpeed?: number;
  chromaSaturation?: number;
  chromaLightness?: number;
  chromaKeyEnabled?: boolean;  
  chromaKeyColor?: string;  
  chromaKeyTolerance?: number;  
  chromaKeyFeather?: number;  
  chromaKeySpill?: number;
  zIndex?: number;
};
export type HistoryEvent = StrokePayload | TextCommitEvent | TextUpdateEvent | ImageCommitEvent | ImageUpdateEvent;
export type SnapshotMessage = { type: "snapshot"; events: string[] };
export type SnapshotMeta = { type: "snapshot_meta"; totalEvents: number; totalChunks: number };
export type SnapshotChunk = { type: "snapshot_chunk"; index: number; total: number; events: string[] };
type SnapshotDone = { type: "snapshot_done" };
export type PingPayload = {
  type: "ping";
  id?: string;
  name?: string;
  fp?: { v: number; c: number; u: number; h: number };
  seq?: number;
  clientTs?: number;
  serverTs?: number;
  processMs?: number;
};
export type AnimControlPayload = { type: "anim_control"; id: string; entity: "text" | "image"; targetId: string; dvdPaused?: boolean };
export type FontCycleControlPayload = { type: "font_cycle_control"; id: string; targetId: string; enabled?: boolean; ms?: number };
export type DriftReply = {
  type: "drift_reply";
  for: string;  
  server: {
    fp: { v: number; c: number; u: number; h: number };
    keys: string[];
    totalPersisted: number;
    source: "r2" | "webdav" | "local" | "unknown";
  };
  note?: string;
  analysis?: {
    compare: {
      clientCount: number;
      serverCount: number;
      lastCommonSuffix: number;  
      clientFirstDiff?: string;
      serverFirstDiff?: string;
    };
  };
};
export type ChatMessage = { type: "chat"; id: string; name: string; text: string; ts: number; mid: string };
type TypingMessage = { type: "typing"; id: string; name: string; typing: boolean };
export type PresenceMessage =
  | { type: "presence"; kind: "join" | "leave"; id: string; name: string }
  | { type: "presence"; kind: "roster"; members: { id: string; name: string }[] }
  | { type: "presence"; kind: "quiet" }
  | { type: "presence"; kind: "error"; code: "name_taken" | string; message?: string };
type ServerMessage =
  | CursorPayload
  | StrokePayload
  | UndoRedoPayload
  | TextLivePayload
  | TextCommitEvent
  | TextUpdateEvent
  | ImageCommitEvent
  | ImageUpdateEvent
  | SnapshotMessage
  | PingPayload
  | AnimControlPayload
  | FontCycleControlPayload
  | ChatMessage
  | TypingMessage
  | PresenceMessage;
export type ServerMessage2 = ServerMessage | SnapshotMeta | SnapshotChunk | SnapshotDone | DriftReply;
export type PeerCursor = { name: string; x: number; y: number; lastSeen: number; tool?: Tool; size?: number };
export type TextClip = { text: string; x: number; y: number; width?: number; height?: number; color: string; size: number; font: string; chroma?: ChromaConfig; outline?: TextOutlineConfig; rotX?: number; rotY?: number; rotZ?: number; zIndex?: number; };
export type ImageClip = { src: string; x: number; y: number; width: number; height: number; filter?: string; rotX?: number; rotY?: number; rotZ?: number; mediaKind?: "image" | "video"; animated?: boolean; origin?: "link" | "upload"; zIndex?: number; };
export type ImageHandleKey = "tl" | "tr" | "bl" | "br" | "l" | "r" | "t" | "b";
export type DvdState = {
  enabled: boolean;
  vx: number;
  vy: number;
  speed: number;
  pausedByDrag: boolean;
  lastSent?: number;
  lastSentX?: number;
  lastSentY?: number;
  controlled?: boolean;
};
export type RotAxisState = { enabled: boolean; dir: 1 | -1; speed: number; min: number; max: number };
export type RotAnimState = {
  x: RotAxisState;
  y: RotAxisState;
  z: RotAxisState;
  lastSent?: number;
  lastSentRotX?: number;
  lastSentRotY?: number;
  lastSentRotZ?: number;
  controlled?: boolean;
};
export type CommittedText = {
  textId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text: string;
  color: string;
  size: number;
  font: string;
  strokeId: string;
  chroma?: ChromaConfig;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  outline?: TextOutlineConfig;
  zIndex?: number;
};
export type CommittedImage = {
  imageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
  strokeId: string;
  naturalW?: number;
  naturalH?: number;
  aspect?: number;
  filter?: string;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  mediaKind?: "image" | "video";
  animated?: boolean;
  origin?: "link" | "upload";
  zIndex?: number;
};
export type ImageChromaState = { speed: number; saturation: number; lightness: number };
export type ImageChromaKeyState = { enabled: boolean; color: string; tolerance: number; feather: number; spill: number };
