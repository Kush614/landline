import type { Palette } from "./types.js";

/**
 * Three deliberately distinct directions so the Terac panel is choosing between
 * real alternatives, not three shades of the same page.
 */
export const PALETTES: Record<string, Palette> = {
  ink: {
    name: "ink",
    bg: "#0b0d10",
    fg: "#f4f6f8",
    muted: "#9aa4b2",
    accent: "#5b8cff",
    accentFg: "#06080c",
    surface: "#14181e",
    border: "#232a33",
  },
  paper: {
    name: "paper",
    bg: "#fbfaf7",
    fg: "#16181d",
    muted: "#5f6672",
    accent: "#1f5f4a",
    accentFg: "#ffffff",
    surface: "#ffffff",
    border: "#e6e3dc",
  },
  warm: {
    name: "warm",
    bg: "#fff8f2",
    fg: "#20140c",
    muted: "#6d5b4e",
    accent: "#e05a2b",
    accentFg: "#ffffff",
    surface: "#ffffff",
    border: "#f0e0d2",
  },
  slate: {
    name: "slate",
    bg: "#f6f7f9",
    fg: "#111418",
    muted: "#5b6472",
    accent: "#2b6cb0",
    accentFg: "#ffffff",
    surface: "#ffffff",
    border: "#e2e6eb",
  },
};

export const FONTS = {
  grotesk: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, "Helvetica Neue", Arial, sans-serif`,
  serif: `ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif`,
};

/** Pick a palette trio that suits the brief's vibe. */
export function paletteTrio(brief: string): Palette[] {
  const b = brief.toLowerCase();
  const wantsDark = /\b(dark|night|neon|crypto|ai|saas|dev|technical|studio)\b/.test(b);
  const wantsWarm = /\b(coffee|bakery|food|restaurant|cafe|yoga|salon|craft|handmade|candle)\b/.test(b);
  if (wantsWarm) return [PALETTES.warm, PALETTES.paper, PALETTES.ink];
  if (wantsDark) return [PALETTES.ink, PALETTES.slate, PALETTES.paper];
  return [PALETTES.paper, PALETTES.ink, PALETTES.warm];
}
