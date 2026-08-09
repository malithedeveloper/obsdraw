import { ImageHandleKey, TextOutlineConfig } from "../types";

export const cloneTextOutline = (src?: TextOutlineConfig | null, fallback?: TextOutlineConfig): TextOutlineConfig => {
  const base = src ?? fallback;
  if (!base) {
    return { enabled: false, color: "#000000", width: 0, feather: 0 };
  }
  return {
    ...base,
    chroma: base.chroma ? { ...base.chroma } : undefined,
  };
};

export const OUTLINE_BASE_FONT_PX = 24;

const outlineScaleForSize = (sizePx?: number | null) => {
  const base = OUTLINE_BASE_FONT_PX || 1;
  const size = Math.max(6, sizePx ?? base);
  const relative = Math.max(0.2, size / base);
  return 0.5 + Math.pow(relative, 0.4) * 0.5;  
};

export const effectiveOutlineValue = (value: number, sizePx?: number | null) => {
  if (value <= 0) return 0;
  return value * outlineScaleForSize(sizePx);
};

export const horizontalComponent = (handle: ImageHandleKey): "l" | "r" | null => {
  if (handle.includes("l")) return "l";
  if (handle.includes("r")) return "r";
  return null;
};

export const verticalComponent = (handle: ImageHandleKey): "t" | "b" | null => {
  if (handle.includes("t")) return "t";
  if (handle.includes("b")) return "b";
  return null;
};

export const computeHandleAnchorMapping = (angleDeg: number): Record<ImageHandleKey, ImageHandleKey> => {
  const normalized = ((angleDeg % 360) + 360) % 360;
  const stepsRaw = Math.round(normalized / 90);
  const steps = ((stepsRaw % 4) + 4) % 4;
  if (steps === 0) {
    return {
      tl: "tl",
      tr: "tr",
      br: "br",
      bl: "bl",
      t: "t",
      r: "r",
      b: "b",
      l: "l",
    };
  }
  const corners: ImageHandleKey[] = ["tl", "tr", "br", "bl"];
  const edges: ImageHandleKey[] = ["t", "r", "b", "l"];
  const rotateOrder = (order: ImageHandleKey[]) =>
    order.reduce<Record<ImageHandleKey, ImageHandleKey>>((acc, key, index) => {
      const target = order[(index + steps) % order.length];
      acc[key] = target as ImageHandleKey;
      return acc;
    }, {} as Record<ImageHandleKey, ImageHandleKey>);
  const cornerMap = rotateOrder(corners);
  const edgeMap = rotateOrder(edges);
  return {
    ...cornerMap,
    ...edgeMap,
  };
};

export const looksAnimatedImage = (src: string | null | undefined, contentType?: string | null): boolean => {
  if (contentType && /gif|webp|apng/i.test(contentType)) return true;
  if (!src) return false;
  if (src.startsWith("data:")) {
    return /data:image\/(gif|webp|apng)/i.test(src);
  }
  try {
    const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const url = new URL(src, base);
    const path = url.pathname.toLowerCase();
    if (path.endsWith(".gif") || path.endsWith(".webp") || path.endsWith(".apng")) return true;
    const fmt = url.searchParams.get("format") || url.searchParams.get("fmt");
    if (fmt && /gif|webp|apng/i.test(fmt)) return true;
    const ctParam =
      url.searchParams.get("ct") ||
      url.searchParams.get("contentType") ||
      url.searchParams.get("content_type") ||
      url.searchParams.get("type");
    if (ctParam && /gif|webp|apng/i.test(ctParam)) return true;
    const inner = url.searchParams.get("url");
    if (inner && inner !== src) {
      return looksAnimatedImage(inner, contentType);
    }
  } catch {
  }
  return false;
};

const hslToRgb = (h: number, s: number, l: number): { r: number; g: number; b: number } => {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  };
};

const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const normalized = hex.trim().replace(/^#/, "");
  if (normalized.length === 3) {
    const [r, g, b] = normalized.split("");
    return {
      r: Number.parseInt(`${r}${r}`, 16),
      g: Number.parseInt(`${g}${g}`, 16),
      b: Number.parseInt(`${b}${b}`, 16),
    };
  }
  if (normalized.length !== 6) return null;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
};

const cssColorToRgb = (value: string): { r: number; g: number; b: number } | null => {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return hexToRgb(trimmed);
  const hslMatch = trimmed.match(/^hsla?\(([^)]+)\)$/i);
  if (hslMatch) {
    const parts = hslMatch[1].split(",").map(p => p.trim());
    if (parts.length >= 3) {
      const h = Number.parseFloat(parts[0]);
      const s = Number.parseFloat(parts[1]);
      const l = Number.parseFloat(parts[2]);
      if (Number.isFinite(h) && Number.isFinite(s) && Number.isFinite(l)) {
        return hslToRgb(h, s, l);
      }
    }
  }
  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map(p => p.trim());
    if (parts.length >= 3) {
      const r = Number.parseFloat(parts[0]);
      const g = Number.parseFloat(parts[1]);
      const b = Number.parseFloat(parts[2]);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return {
          r: Math.max(0, Math.min(255, Math.round(r))),
          g: Math.max(0, Math.min(255, Math.round(g))),
          b: Math.max(0, Math.min(255, Math.round(b))),
        };
      }
    }
  }
  return null;
};

const colorWithOpacity = (color: string, alpha: number, fallback: string): string => {
  const rgb = cssColorToRgb(color);
  if (!rgb) return fallback;
  const clamped = Math.min(1, Math.max(0, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamped})`;
};

const ensureReadableColor = (color: string, opts: { onLight: string; onDark: string; threshold?: number }) => {
  const rgb = cssColorToRgb(color);
  if (!rgb) return opts.onDark;
  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  const threshold = opts.threshold ?? 150;
  return luminance > threshold ? opts.onLight : opts.onDark;
};

export const cursorPaletteFor = (baseColor: string) => {
  const rgb = cssColorToRgb(baseColor);
  const luminance = rgb ? 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b : 160;
  const bgAlpha = luminance < 135 ? 0.8 : 0.92;
  const bg = colorWithOpacity(baseColor, bgAlpha, baseColor);
  const stroke = colorWithOpacity(baseColor, luminance < 135 ? 0.5 : 0.45, baseColor);
  const pointer = baseColor;
  const text = ensureReadableColor(bg, { onLight: "#111827", onDark: "#f9fafb", threshold: 160 });
  return {
    bg,
    stroke,
    text,
    pointer,
  };
};
