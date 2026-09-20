import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  DEFAULT_SIDEBAR_SETTINGS,
  type SidebarColors,
  type SidebarMarks,
  type SidebarSettings,
} from "./sidebar.ts";
import { resolveThemeColor } from "./tokens.ts";

export { DEFAULT_SIDEBAR_SETTINGS, type SidebarColors, type SidebarMarks, type SidebarSettings };

const COLOR_DEFAULTS = DEFAULT_SIDEBAR_SETTINGS.colors;
const MARK_DEFAULTS = DEFAULT_SIDEBAR_SETTINGS.marks;
const COLOR_KEYS = Object.keys(COLOR_DEFAULTS) as (keyof SidebarColors)[];
const MARK_KEYS = Object.keys(MARK_DEFAULTS) as (keyof SidebarMarks)[];
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function sidebarConfigPath(): string {
  return join(getAgentDir(), "sidebar.json");
}

export function normalizeSidebarConfig(raw: unknown): Record<string, unknown> {
  const input = isPlainObject(raw) ? { ...raw } : {};
  const colorsIn = isPlainObject(input.colors) ? { ...input.colors } : {};
  const marksIn = isPlainObject(input.marks) ? { ...input.marks } : {};

  input.enabled = typeof input.enabled === "boolean" ? input.enabled : DEFAULT_SIDEBAR_SETTINGS.enabled;
  input.widthPercent = clampInt(input.widthPercent, 10, 40, DEFAULT_SIDEBAR_SETTINGS.widthPercent);
  input.minWidth = clampInt(input.minWidth, 16, 80, DEFAULT_SIDEBAR_SETTINGS.minWidth);
  input.minTerminalWidth = clampInt(input.minTerminalWidth, 40, 200, DEFAULT_SIDEBAR_SETTINGS.minTerminalWidth);
  input.filesMaxLines = clampInt(input.filesMaxLines, 2, 20, DEFAULT_SIDEBAR_SETTINGS.filesMaxLines);
  input.ascii = typeof input.ascii === "boolean" ? input.ascii : DEFAULT_SIDEBAR_SETTINGS.ascii;
  input.colors = mergeColors(colorsIn);
  input.marks = mergeMarks(marksIn);
  return input;
}

export function settingsFromConfig(raw: unknown): SidebarSettings {
  const merged = normalizeSidebarConfig(raw);
  return {
    enabled: merged.enabled === true,
    widthPercent: merged.widthPercent as number,
    minWidth: merged.minWidth as number,
    minTerminalWidth: merged.minTerminalWidth as number,
    filesMaxLines: merged.filesMaxLines as number,
    ascii: merged.ascii === true,
    colors: merged.colors as SidebarColors,
    marks: merged.marks as SidebarMarks,
  };
}

export function loadSidebarConfig(path = sidebarConfigPath()): {
  settings: SidebarSettings;
  stored: Record<string, unknown>;
} {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const stored = normalizeSidebarConfig(parsed);
    return { settings: settingsFromConfig(stored), stored };
  } catch {
    const stored = normalizeSidebarConfig(undefined);
    return { settings: settingsFromConfig(stored), stored };
  }
}

export function saveSidebarConfig(
  stored: Record<string, unknown>,
  path = sidebarConfigPath(),
): SidebarSettings {
  const next = normalizeSidebarConfig(stored);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
  return settingsFromConfig(next);
}

function mergeColors(input: Record<string, unknown>): Record<string, unknown> {
  const colors: Record<string, unknown> = { ...input };
  for (const key of COLOR_KEYS) {
    colors[key] = resolveThemeColor(input[key], COLOR_DEFAULTS[key]);
  }
  return colors;
}

function mergeMarks(input: Record<string, unknown>): Record<string, unknown> {
  const marks: Record<string, unknown> = { ...input };
  for (const key of MARK_KEYS) {
    marks[key] = sanitizeMark(input[key], MARK_DEFAULTS[key]);
  }
  return marks;
}

export function sanitizeMark(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (value.length === 0 || CONTROL.test(value)) return fallback;
  if (value.includes("\u001b")) return fallback;
  const width = visibleWidth(value);
  if (width < 1) return fallback;
  if (width === 1) return value;
  return fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
