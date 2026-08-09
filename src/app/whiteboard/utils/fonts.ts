export type FontSpec = {
  family: string;
  weights?: string[];
};
const GOOGLE_FONTS: FontSpec[] = [
  { family: "Inter", weights: ["400", "600", "700"] },
  { family: "Roboto", weights: ["400", "700"] },
  { family: "Open Sans", weights: ["400", "600", "700"] },
  { family: "Lato", weights: ["400", "700"] },
  { family: "Poppins", weights: ["400", "600", "700"] },
  { family: "Montserrat", weights: ["400", "600", "700"] },
  { family: "Oswald", weights: ["400", "600", "700"] },
  { family: "Raleway", weights: ["400", "600", "700"] },
  { family: "Merriweather", weights: ["400", "700"] },
  { family: "Playfair Display", weights: ["400", "700"] },
  { family: "Work Sans", weights: ["400", "600", "700"] },
  { family: "Nunito", weights: ["400", "600", "700"] },
  { family: "Nunito Sans", weights: ["400", "600", "700"] },
  { family: "Rubik", weights: ["400", "600", "700"] },
  { family: "Quicksand", weights: ["400", "600", "700"] },
  { family: "Source Sans Pro", weights: ["400", "600", "700"] },
  { family: "Source Serif Pro", weights: ["400", "700"] },
  { family: "IBM Plex Sans", weights: ["400", "600", "700"] },
  { family: "IBM Plex Serif", weights: ["400", "700"] },
  { family: "IBM Plex Mono", weights: ["400", "700"] },
  { family: "Fira Sans", weights: ["400", "600", "700"] },
  { family: "Fira Code", weights: ["400", "600"] },
  { family: "Inconsolata", weights: ["400", "700"] },
  { family: "JetBrains Mono", weights: ["400", "700"] },
  { family: "Ubuntu", weights: ["400", "500", "700"] },
  { family: "Kanit", weights: ["400", "600", "700"] },
  { family: "Titillium Web", weights: ["400", "600", "700"] },
  { family: "PT Sans", weights: ["400", "700"] },
  { family: "PT Serif", weights: ["400", "700"] },
  { family: "Cabin", weights: ["400", "600", "700"] },
  { family: "Heebo", weights: ["400", "600", "700"] },
  { family: "Mulish", weights: ["400", "600", "700"] },
  { family: "DM Sans", weights: ["400", "500", "700"] },
  { family: "DM Serif Display", weights: ["400"] },
  { family: "Asap", weights: ["400", "600", "700"] },
  { family: "Barlow", weights: ["400", "600", "700"] },
  { family: "Manrope", weights: ["400", "600", "700"] },
  { family: "Space Grotesk", weights: ["400", "600", "700"] },
  { family: "Space Mono", weights: ["400", "700"] },
  { family: "Karla", weights: ["400", "700"] },
  { family: "Noto Sans", weights: ["400", "700"] },
  { family: "Noto Serif", weights: ["400", "700"] },
  { family: "Bebas Neue", weights: ["400"] },
  { family: "Pacifico", weights: ["400"] },
  { family: "Dancing Script", weights: ["400", "600", "700"] },
];
export const GOOGLE_FONT_NAMES = GOOGLE_FONTS.map(f => f.family);
export const FONT_FALLBACK_STACK = '"Noto Sans", "Segoe UI", Arial, sans-serif';
export function withFontFallback(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (!trimmed) return FONT_FALLBACK_STACK;
  if (trimmed.includes("Noto Sans") || trimmed.includes("Segoe UI") || trimmed.includes("Arial")) return trimmed;
  return `${trimmed}, ${FONT_FALLBACK_STACK}`;
}
export function primaryFamily(fontFamily: string): string {
  const first = fontFamily.split(",")[0]?.trim() ?? "";
  return first.replace(/^['"]|['"]$/g, "");
}
export async function ensureGoogleFontLoaded(spec: FontSpec): Promise<void> {
  // Lazy import to avoid bundling webfontloader eagerly
  const WebFont = (await import("webfontloader")).default as typeof import("webfontloader");
  await new Promise<void>((resolve) => {
    WebFont.load({
      google: { families: [`${spec.family}:${(spec.weights ?? ["400"]).join(",")}`] },
      active: () => resolve(),
      inactive: () => resolve(), // don't block if font fails; fall back to system
      fontinactive: () => resolve(),
    });
  });
}
// UI helpers for select dropdowns
const SYSTEM_FONT_OPTIONS = [
  { label: "System UI", css: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" },
  { label: "Segoe UI", css: "Segoe UI, Tahoma, Geneva, Verdana, sans-serif" },
  { label: "Arial", css: "Arial, Helvetica, sans-serif" },
  { label: "Georgia", css: 'Georgia, "Times New Roman", Times, serif' },
  { label: "Times New Roman", css: '"Times New Roman", Times, serif' },
  { label: "Courier New", css: '"Courier New", Courier, monospace' },
  { label: "Comic Sans MS", css: '"Comic Sans MS", "Comic Sans", cursive, sans-serif' },
];
export function buildFontOptions(googleNames: string[]) {
  const googleOpts = googleNames.map(f => ({ label: f, value: withFontFallback(`${f}, ${f.includes('Mono') || f.includes('Code') || f.includes('Inconsolata') ? 'monospace' : 'sans-serif'}`) }));
  const systemOpts = SYSTEM_FONT_OPTIONS.map(s => ({ label: s.label, value: withFontFallback(s.css) }));
  return [...googleOpts, ...systemOpts];
}
