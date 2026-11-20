/**
 * Colour themes. The choice is kept in this browser and applied as
 * `<html data-theme="…">`; the colours themselves live in dashboard.css.
 */

export const THEMES = [
  { id: "paper", name: "Paper", description: "Light green paper, green ink" },
  { id: "parchment", name: "Parchment", description: "Warm paper, brown ink" },
  { id: "forest", name: "Forest", description: "Dark green, for low light" },
  { id: "slate", name: "Slate", description: "Dark, cool grey" },
  { id: "contrast", name: "High contrast", description: "Black on white" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const KEY = "tailnet-theme";

function isTheme(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

/** The saved theme, or one that follows the system's light/dark setting. */
export function currentTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(KEY);
    if (isTheme(saved)) return saved;
  } catch {
    // storage blocked: fall through to the system setting
  }
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "forest" : "paper";
}

export function applyTheme(theme: ThemeId = currentTheme()): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: ThemeId): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // still applies for this page view
  }
  applyTheme(theme);
}
