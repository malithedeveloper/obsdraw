type Emitter = { emit: (event: string, payload: string) => void; connected: boolean } | null;
type QueuedPayload = { payload: string; enqueuedAt: number };
export function createOutbox(getSocket: () => Emitter, onDropLarge?: (size: number) => void) {
  const queue: QueuedPayload[] = [];
  let timer: number | null = null;
  const stats = { pending: 0, firstEnqueuedAt: 0 };
  const updateStats = () => {
    stats.pending = queue.length;
    stats.firstEnqueuedAt = queue.length ? queue[0]!.enqueuedAt : 0;
  };
  const flush = () => {
    const s = getSocket();
    if (!s || !s.connected) { timer = null; return; }
    try {
      while (queue.length && s.connected) {
        const next = queue.shift()!;
        s.emit("message", next.payload);
      }
    } catch {
    }
    updateStats();
    timer = queue.length ? window.setTimeout(flush, 40) : null;
  };
  const start = () => {
    if (timer !== null) return;
    timer = window.setTimeout(flush, 5);
  };
  const send = (obj: unknown) => {
    const payload = JSON.stringify(obj ?? {});
    if (payload.length > 12 * 1024 * 1024) {
      onDropLarge?.(payload.length);
      return;
    }
    const s = getSocket();
    if (s && s.connected) {
      try {
        s.emit("message", payload);
        updateStats();
        return;
      } catch {
      }
    }
    queue.push({ payload, enqueuedAt: performance.now() });
    updateStats();
    start();
  };
  const stop = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const flushNow = () => flush();
  const getStats = () => {
    const backlogMs = stats.pending && stats.firstEnqueuedAt
      ? Math.max(0, performance.now() - stats.firstEnqueuedAt)
      : 0;
    return { pending: stats.pending, backlogMs };
  };
  return { send, start, stop, flushNow, getStats };
}
