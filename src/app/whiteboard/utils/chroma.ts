import { ChromaConfig } from "../types";
export function chromaColor(c: ChromaConfig): string {
  const elapsed = (Date.now() - c.startAt) / 1000;
  const hue = ((elapsed * c.speed) % 360 + 360) % 360;
  const s = Math.max(0, Math.min(100, c.saturation));
  const l = Math.max(0, Math.min(100, c.lightness));
  return `hsl(${hue}, ${s}%, ${l}%)`;
}
