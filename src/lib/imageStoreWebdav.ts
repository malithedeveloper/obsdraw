import crypto from 'node:crypto';
import { basePath, ensureDirectory, exists, getWebDavClient, writeFileAtomic } from './webdavClient.mjs';
import { extensionFromContentType } from './media';
export type StoredInfo = {
  id: string;
  contentType: string;
  size: number;
  urlPath: string;  
};
function sha256(buf: Buffer): string { return crypto.createHash('sha256').update(buf).digest('hex'); }
export async function put(buf: Buffer, contentType: string): Promise<StoredInfo> {
  getWebDavClient();  
  const base = basePath();
  const mediaDir = `${base}/media`;
  await ensureDirectory(mediaDir);
  const hash = sha256(buf);
  const ext = extensionFromContentType(contentType);
  const id = `${hash}${ext ? '.' + ext : ''}`;
  const remote = `${mediaDir}/${id}`;
  if (!(await exists(remote))) {
    await writeFileAtomic(remote, buf);
  }
  return { id, contentType: contentType || 'application/octet-stream', size: buf.byteLength, urlPath: `/api/media/${encodeURIComponent(id)}` };
}
