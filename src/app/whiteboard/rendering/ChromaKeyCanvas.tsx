"use client";
import React, { useEffect, useMemo, useRef } from "react";
export type ChromaKeyParams = {
  color: string;  
  tolerance: number;  
  feather: number;  
  spill: number;  
};
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || "");
  if (!m) return { r: 0, g: 255, b: 0 };
  return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) };
}
export default function ChromaKeyCanvas({
  src,
  kind,
  params,
  style,
  className,
  playing = true,
  clickToPick = false,
  onPickColor,
  filter,
  options,
}: {
  src: string;
  kind: "image" | "video";
  params: ChromaKeyParams;
  style?: React.CSSProperties;
  className?: string;
  playing?: boolean;
  clickToPick?: boolean;
  onPickColor?: (hex: string) => void;
  filter?:
    | { type: 'css'; value: string }
    | { type: 'rainbow'; speed: number; saturation: number; lightness: number }
    | null;
  options?: {
    targetMaskPixels?: number;  
    maxFps?: number;
    minFps?: number;
    largeFrameSkipModulo?: number;  
    showPreviewBadge?: boolean;  
  };
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const reqRef = useRef<number>(0);
  const mounted = useRef(true);
  const rgb = useMemo(() => hexToRgb(params.color), [params.color]);
  const lastDrawSourceRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const frameBufRef = useRef<{ w: number; h: number; src?: ImageData } | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskImageDataRef = useRef<ImageData | null>(null);
  const lastFrameAtRef = useRef<number>(0);
  const lastProcMsRef = useRef<number>(0);
  const frameCounterRef = useRef<number>(0);
  const pausedByInvisibleRef = useRef<boolean>(false);
  const invisibleSinceRef = useRef<number>(0);
  const TARGET_MASK_PIXELS = Math.max(30_000, Math.min(600_000, options?.targetMaskPixels ?? 180_000));
  const MAX_FPS_CAP = Math.max(12, Math.min(60, options?.maxFps ?? 45));
  const MIN_FPS_CAP = Math.max(8, Math.min(MAX_FPS_CAP, options?.minFps ?? 20));
  const INVISIBLE_FPS = 2;  
  const LARGE_SKIP = Math.max(1, Math.min(6, options?.largeFrameSkipModulo ?? 2));
  useEffect(() => { return () => { mounted.current = false; if (reqRef.current) cancelAnimationFrame(reqRef.current); }; }, []);
  const filterKey = useMemo(() => {
    if (!filter) return 'none';
    if (filter.type === 'css') return `css:${filter.value}`;
    return `rr:${filter.speed}:${filter.saturation}:${filter.lightness}`;
  }, [filter]);
  useEffect(() => {
    const v = videoRef.current;
    if (kind !== 'video' || !v) return;
    if (playing) {
      if (v.paused) {
        v.play().catch(() => {});
      }
    } else {
      if (!v.paused) {
        v.pause();
      }
    }
  }, [playing, kind]);
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    let running = true;
  const ctx = cvs.getContext("2d");
  if (!ctx) return;
    function isLikelyAnimatedImage(url: string): boolean {
      try {
        if (url.startsWith('data:')) {
          if (/data:image\/(gif|webp|apng)/i.test(url)) return true;
          return false;
        }
        const u = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost');
        const p = u.pathname.toLowerCase();
        if (p.endsWith('.gif') || p.endsWith('.apng') || p.endsWith('.webp')) return true;
        const inner = u.searchParams.get('url');
        if (inner) {
          try {
            const iu = new URL(inner);
            const ip = iu.pathname.toLowerCase();
            if (ip.endsWith('.gif') || ip.endsWith('.apng') || ip.endsWith('.webp')) return true;
            const ict = iu.searchParams.get('ct') || iu.searchParams.get('contentType') || iu.searchParams.get('content_type') || iu.searchParams.get('type');
            if (ict && /gif|webp|apng/i.test(ict)) return true;
            const ifmt = iu.searchParams.get('format') || iu.searchParams.get('fmt');
            if (ifmt && /gif|webp|apng/i.test(ifmt)) return true;
          } catch {}
        }
        const ct = u.searchParams.get('ct') || u.searchParams.get('contentType') || u.searchParams.get('content_type') || u.searchParams.get('type');
        if (ct && /gif|webp|apng/i.test(ct)) return true;
        const fmt = u.searchParams.get('format') || u.searchParams.get('fmt');
        if (fmt && /gif|webp|apng/i.test(fmt)) return true;
      } catch {}
      return false;
    }
    function drawImage(el: HTMLImageElement | HTMLVideoElement) {
      if (!running) return;
      const isVideo = el instanceof HTMLVideoElement;
      const isImage = el instanceof HTMLImageElement;
      const w = (isVideo ? (el as HTMLVideoElement).videoWidth : (isImage ? (el as HTMLImageElement).naturalWidth : 0)) || el.clientWidth || 0;
      const h = (isVideo ? (el as HTMLVideoElement).videoHeight : (isImage ? (el as HTMLImageElement).naturalHeight : 0)) || el.clientHeight || 0;
      if (w <= 0 || h <= 0) { reqRef.current = requestAnimationFrame(loop); return; }
      if (!canvasRef.current || !ctx) { reqRef.current = requestAnimationFrame(loop); return; }
      if (canvasRef.current.width !== w || canvasRef.current.height !== h) { canvasRef.current.width = w; canvasRef.current.height = h; }
  const lastCost = lastProcMsRef.current || 0;
  let dynamicFps = MAX_FPS_CAP;
  if (lastCost > 18) dynamicFps = 24; else if (lastCost > 12) dynamicFps = 30; else if (lastCost > 8) dynamicFps = 36;
  dynamicFps = Math.max(MIN_FPS_CAP, Math.min(MAX_FPS_CAP, dynamicFps));
  if (pausedByInvisibleRef.current) dynamicFps = Math.max(INVISIBLE_FPS, Math.min(dynamicFps, 8));
  const now = performance.now();
  const minDt = 1000 / dynamicFps;
  if (now - (lastFrameAtRef.current || 0) < minDt) { reqRef.current = requestAnimationFrame(loop); return; }
  lastFrameAtRef.current = now;
      if (!offRef.current) offRef.current = document.createElement('canvas');
      const off = offRef.current;
  let scale = Math.sqrt(TARGET_MASK_PIXELS / Math.max(1, w * h));
  scale = Math.min(0.6, Math.max(0.18, scale));
  const mw = Math.max(1, Math.floor(w * scale));
  const mh = Math.max(1, Math.floor(h * scale));
      if (off.width !== mw || off.height !== mh) { off.width = mw; off.height = mh; frameBufRef.current = null; }
      const octx = off.getContext('2d');
      if (!octx) { reqRef.current = requestAnimationFrame(loop); return; }
      octx.drawImage(el, 0, 0, mw, mh);
      lastDrawSourceRef.current = el;
      ctx.clearRect(0, 0, w, h);
      const filterStr = (() => {
        if (!filter) return 'none';
        if (filter.type === 'css') return filter.value || 'none';
        const elapsed = (Date.now() % 100000) / 1000;
        const hue = ((elapsed * (filter.speed || 120)) % 360 + 360) % 360;
        const sat = Math.max(0, filter.saturation ?? 180);
        const br = Math.max(0, filter.lightness ?? 100);
        return `hue-rotate(${hue}deg) saturate(${sat}%) brightness(${br}%)`;
      })();
      ctx.save();
      try { (ctx as unknown as { filter?: string }).filter = filterStr; } catch {}
      ctx.drawImage(el, 0, 0, w, h);
      ctx.restore();
      try {
        frameCounterRef.current++;
  const largeFrame = w * h > 1280 * 720;  
  const skip = largeFrame && (frameCounterRef.current % LARGE_SKIP !== 0);  
        if (!maskCanvasRef.current) maskCanvasRef.current = document.createElement('canvas');
        const mcv = maskCanvasRef.current;
        if (mcv.width !== mw || mcv.height !== mh) { mcv.width = mw; mcv.height = mh; }
        const mctx = mcv.getContext('2d');
        if (mctx) {
          let needCompute = true;
            if (skip && maskImageDataRef.current) needCompute = false;
          const t0 = performance.now();
          if (needCompute) {
            let buf = frameBufRef.current;
            if (!buf || buf.w !== mw || buf.h !== mh) {
              buf = { w: mw, h: mh, src: octx.getImageData(0, 0, mw, mh) };
              frameBufRef.current = buf;
            } else {
              buf.src = octx.getImageData(0, 0, mw, mh);
            }
            const sd = buf.src?.data;
            if (sd) {
              if (!maskImageDataRef.current || maskImageDataRef.current.width !== mw || maskImageDataRef.current.height !== mh) {
                maskImageDataRef.current = mctx.createImageData(mw, mh);
              }
              const md = maskImageDataRef.current.data;
              const { r: kr, g: kg, b: kb } = hexToRgb(params.color);
              const tol = Math.max(0, Math.min(255, params.tolerance));
              const feather = Math.max(0, Math.min(255, params.feather));
              const featherSq = (tol + feather);
              const maxSq = tol * tol * 3;
              const maxFeatherSq = featherSq * featherSq * 3;
              for (let i = 0, j = 0; i < sd.length; i += 4, j += 4) {
                const r = sd[i], g = sd[i+1], b = sd[i+2];
                const dr = r - kr, dg = g - kg, db = b - kb;
                const dsq = dr*dr + dg*dg + db*db;
                let a = 255;
                if (dsq <= maxSq) a = 0; else if (dsq <= maxFeatherSq) {
                  const tt = (dsq - maxSq) / Math.max(1, (maxFeatherSq - maxSq));
                  a = Math.round(255 * tt);
                }
                md[j] = 0; md[j+1] = 0; md[j+2] = 0; md[j+3] = a;
              }
              mctx.putImageData(maskImageDataRef.current, 0, 0);
            }
            lastProcMsRef.current = performance.now() - t0;
          }
          if (maskImageDataRef.current) {
            let coverage = 1;
            const fc = frameCounterRef.current;
            if ((fc % 5) === 0) {
              const md = maskImageDataRef.current.data;
              const totalPx = (maskImageDataRef.current.width * maskImageDataRef.current.height) | 0;
              let visible = 0;
              for (let i = 3, px = 0; i < md.length; i += 16, px += 4) {
                if (md[i] > 8) visible++;
              }
              const sampled = Math.ceil(totalPx / 4);
              coverage = Math.max(0, Math.min(1, visible / Math.max(1, sampled)));
              const nowMs = performance.now();
              if (coverage < 0.0005) {
                if (!pausedByInvisibleRef.current) { invisibleSinceRef.current = nowMs; }
              } else {
                if (pausedByInvisibleRef.current) {
                  pausedByInvisibleRef.current = false;
                  try { if (kind === 'video' && videoRef.current) videoRef.current.play().catch(() => {}); } catch {}
                }
              }
            }
            ctx.save();
            ctx.globalCompositeOperation = 'destination-in';
            ctx.imageSmoothingEnabled = true;
            try { (ctx as CanvasRenderingContext2D & { imageSmoothingQuality?: 'low' | 'medium' | 'high' | string }).imageSmoothingQuality = 'high'; } catch {}
            ctx.drawImage(mcv, 0, 0, w, h);
            ctx.restore();
          }
        }
      } catch {}
      reqRef.current = requestAnimationFrame(loop);
    }
    function loop() {
      if (!running) return;
      if (!playing && kind === 'video') {
        return;
      }
      if (kind === "video" && videoRef.current) {
        drawImage(videoRef.current);
      } else if (kind === "image" && imgRef.current) {
        drawImage(imgRef.current);
      } else {
        reqRef.current = requestAnimationFrame(loop);
      }
    }
    const v = videoRef.current;
    const rvfc = (v && 'requestVideoFrameCallback' in v)
      ? (v as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback.bind(v)
      : null;
    const animatedImage = kind === 'image' && isLikelyAnimatedImage(src);
    const needsAnimation = (kind === 'video' ? !!playing : (animatedImage && !!playing)) || (filter && filter.type === 'rainbow');
    if (kind === 'video' && v && rvfc) {
      const tick = () => { if (!running) return; drawImage(v); rvfc(tick); };
      rvfc(tick);
    } else if (needsAnimation) {
      reqRef.current = requestAnimationFrame(loop);
    } else {
      if (kind === 'image' && imgRef.current) drawImage(imgRef.current);
    }
    return () => { running = false; };
  }, [kind, src, rgb.r, rgb.g, rgb.b, params, filterKey, filter, TARGET_MASK_PIXELS, MAX_FPS_CAP, MIN_FPS_CAP, LARGE_SKIP, playing]);
  function pickColorFromOriginal(ev: React.MouseEvent<HTMLCanvasElement>) {
    if (!clickToPick || !onPickColor) return;
    const cvs = canvasRef.current; if (!cvs) return;
    const srcEl = lastDrawSourceRef.current || videoRef.current || imgRef.current; if (!srcEl) return;
    const rect = cvs.getBoundingClientRect();
    const xCss = ev.clientX - rect.left; const yCss = ev.clientY - rect.top;
    const scaleX = cvs.width / Math.max(1, rect.width);
    const scaleY = cvs.height / Math.max(1, rect.height);
    const x = Math.max(0, Math.min(cvs.width - 1, Math.floor(xCss * scaleX)));
    const y = Math.max(0, Math.min(cvs.height - 1, Math.floor(yCss * scaleY)));
    try {
      const off = document.createElement('canvas');
      off.width = cvs.width; off.height = cvs.height;
      const octx = off.getContext('2d'); if (!octx) return;
      octx.drawImage(srcEl, 0, 0, off.width, off.height);
      const data = octx.getImageData(x, y, 1, 1).data;
      const [r, g, b] = [data[0], data[1], data[2]];
      const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      onPickColor?.(hex);
    } catch {}
  }
  return (
    <div className={className} style={{ position: "relative", width: "100%", height: "100%", ...style }}>
      <canvas
        ref={canvasRef}
        onClick={pickColorFromOriginal}
        style={{ width: "100%", height: "100%", display: "block", cursor: clickToPick ? 'crosshair' : undefined }}
      />
      {kind === "video" ? (
        <video
          ref={videoRef}
          src={src}
          muted
          playsInline
          loop
          autoPlay={playing}
          style={{ position: "absolute", left: -99999, top: -99999, width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          ref={imgRef}
          src={src}
          alt=""
          crossOrigin="anonymous"
          style={{ position: "absolute", left: -99999, top: -99999, width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        />
      )}
    </div>
  );
}
