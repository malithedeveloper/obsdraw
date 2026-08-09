import { SnapshotMeta, SnapshotChunk } from "../types";
export class SnapshotAssembler {
  private events: string[] = [];
  private totalChunks?: number;
  private gotChunks: number = 0;
  start(meta: SnapshotMeta) {
    this.events = [];
    this.totalChunks = meta.totalChunks;
    this.gotChunks = 0;
  }
  addChunk(chunk: SnapshotChunk) {
    if (Array.isArray(chunk.events)) this.events.push(...chunk.events);
    this.gotChunks += 1;
  }
  done(): string[] {
    return this.events.slice();
  }
  progress(): { total: number; got: number } | null {
    if (typeof this.totalChunks === "number") return { total: this.totalChunks, got: this.gotChunks };
    return null;
  }
}
