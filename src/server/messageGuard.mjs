import { isPersistableType, isSafeEntityId } from "./history.mjs";

const EDITOR_MESSAGE_TYPES = new Set([
  "anim_control",
  "chat",
  "cursor",
  "drift_request",
  "font_cycle_control",
  "image_commit",
  "image_update",
  "ping",
  "presence",
  "redo",
  "stroke",
  "text_commit",
  "text_live",
  "text_update",
  "typing",
  "undo",
]);
const VIEWER_MESSAGE_TYPES = new Set(["drift_request", "ping"]);
const SAFE_CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MEDIA_PATH = /^\/api\/media\/(?:[a-f0-9]{24}|[a-f0-9]{64}(?:\.(?:png|jpe?g|gif|webp|avif|mp4|webm))?)$/i;
const IMAGE_FILTERS = new Set(["none", "grayscale", "sepia", "invert", "wash", "punch", "noir", "vintage", "cold", "warm", "pop", "shadow", "rainbow"]);
const TOOLS = new Set(["select", "hand", "pen", "eraser", "text", "media"]);
const MAX_TEXT_LENGTH = 10_000;
const MAX_CHAT_LENGTH = 2_000;
const MAX_MEDIA_SOURCE_LENGTH = 8_192;

const TYPE_FIELDS = {
  anim_control: ["type", "id", "entity", "targetId", "dvdPaused"],
  chat: ["type", "id", "name", "text", "ts", "mid"],
  cursor: ["type", "id", "name", "x", "y", "tool", "size"],
  drift_request: ["type", "id", "name", "mode", "client"],
  font_cycle_control: ["type", "id", "targetId", "enabled", "ms"],
  image_commit: ["type", "id", "imageId", "src", "x", "y", "width", "height", "strokeId", "filter", "rotX", "rotY", "rotZ", "mediaKind", "animated", "origin", "zIndex"],
  image_update: [
    "type", "id", "imageId", "x", "y", "width", "height", "strokeId", "filter", "rotX", "rotY", "rotZ", "zIndex",
    "dvdEnabled", "dvdSpeed", "dvdVx", "dvdVy",
    "rotXAnimEnabled", "rotXAnimSpeed", "rotXAnimMin", "rotXAnimMax", "rotXAnimDir",
    "rotYAnimEnabled", "rotYAnimSpeed", "rotYAnimMin", "rotYAnimMax", "rotYAnimDir",
    "rotZAnimEnabled", "rotZAnimSpeed", "rotZAnimMin", "rotZAnimMax", "rotZAnimDir",
    "chromaSpeed", "chromaSaturation", "chromaLightness",
    "chromaKeyEnabled", "chromaKeyColor", "chromaKeyTolerance", "chromaKeyFeather", "chromaKeySpill",
  ],
  ping: ["type", "id", "name", "fp", "seq", "clientTs"],
  presence: ["type", "kind", "id", "name"],
  redo: ["type", "by", "strokeId"],
  stroke: ["type", "id", "color", "size", "phase", "x", "y", "mode", "strokeId"],
  text_commit: ["type", "id", "textId", "text", "x", "y", "color", "size", "font", "strokeId", "width", "height", "chroma", "rotX", "rotY", "rotZ", "outline", "zIndex"],
  text_live: ["type", "id", "textId", "text", "x", "y", "color", "size", "font", "width", "height", "outline", "zIndex"],
  text_update: [
    "type", "id", "textId", "x", "y", "width", "height", "text", "color", "size", "font", "strokeId", "chroma", "outline", "rotX", "rotY", "rotZ", "zIndex",
    "dvdEnabled", "dvdSpeed", "dvdVx", "dvdVy",
    "rotXAnimEnabled", "rotXAnimSpeed", "rotXAnimMin", "rotXAnimMax", "rotXAnimDir",
    "rotYAnimEnabled", "rotYAnimSpeed", "rotYAnimMin", "rotYAnimMax", "rotYAnimDir",
    "rotZAnimEnabled", "rotZAnimSpeed", "rotZAnimMin", "rotZAnimMax", "rotZAnimDir",
  ],
  typing: ["type", "id", "name", "typing"],
  undo: ["type", "by", "strokeId"],
};

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasSafeShape(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= 1_000_000;
  if (typeof value === "string") return value.length <= MAX_TEXT_LENGTH && !CONTROL_CHARACTERS.test(value);
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((item) => hasSafeShape(item, depth + 1));
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 200 && entries.every(([, item]) => hasSafeShape(item, depth + 1));
}

function pickFields(message) {
  const allowed = TYPE_FIELDS[message.type];
  if (!allowed) return null;
  const result = {};
  for (const field of allowed) {
    if (message[field] !== undefined) result[field] = message[field];
  }
  return result;
}

function validId(value) {
  return typeof value === "string" && SAFE_CLIENT_ID.test(value);
}

function finiteBetween(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function optionalFiniteBetween(value, minimum, maximum) {
  return value === undefined || finiteBetween(value, minimum, maximum);
}

function validPosition(message) {
  return optionalFiniteBetween(message.x, -100, 100) && optionalFiniteBetween(message.y, -100, 100);
}

function validDimensions(message) {
  return optionalFiniteBetween(message.width, 0.00001, 100) && optionalFiniteBetween(message.height, 0.00001, 100);
}

function validMediaSource(value) {
  if (typeof value !== "string" || !value || value.length > MAX_MEDIA_SOURCE_LENGTH) return false;
  if (MEDIA_PATH.test(value)) return true;
  if (/^data:(?:image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm));base64,/i.test(value)) return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateIdentifiers(message) {
  if (message.id !== undefined && !validId(message.id)) return false;
  if (message.targetId !== undefined && !isSafeEntityId(message.targetId)) return false;
  if (message.textId !== undefined && !isSafeEntityId(message.textId)) return false;
  if (message.imageId !== undefined && !isSafeEntityId(message.imageId)) return false;
  if (message.strokeId !== undefined && !isSafeEntityId(message.strokeId)) return false;
  return true;
}

function validateTypeSpecific(message) {
  switch (message.type) {
    case "stroke":
      return validId(message.id) && isSafeEntityId(message.strokeId) && ["start", "draw", "end"].includes(message.phase) &&
        ["draw", "erase"].includes(message.mode) && Number.isFinite(message.x) && Number.isFinite(message.y) &&
        validPosition(message) && finiteBetween(message.size, 0.1, 500);
    case "undo":
    case "redo":
      return isSafeEntityId(message.strokeId);
    case "text_commit":
      return validId(message.id) && isSafeEntityId(message.textId) && isSafeEntityId(message.strokeId) &&
        typeof message.text === "string" && message.text.length <= MAX_TEXT_LENGTH &&
        validPosition(message) && validDimensions(message) && optionalFiniteBetween(message.size, 1, 500);
    case "text_live":
    case "text_update":
      return validId(message.id) && isSafeEntityId(message.textId) &&
        (message.text === undefined || (typeof message.text === "string" && message.text.length <= MAX_TEXT_LENGTH)) &&
        validPosition(message) && validDimensions(message) && optionalFiniteBetween(message.size, 1, 500);
    case "image_commit":
      return validId(message.id) && isSafeEntityId(message.imageId) && isSafeEntityId(message.strokeId) &&
        validMediaSource(message.src) && validPosition(message) && validDimensions(message) &&
        (message.mediaKind === undefined || ["image", "video"].includes(message.mediaKind)) &&
        (message.origin === undefined || ["link", "upload"].includes(message.origin)) &&
        (message.filter === undefined || IMAGE_FILTERS.has(message.filter));
    case "image_update":
      return validId(message.id) && isSafeEntityId(message.imageId) && validPosition(message) && validDimensions(message) &&
        (message.filter === undefined || IMAGE_FILTERS.has(message.filter));
    case "chat":
      return validId(message.id) && typeof message.text === "string" &&
        message.text.trim().length > 0 && message.text.length <= MAX_CHAT_LENGTH;
    case "presence":
      return ["join", "leave", "quiet", "roster"].includes(message.kind) &&
        (!["join", "leave"].includes(message.kind) || validId(message.id));
    case "drift_request":
      return validId(message.id) && isPlainObject(message.client) &&
        (!Array.isArray(message.client.keys) || message.client.keys.length <= 500);
    case "ping":
      return validId(message.id);
    case "cursor":
      return validId(message.id) && validPosition(message) &&
        (message.tool === undefined || TOOLS.has(message.tool)) && optionalFiniteBetween(message.size, 0.1, 500);
    case "typing":
      return validId(message.id) && typeof message.typing === "boolean";
    case "anim_control":
      return validId(message.id) && ["text", "image"].includes(message.entity) &&
        isSafeEntityId(message.targetId) && (message.dvdPaused === undefined || typeof message.dvdPaused === "boolean");
    case "font_cycle_control":
      return validId(message.id) && isSafeEntityId(message.targetId) &&
        (message.enabled === undefined || typeof message.enabled === "boolean") &&
        optionalFiniteBetween(message.ms, 100, 60_000);
    default:
      return true;
  }
}

export function guardClientMessage(data, identity, maxBytes = 64 * 1024) {
  let raw;
  try {
    raw = typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    return null;
  }
  if (!raw || Buffer.byteLength(raw, "utf8") > maxBytes) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !hasSafeShape(parsed)) return null;
  if (!EDITOR_MESSAGE_TYPES.has(parsed.type)) return null;
  if (identity.role === "viewer" && !VIEWER_MESSAGE_TYPES.has(parsed.type)) return null;

  const message = pickFields(parsed);
  if (!message || !validateIdentifiers(message) || !validateTypeSpecific(message)) return null;
  if ("name" in message) message.name = identity.name;
  if ("by" in message) message.by = identity.name;
  return {
    message,
    raw: JSON.stringify(message),
    persistable: identity.role === "editor" && isPersistableType(message.type),
  };
}
