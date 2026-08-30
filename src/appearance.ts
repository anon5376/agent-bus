export const APPEARANCE_KEYS = [
  "bg",
  "bg2",
  "panel",
  "panel2",
  "border",
  "text",
  "muted",
  "accent",
  "accent2",
  "ok",
  "warn",
  "alert",
] as const;

export type AppearanceKey = (typeof APPEARANCE_KEYS)[number];
export type AppearanceTheme = Record<AppearanceKey, string>;

export const DEFAULT_APPEARANCE: AppearanceTheme = {
  bg: "#141414",
  bg2: "#181818",
  panel: "#1e1e1e",
  panel2: "#242424",
  border: "#2e2e2e",
  text: "#e4e4e4",
  muted: "#8c8c8c",
  accent: "#4d9fff",
  accent2: "#3b82f6",
  ok: "#4ade80",
  warn: "#fbbf24",
  alert: "#f87171",
};

export const APPEARANCE_PRESETS: { id: string; label: string; theme: AppearanceTheme }[] = [
  { id: "default", label: "Default", theme: DEFAULT_APPEARANCE },
  {
    id: "slate",
    label: "Slate",
    theme: {
      ...DEFAULT_APPEARANCE,
      bg: "#0f1419",
      bg2: "#15202b",
      panel: "#1b2836",
      panel2: "#22303f",
      border: "#2f4154",
      accent: "#7ab4ff",
      accent2: "#3b82f6",
    },
  },
  {
    id: "forest",
    label: "Forest",
    theme: {
      ...DEFAULT_APPEARANCE,
      bg: "#101410",
      bg2: "#161c16",
      panel: "#1c241c",
      panel2: "#243024",
      border: "#314331",
      accent: "#6ee7b7",
      accent2: "#059669",
      ok: "#86efac",
    },
  },
  {
    id: "rose",
    label: "Rose",
    theme: {
      ...DEFAULT_APPEARANCE,
      bg: "#161214",
      bg2: "#1c1618",
      panel: "#241c1f",
      panel2: "#2c2226",
      border: "#3d2e33",
      accent: "#fb7185",
      accent2: "#e11d48",
      alert: "#fb7185",
    },
  },
];

export const APPEARANCE_CSS_VARS: Record<AppearanceKey, string> = {
  bg: "--bg",
  bg2: "--bg-2",
  panel: "--panel",
  panel2: "--panel-2",
  border: "--border",
  text: "--text",
  muted: "--muted",
  accent: "--accent",
  accent2: "--accent-2",
  ok: "--ok",
  warn: "--warn",
  alert: "--alert",
};

const HEX = /^#([0-9a-fA-F]{6})$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value.trim());
}

export function parseAppearance(value: unknown): AppearanceTheme {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const theme = { ...DEFAULT_APPEARANCE };
  for (const key of APPEARANCE_KEYS) {
    const candidate = row[key];
    if (candidate === undefined) continue;
    if (!isHexColor(candidate)) throw new Error(`appearance.${key} must be a #RRGGBB color`);
    theme[key] = candidate.trim().toLowerCase();
  }
  return theme;
}

export function appearanceCssText(theme: AppearanceTheme): string {
  return APPEARANCE_KEYS.map((key) => `${APPEARANCE_CSS_VARS[key]}: ${theme[key]};`).join(" ");
}
