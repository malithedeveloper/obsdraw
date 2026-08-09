import type { WebDAVClient } from "webdav";

export function getWebDavClient(): WebDAVClient;
export function basePath(): string;
export function ensureDirectory(targetPath: string): Promise<void>;
export function exists(targetPath: string): Promise<boolean>;
export function readFile(targetPath: string): Promise<Buffer | null>;
export function writeFileAtomic(targetPath: string, data: Buffer | string): Promise<void>;
export function createReadStream(
  targetPath: string,
  range?: { start?: number; end?: number },
): NodeJS.ReadableStream;
