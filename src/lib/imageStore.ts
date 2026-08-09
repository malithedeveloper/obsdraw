import crypto from 'node:crypto';
type StoredImage = {
  id: string;
  contentType: string;
  data: Buffer;
  size: number;
  createdAt: number;
  ttlMs: number;
  hash: string;
};
class ImageStore {
  private items = new Map<string, StoredImage>();
  private byHash = new Map<string, string>();  
  private totalBytes = 0;
  public readonly sliding: boolean;
  private readonly maxBytes: number;
  private readonly defaultTtlMs: number;
  constructor(
    maxBytes = Number(process.env.MEDIA_MAX_BYTES || 200 * 1024 * 1024),  
    defaultTtlMsInput = Number(process.env.MEDIA_TTL_MS || 60 * 60 * 1000)  
  ) {
    this.maxBytes = maxBytes;
    this.defaultTtlMs = defaultTtlMsInput <= 0 ? Infinity : defaultTtlMsInput;
    this.sliding = process.env.MEDIA_REFRESH_ON_GET === '1' || process.env.MEDIA_SLIDING_TTL === '1';
  }
  private evictExpired() {
    const now = Date.now();
    for (const [id, it] of this.items) {
      if (it.ttlMs !== Infinity && now - it.createdAt > it.ttlMs) {
        this.items.delete(id);
        if (it.hash) {
          const cur = this.byHash.get(it.hash);
          if (cur === id) this.byHash.delete(it.hash);
        }
        this.totalBytes -= it.size;
      }
    }
  }
  private evictToFit(extra: number) {
    while (this.totalBytes + extra > this.maxBytes && this.items.size > 0) {
      let oldestId: string | null = null;
      let oldestTs = Infinity;
      for (const [id, it] of this.items) {
        if (it.createdAt < oldestTs) { oldestTs = it.createdAt; oldestId = id; }
      }
      if (oldestId) {
        const it = this.items.get(oldestId)!;
        this.items.delete(oldestId);
        if (it.hash) {
          const cur = this.byHash.get(it.hash);
          if (cur === oldestId) this.byHash.delete(it.hash);
        }
        this.totalBytes -= it.size;
      } else {
        break;
      }
    }
  }
  private computeHash(buf: Buffer): string {
    const h = crypto.createHash('sha256');
    h.update(buf);
    return h.digest('hex');
  }
  put(buf: Buffer, contentType: string, ttlMs = this.defaultTtlMs): StoredImage {
    this.evictExpired();
    const hash = this.computeHash(buf);
    const existingId = this.byHash.get(hash);
    if (existingId) {
      const existing = this.items.get(existingId);
      if (existing) {
        existing.createdAt = Date.now();
        return existing;
      } else {
        this.byHash.delete(hash);
      }
    }
    this.evictToFit(buf.byteLength);
    const id = crypto.randomBytes(12).toString('hex');
    const item: StoredImage = {
      id,
      contentType: contentType || 'application/octet-stream',
      data: buf,
      size: buf.byteLength,
      createdAt: Date.now(),
      ttlMs: ttlMs <= 0 ? Infinity : ttlMs,
      hash,
    };
    this.items.set(id, item);
    this.byHash.set(hash, id);
    this.totalBytes += item.size;
    return item;
  }
  get(id: string): StoredImage | null {
    this.evictExpired();
    const it = this.items.get(id);
    if (!it) return null;
    if (this.sliding && it.ttlMs !== Infinity) {
      it.createdAt = Date.now();
    }
    return it;
  }
  getByHash(hash: string): StoredImage | null {
    this.evictExpired();
    const id = this.byHash.get(hash);
    if (!id) return null;
    const it = this.items.get(id) || null;
    if (it && this.sliding && it.ttlMs !== Infinity) {
      it.createdAt = Date.now();
    }
    return it;
  }
}
export const imageStore = new ImageStore();
