function hash32(str: string): number {
  let h = 0x811c9dc5 >>> 0;  
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function userHue(id: string): number {
  const h = hash32(id);
  return (h % 330 + 15) % 360;  
}
export function userColor(id: string): { main: string; bg: string; glow: string } {
  const hue = userHue(id);
  const hash = hash32(id);
  const sat = 62 + (hash % 20);  
  const light = 48 + ((hash >> 5) % 10);  
  return {
    main: `hsl(${hue}, ${sat}%, ${light}%)`,
    bg: `hsla(${hue}, ${Math.min(90, sat + 8)}%, ${Math.max(16, light - 26)}%, 0.9)`,
    glow: `hsla(${hue}, ${sat}%, ${Math.min(70, light + 12)}%, 0.48)`,
  };
}
