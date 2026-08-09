const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const PERSISTED_TYPES = new Set([
  "stroke",
  "undo",
  "redo",
  "text_commit",
  "text_update",
  "image_commit",
  "image_update",
]);

const TEXT_UPDATE_FIELDS = [
  "x", "y", "width", "height", "text", "color", "size", "font", "chroma", "outline",
  "rotX", "rotY", "rotZ", "zIndex",
  "dvdEnabled", "dvdSpeed", "dvdVx", "dvdVy",
  "rotXAnimEnabled", "rotXAnimSpeed", "rotXAnimMin", "rotXAnimMax", "rotXAnimDir",
  "rotYAnimEnabled", "rotYAnimSpeed", "rotYAnimMin", "rotYAnimMax", "rotYAnimDir",
  "rotZAnimEnabled", "rotZAnimSpeed", "rotZAnimMin", "rotZAnimMax", "rotZAnimDir",
];

const IMAGE_UPDATE_FIELDS = [
  "x", "y", "width", "height", "filter", "rotX", "rotY", "rotZ", "zIndex",
  "dvdEnabled", "dvdSpeed", "dvdVx", "dvdVy",
  "chromaSpeed", "chromaSaturation", "chromaLightness",
  "rotXAnimEnabled", "rotXAnimSpeed", "rotXAnimMin", "rotXAnimMax", "rotXAnimDir",
  "rotYAnimEnabled", "rotYAnimSpeed", "rotYAnimMin", "rotYAnimMax", "rotYAnimDir",
  "rotZAnimEnabled", "rotZAnimSpeed", "rotZAnimMin", "rotZAnimMax", "rotZAnimDir",
  "chromaKeyEnabled", "chromaKeyColor", "chromaKeyTolerance", "chromaKeyFeather", "chromaKeySpill",
];

const TEXT_COMMIT_MERGE_FIELDS = [
  "x", "y", "width", "height", "text", "color", "size", "font", "chroma", "outline",
  "rotX", "rotY", "rotZ", "zIndex",
];
const IMAGE_COMMIT_MERGE_FIELDS = ["x", "y", "width", "height", "filter", "rotX", "rotY", "rotZ", "zIndex"];
const TEXT_STATE_FIELDS = TEXT_UPDATE_FIELDS.filter((field) => !TEXT_COMMIT_MERGE_FIELDS.includes(field));
const IMAGE_STATE_FIELDS = IMAGE_UPDATE_FIELDS.filter((field) => !IMAGE_COMMIT_MERGE_FIELDS.includes(field));

export function isSafeEntityId(value) {
  return typeof value === "string" && SAFE_ENTITY_ID.test(value);
}

function parseHistoryEvent(value) {
  let event = value;
  if (typeof value === "string") {
    try {
      event = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!event || typeof event !== "object" || !PERSISTED_TYPES.has(event.type)) return null;
  switch (event.type) {
    case "stroke":
    case "undo":
    case "redo":
      return isSafeEntityId(event.strokeId) ? event : null;
    case "text_commit":
      return isSafeEntityId(event.textId) && isSafeEntityId(event.strokeId) ? event : null;
    case "text_update":
      return isSafeEntityId(event.textId) && (!event.strokeId || isSafeEntityId(event.strokeId)) ? event : null;
    case "image_commit":
      return isSafeEntityId(event.imageId) && isSafeEntityId(event.strokeId) ? event : null;
    case "image_update":
      return isSafeEntityId(event.imageId) && (!event.strokeId || isSafeEntityId(event.strokeId)) ? event : null;
    default:
      return null;
  }
}

export function isPersistableType(type) {
  return PERSISTED_TYPES.has(type);
}

function mergeDefined(target, source, fields) {
  for (const field of fields) {
    if (source[field] !== undefined) target[field] = source[field];
  }
  return target;
}

function pickDefined(source, fields) {
  const result = {};
  return mergeDefined(result, source, fields);
}

function compactEntities(parsed, undone, options) {
  const commits = new Map();
  const updates = new Map();
  for (const event of parsed) {
    if (event.type === options.commitType && !undone.has(event.strokeId)) {
      commits.set(event[options.idField], event);
    } else if (event.type === options.updateType && (!event.strokeId || !undone.has(event.strokeId))) {
      const id = event[options.idField];
      const update = updates.get(id) || {};
      mergeDefined(update, event, options.updateFields);
      updates.set(id, update);
    }
  }

  const result = [];
  for (const [id, commit] of commits) {
    const update = updates.get(id) || {};
    result.push({ ...commit, ...pickDefined(update, options.commitFields) });
    const state = pickDefined(update, options.stateFields);
    if (Object.keys(state).length) {
      result.push({ type: options.updateType, id: "server", [options.idField]: id, ...state });
    }
  }
  return result;
}

export function compactHistory(history) {
  const parsed = [];
  for (const value of Array.isArray(history) ? history : []) {
    const event = parseHistoryEvent(value);
    if (event) parsed.push(event);
  }

  const undone = new Set();
  for (const event of parsed) {
    if (event.type === "undo") undone.add(event.strokeId);
    if (event.type === "redo") undone.delete(event.strokeId);
  }

  const result = parsed.filter((event) => event.type === "stroke" && !undone.has(event.strokeId));
  result.push(...compactEntities(parsed, undone, {
    commitType: "text_commit",
    updateType: "text_update",
    idField: "textId",
    updateFields: TEXT_UPDATE_FIELDS,
    commitFields: TEXT_COMMIT_MERGE_FIELDS,
    stateFields: TEXT_STATE_FIELDS,
  }));
  result.push(...compactEntities(parsed, undone, {
    commitType: "image_commit",
    updateType: "image_update",
    idField: "imageId",
    updateFields: IMAGE_UPDATE_FIELDS,
    commitFields: IMAGE_COMMIT_MERGE_FIELDS,
    stateFields: IMAGE_STATE_FIELDS,
  }));
  return result.map((event) => JSON.stringify(event));
}
