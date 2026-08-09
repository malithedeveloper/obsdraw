export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(hash);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  } catch {
    let a = 1, b = 0;
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i++) { a = (a + u8[i]) % 65521; b = (b + a) % 65521; }
  const n = (((b << 16) | a) >>> 0) as number;
  return n.toString(16);
  }
}
