const FNV_OFFSET = 0x811c9dc5 >>> 0;
const FNV_PRIME = 16777619 >>> 0;

function parseEvent(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function eventFingerprintKey(value) {
  const event = parseEvent(value);
  if (!event || typeof event !== "object") return null;
  switch (event.type) {
    case "stroke":
      return typeof event.strokeId === "string" ? `S|${event.strokeId}` : null;
    case "text_commit":
      return typeof event.textId === "string" && typeof event.strokeId === "string"
        ? `TC|${event.textId}|${event.strokeId}`
        : null;
    case "text_update":
      return typeof event.textId === "string"
        ? `TU|${event.textId}|${typeof event.strokeId === "string" ? event.strokeId : ""}`
        : null;
    case "image_commit":
      return typeof event.imageId === "string" && typeof event.strokeId === "string"
        ? `IC|${event.imageId}|${event.strokeId}`
        : null;
    case "image_update":
      return typeof event.imageId === "string"
        ? `IU|${event.imageId}|${typeof event.strokeId === "string" ? event.strokeId : ""}`
        : null;
    default:
      return null;
  }
}

export function fingerprintHistory(history, undoneCount = 0, windowSize = 500) {
  const allKeys = [];
  for (const event of Array.isArray(history) ? history : []) {
    const key = eventFingerprintKey(event);
    if (key) allKeys.push(key);
  }

  const keys = allKeys.slice(Math.max(0, allKeys.length - windowSize));
  let hash = FNV_OFFSET;
  for (const key of keys) {
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
  }

  return {
    fp: { v: 1, c: allKeys.length, u: undoneCount, h: hash },
    keys,
  };
}
