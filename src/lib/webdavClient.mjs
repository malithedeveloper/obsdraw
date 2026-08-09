import { randomUUID } from "node:crypto";
import { createClient } from "webdav";

let client;

export function getWebDavClient() {
  if (client) return client;
  const url = (process.env.WEBDAV_URL || "").trim();
  const username = (process.env.WEBDAV_USERNAME || "").trim();
  const password = (process.env.WEBDAV_PASSWORD || process.env.WEBDAV_TOKEN || "").trim();
  if (!url) throw new Error("WEBDAV_URL is not set");
  if (!username) throw new Error("WEBDAV_USERNAME is not set");
  if (!password) throw new Error("WEBDAV_PASSWORD or WEBDAV_TOKEN is not set");

  const spoofOrigin = (process.env.WEBDAV_SPOOF_ORIGIN || "").trim();
  const headers = spoofOrigin ? {
    Origin: spoofOrigin,
    Referer: `${spoofOrigin}/`,
    "User-Agent": `OBSdraw/1.0 (+${spoofOrigin})`,
  } : undefined;
  client = createClient(url, { username, password, headers });
  return client;
}

export function basePath() {
  let value = (process.env.WEBDAV_BASE_PATH || "/").trim();
  if (!value.startsWith("/")) value = `/${value}`;
  if (value.endsWith("/")) value = value.slice(0, -1);
  return value || "/";
}

export async function ensureDirectory(targetPath) {
  const remote = getWebDavClient();
  const parts = targetPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      await remote.createDirectory(current);
    } catch {
      // Existing directories are expected and WebDAV errors vary by provider.
    }
  }
}

export async function exists(targetPath) {
  try {
    return await getWebDavClient().exists(targetPath);
  } catch {
    return false;
  }
}

export async function readFile(targetPath) {
  try {
    const data = await getWebDavClient().getFileContents(targetPath, { format: "binary" });
    return data instanceof Buffer ? data : Buffer.from(data);
  } catch {
    return null;
  }
}

export async function writeFileAtomic(targetPath, data) {
  const remote = getWebDavClient();
  const directory = targetPath.split("/").slice(0, -1).join("/") || "/";
  await ensureDirectory(directory);
  const temporaryPath = `${targetPath}.tmp.${randomUUID()}`;
  await remote.putFileContents(temporaryPath, data, { overwrite: true });
  try {
    if (process.env.WEBDAV_BACKUPS === "1" && await exists(targetPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("Z", "");
      await remote.copyFile(targetPath, `${targetPath}.${stamp}.bak`, { overwrite: true });
    }
    await remote.moveFile(temporaryPath, targetPath, { overwrite: true });
  } catch (error) {
    await remote.deleteFile(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function createReadStream(targetPath, range) {
  const remote = getWebDavClient();
  if (range && (range.start != null || range.end != null)) {
    return remote.createReadStream(targetPath, { range });
  }
  return remote.createReadStream(targetPath);
}
