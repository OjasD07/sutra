/**
 * Sutra terminal palette (see the "Palette & glyphs" board of the TUI design).
 *
 * Body text always uses the terminal's own default foreground so it stays
 * readable on dark and light backgrounds. Accent marks Sutra's own voice (the
 * thread, the prompt caret, keys); info is for tool names only; muted carries
 * metadata. Colour is never the only signal: every outcome also has a glyph.
 * Chalk downsamples hex to 256/16 colours, and NO_COLOR / --no-color turns
 * colour off entirely (glyphs stay; the thread falls back to ASCII).
 */
export interface Theme {
  name: "dark" | "light";
  accent: string;
  muted: string;
  /** Line numbers, separators, de-emphasised rules. */
  faint: string;
  success: string;
  error: string;
  info: string;
  /** Idle input border. */
  border: string;
  /** Card borders, busy input border, separators. */
  borderDim: string;
  /** Inset panels (diff body, palette). */
  panel: string;
  /** Tinted rows. */
  addBg: string;
  removeBg: string;
  warnBg: string;
  infoBg: string;
  selectBg: string;
  /** Text drawn on an accent background (badges). */
  onAccent: string;
}

export const BRAND = {
  midnight: "#101923",
  saffron: "#F5B84B",
  ivory: "#F4F1E8",
  steel: "#9CAABA",
  success: "#52B788",
  error: "#E76F6F",
  info: "#6CA8E8",
} as const;

export const darkTheme: Theme = {
  name: "dark",
  accent: BRAND.saffron,
  muted: BRAND.steel,
  faint: "#5C6B7B",
  success: BRAND.success,
  error: BRAND.error,
  info: BRAND.info,
  border: "#3A4757",
  borderDim: "#23303D",
  panel: "#0B121A",
  addBg: "#192D30",
  removeBg: "#2C242D",
  warnBg: "#2A2418",
  infoBg: "#15263A",
  selectBg: "#2A2418",
  onAccent: BRAND.midnight,
};

/** Darker variants with adequate contrast on light backgrounds. */
export const lightTheme: Theme = {
  name: "light",
  accent: "#A86A00",
  muted: "#55616E",
  faint: "#8A8578",
  success: "#2D7A55",
  error: "#B23A3A",
  info: "#2F6DB5",
  border: "#DCD7CA",
  borderDim: "#DCD7CA",
  panel: "#EFECE3",
  addBg: "#E1F0E7",
  removeBg: "#F6E3E1",
  warnBg: "#FBF1DC",
  infoBg: "#EAF1FA",
  selectBg: "#FBF1DC",
  onAccent: "#FBFAF6",
};

/** Best-effort background detection via COLORFGBG ("fg;bg"). Defaults to dark. */
export function detectTheme(pref: "auto" | "dark" | "light", env = process.env): Theme {
  if (pref === "dark") return darkTheme;
  if (pref === "light") return lightTheme;
  const parts = env.COLORFGBG?.split(";");
  const bg = parts ? Number(parts[parts.length - 1]) : NaN;
  if (Number.isFinite(bg) && (bg === 7 || bg >= 9)) return lightTheme;
  return darkTheme;
}

export function colorEnabled(env = process.env, argv = process.argv): boolean {
  if (argv.includes("--no-color") || env.NO_COLOR !== undefined || env.FORCE_COLOR === "0") return false;
  return true;
}

/** The turn thread. Box-drawing with colour; ASCII without. */
export interface ThreadGlyphs {
  branch: string; // ├─
  pipe: string; // │
  end: string; // ╰─
  node: string; // ●
}

export function threadGlyphs(color: boolean): ThreadGlyphs {
  return color ? { branch: "├─ ", pipe: "│", end: "╰─ ", node: "●" } : { branch: "|- ", pipe: "|", end: "`- ", node: "*" };
}
