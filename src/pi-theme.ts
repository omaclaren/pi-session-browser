import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

type ThemeColorValue = string | number;

type PiThemeFile = {
  name: string;
  vars?: Record<string, ThemeColorValue>;
  colors: Record<string, ThemeColorValue>;
  export?: {
    pageBg?: string;
    cardBg?: string;
    infoBg?: string;
  };
};

type SettingsLike = {
  theme?: string;
};

export type BrowserTheme = {
  name: string;
  mode: "light" | "dark";
  source: "builtin" | "global" | "project";
  variables: Record<string, string>;
};

const BUILTIN_THEMES: Record<string, PiThemeFile> = {
  dark: {
    name: "dark",
    vars: {
      cyan: "#00d7ff",
      blue: "#5f87ff",
      green: "#b5bd68",
      red: "#cc6666",
      yellow: "#ffff00",
      gray: "#808080",
      dimGray: "#666666",
      darkGray: "#505050",
      accent: "#8abeb7",
      selectedBg: "#3a3a4a",
      userMsgBg: "#343541",
      toolPendingBg: "#282832",
      toolSuccessBg: "#283228",
      toolErrorBg: "#3c2828",
      customMsgBg: "#2d2838",
    },
    colors: {
      accent: "accent",
      border: "blue",
      borderAccent: "cyan",
      borderMuted: "darkGray",
      success: "green",
      error: "red",
      warning: "yellow",
      muted: "gray",
      dim: "dimGray",
      text: "",
      thinkingText: "gray",
      selectedBg: "selectedBg",
      userMessageBg: "userMsgBg",
      userMessageText: "",
      customMessageBg: "customMsgBg",
      customMessageText: "",
      customMessageLabel: "#9575cd",
      toolPendingBg: "toolPendingBg",
      toolSuccessBg: "toolSuccessBg",
      toolErrorBg: "toolErrorBg",
      toolTitle: "",
      toolOutput: "gray",
      mdHeading: "#f0c674",
      mdLink: "#81a2be",
      mdLinkUrl: "dimGray",
      mdCode: "accent",
      mdCodeBlock: "green",
      mdCodeBlockBorder: "gray",
      mdQuote: "gray",
      mdQuoteBorder: "gray",
      mdHr: "gray",
      mdListBullet: "accent",
      toolDiffAdded: "green",
      toolDiffRemoved: "red",
      toolDiffContext: "gray",
      syntaxComment: "#6A9955",
      syntaxKeyword: "#569CD6",
      syntaxFunction: "#DCDCAA",
      syntaxVariable: "#9CDCFE",
      syntaxString: "#CE9178",
      syntaxNumber: "#B5CEA8",
      syntaxType: "#4EC9B0",
      syntaxOperator: "#D4D4D4",
      syntaxPunctuation: "#D4D4D4",
      thinkingOff: "darkGray",
      thinkingMinimal: "#6e6e6e",
      thinkingLow: "#5f87af",
      thinkingMedium: "#81a2be",
      thinkingHigh: "#b294bb",
      thinkingXhigh: "#d183e8",
      bashMode: "green",
    },
    export: {
      pageBg: "#18181e",
      cardBg: "#1e1e24",
      infoBg: "#3c3728",
    },
  },
  light: {
    name: "light",
    vars: {
      teal: "#5a8080",
      blue: "#547da7",
      green: "#588458",
      red: "#aa5555",
      yellow: "#9a7326",
      mediumGray: "#6c6c6c",
      dimGray: "#767676",
      lightGray: "#b0b0b0",
      selectedBg: "#d0d0e0",
      userMsgBg: "#e8e8e8",
      toolPendingBg: "#e8e8f0",
      toolSuccessBg: "#e8f0e8",
      toolErrorBg: "#f0e8e8",
      customMsgBg: "#ede7f6",
    },
    colors: {
      accent: "teal",
      border: "blue",
      borderAccent: "teal",
      borderMuted: "lightGray",
      success: "green",
      error: "red",
      warning: "yellow",
      muted: "mediumGray",
      dim: "dimGray",
      text: "",
      thinkingText: "mediumGray",
      selectedBg: "selectedBg",
      userMessageBg: "userMsgBg",
      userMessageText: "",
      customMessageBg: "customMsgBg",
      customMessageText: "",
      customMessageLabel: "#7e57c2",
      toolPendingBg: "toolPendingBg",
      toolSuccessBg: "toolSuccessBg",
      toolErrorBg: "toolErrorBg",
      toolTitle: "",
      toolOutput: "mediumGray",
      mdHeading: "yellow",
      mdLink: "blue",
      mdLinkUrl: "dimGray",
      mdCode: "teal",
      mdCodeBlock: "green",
      mdCodeBlockBorder: "mediumGray",
      mdQuote: "mediumGray",
      mdQuoteBorder: "mediumGray",
      mdHr: "mediumGray",
      mdListBullet: "green",
      toolDiffAdded: "green",
      toolDiffRemoved: "red",
      toolDiffContext: "mediumGray",
      syntaxComment: "#008000",
      syntaxKeyword: "#0000FF",
      syntaxFunction: "#795E26",
      syntaxVariable: "#001080",
      syntaxString: "#A31515",
      syntaxNumber: "#098658",
      syntaxType: "#267F99",
      syntaxOperator: "#000000",
      syntaxPunctuation: "#000000",
      thinkingOff: "lightGray",
      thinkingMinimal: "#767676",
      thinkingLow: "blue",
      thinkingMedium: "teal",
      thinkingHigh: "#875f87",
      thinkingXhigh: "#8b008b",
      bashMode: "green",
    },
    export: {
      pageBg: "#f8f8f8",
      cardBg: "#ffffff",
      infoBg: "#fffae6",
    },
  },
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function getAgentDir(): string {
  return expandHome(process.env.PI_CODING_AGENT_DIR ?? "~/.pi/agent");
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function normalizeThemeName(name: string | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

async function readActiveThemeName(cwd: string): Promise<string | undefined> {
  const globalSettings = await readJsonFile<SettingsLike>(join(getAgentDir(), "settings.json"));
  const projectSettings = await readJsonFile<SettingsLike>(join(cwd, ".pi", "settings.json"));
  return projectSettings?.theme ?? globalSettings?.theme;
}

async function findThemeInDir(dir: string, themeName: string): Promise<PiThemeFile | undefined> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(dir, entry.name);
      const theme = await readJsonFile<PiThemeFile>(path);
      if (!theme) continue;
      const stem = basename(entry.name, ".json");
      if (normalizeThemeName(stem) === themeName || normalizeThemeName(theme.name) === themeName) {
        return theme;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function xtermColorToHex(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;

  const ansi = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  ];
  if (index < ansi.length) return ansi[index];

  if (index >= 232) {
    const value = 8 + (index - 232) * 10;
    return rgbToHex(value, value, value);
  }

  const cube = index - 16;
  const r = Math.floor(cube / 36);
  const g = Math.floor((cube % 36) / 6);
  const b = cube % 6;
  const component = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  return rgbToHex(component(r), component(g), component(b));
}

function normalizeHex(value: string): string | undefined {
  const match = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return undefined;
  return `#${match[1].toLowerCase()}`;
}

function rgbToHex(r: number, g: number, b: number): string {
  const hex = [r, g, b]
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
  const normalized = normalizeHex(hex);
  if (!normalized) return undefined;
  const raw = normalized.slice(1);
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const clamped = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamped})`;
}

function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const toLinear = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isDark(hex: string): boolean {
  return luminance(hex) < 0.42;
}

function contrastText(background: string): string {
  return isDark(background) ? "#ffffff" : "#101312";
}

function resolveThemeValue(
  value: ThemeColorValue | undefined,
  vars: Record<string, ThemeColorValue> | undefined,
  seen = new Set<string>(),
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return xtermColorToHex(value);

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const hex = normalizeHex(trimmed);
  if (hex) return hex;
  if (/^\d+$/.test(trimmed)) return xtermColorToHex(Number.parseInt(trimmed, 10));

  if (vars && Object.hasOwn(vars, trimmed) && !seen.has(trimmed)) {
    const nextSeen = new Set(seen);
    nextSeen.add(trimmed);
    return resolveThemeValue(vars[trimmed], vars, nextSeen);
  }

  return undefined;
}

function resolveColor(theme: PiThemeFile, token: string): string | undefined {
  return resolveThemeValue(theme.colors[token], theme.vars);
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value));
}

function buildBrowserTheme(theme: PiThemeFile, source: BrowserTheme["source"]): BrowserTheme {
  const bg = firstDefined(
    normalizeHex(theme.export?.pageBg ?? ""),
    resolveColor(theme, "customMessageBg"),
    resolveColor(theme, "toolPendingBg"),
    "#ffffff",
  ) ?? "#ffffff";
  const mode = isDark(bg) ? "dark" : "light";
  const panel = firstDefined(
    normalizeHex(theme.export?.cardBg ?? ""),
    resolveColor(theme, "toolPendingBg"),
    mode === "dark" ? "#1f1f1f" : "#f6f8fa",
  ) ?? (mode === "dark" ? "#1f1f1f" : "#f6f8fa");
  const panelStrong = mode === "dark" ? panel : bg;
  const surface = mode === "dark"
    ? (firstDefined(resolveColor(theme, "toolPendingBg"), panelStrong, panel) ?? panel)
    : (firstDefined(bg, panelStrong, panel) ?? bg);
  const surfaceStrong = mode === "dark"
    ? (firstDefined(resolveColor(theme, "userMessageBg"), panel, surface) ?? surface)
    : (firstDefined(panel, surface, bg) ?? panel);
  const accent = firstDefined(resolveColor(theme, "accent"), mode === "dark" ? "#42d9c5" : "#1b7c83")
    ?? (mode === "dark" ? "#42d9c5" : "#1b7c83");
  const border = firstDefined(resolveColor(theme, "border"), mode === "dark" ? "#363636" : "#d0d7de")
    ?? (mode === "dark" ? "#363636" : "#d0d7de");
  const borderStrong = firstDefined(resolveColor(theme, "borderAccent"), border) ?? border;
  const text = firstDefined(resolveColor(theme, "text"), mode === "dark" ? "#d5d0c9" : "#0e1116")
    ?? (mode === "dark" ? "#d5d0c9" : "#0e1116");
  const muted = firstDefined(resolveColor(theme, "muted"), mode === "dark" ? "#88847f" : "#656e77")
    ?? (mode === "dark" ? "#88847f" : "#656e77");
  const keyword = firstDefined(
    resolveColor(theme, "mdHeading"),
    resolveColor(theme, "syntaxKeyword"),
    resolveColor(theme, "customMessageLabel"),
    accent,
  ) ?? accent;
  const focus = firstDefined(resolveColor(theme, "warning"), accent) ?? accent;
  const selection = firstDefined(resolveColor(theme, "selectedBg"), rgba(accent, mode === "dark" ? 0.14 : 0.10))
    ?? rgba(accent, mode === "dark" ? 0.14 : 0.10);

  return {
    name: theme.name,
    mode,
    source,
    variables: {
      "--bg": bg,
      "--bg-glow-1": "transparent",
      "--bg-glow-2": "transparent",
      "--panel": panel,
      "--panel-strong": panelStrong,
      "--surface": surface,
      "--surface-strong": surfaceStrong,
      "--surface-hover": selection,
      "--surface-active": selection,
      "--border": border,
      "--border-strong": borderStrong,
      "--text": text,
      "--muted": muted,
      "--accent": accent,
      "--accent-strong": firstDefined(resolveColor(theme, "borderAccent"), accent) ?? accent,
      "--accent-soft": rgba(accent, mode === "dark" ? 0.12 : 0.10),
      "--accent-ring": rgba(accent, mode === "dark" ? 0.24 : 0.22),
      "--accent-contrast": contrastText(accent),
      "--keyword": keyword,
      "--focus": focus,
      "--focus-soft": rgba(focus, mode === "dark" ? 0.14 : 0.10),
      "--button": surface,
      "--button-hover": mode === "dark" ? surfaceStrong : panel,
      "--shadow": mode === "dark" ? "0 1px 2px rgba(0, 0, 0, 0.28)" : "0 1px 2px rgba(14, 17, 22, 0.05)",
      "--shadow-strong": mode === "dark" ? "0 1px 2px rgba(0, 0, 0, 0.36)" : "0 1px 2px rgba(14, 17, 22, 0.08)",
    },
  };
}

export async function loadActiveBrowserTheme(cwd: string): Promise<BrowserTheme | undefined> {
  const themeName = normalizeThemeName(await readActiveThemeName(cwd));
  if (!themeName) return undefined;

  const projectTheme = await findThemeInDir(join(cwd, ".pi", "themes"), themeName);
  if (projectTheme) return buildBrowserTheme(projectTheme, "project");

  const globalTheme = await findThemeInDir(join(getAgentDir(), "themes"), themeName);
  if (globalTheme) return buildBrowserTheme(globalTheme, "global");

  const builtInTheme = BUILTIN_THEMES[themeName];
  if (builtInTheme) return buildBrowserTheme(builtInTheme, "builtin");

  return undefined;
}
