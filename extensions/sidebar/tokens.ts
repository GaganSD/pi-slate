import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export const THEME_COLOR_NAMES = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "scrollbarTrack",
  "scrollbarThumb",
  "searchMatchText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
] as const satisfies readonly ThemeColor[];

const THEME_COLOR_SET = new Set<string>(THEME_COLOR_NAMES);

export function isThemeColor(value: unknown): value is ThemeColor {
  return typeof value === "string" && THEME_COLOR_SET.has(value);
}

export function resolveThemeColor(value: unknown, fallback: ThemeColor): ThemeColor {
  return isThemeColor(value) ? value : fallback;
}

export function paint(theme: Theme, color: ThemeColor, text: string): string {
  return theme.fg(color, text);
}

export function paintBold(theme: Theme, color: ThemeColor, text: string): string {
  return theme.bold(theme.fg(color, text));
}

export function ruleChars(ascii: boolean): { vertical: string; horizontal: string } {
  return ascii ? { vertical: "|", horizontal: "-" } : { vertical: "│", horizontal: "─" };
}
