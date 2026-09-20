import assert from "node:assert/strict";
import test from "node:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  isThemeColor,
  paint,
  paintBold,
  resolveThemeColor,
  ruleChars,
} from "../extensions/sidebar/tokens.ts";

function fakeTheme(): Theme {
  return {
    fg(color: ThemeColor, text: string) {
      return `[${color}]${text}`;
    },
    bold(text: string) {
      return `*${text}*`;
    },
  } as Theme;
}

test("resolveThemeColor accepts Theme API tokens and falls back otherwise", () => {
  assert.equal(isThemeColor("text"), true);
  assert.equal(isThemeColor("borderMuted"), true);
  assert.equal(isThemeColor("accent"), true);
  assert.equal(isThemeColor("#ff00aa"), false);
  assert.equal(isThemeColor("not-a-token"), false);
  assert.equal(isThemeColor(""), false);
  assert.equal(isThemeColor(1), false);
  assert.equal(resolveThemeColor("warning", "text"), "warning");
  assert.equal(resolveThemeColor("#fff", "muted"), "muted");
  assert.equal(resolveThemeColor("hotpink", "error"), "error");
});

test("paint goes through theme.fg and theme.bold", () => {
  const theme = fakeTheme();
  assert.equal(paint(theme, "muted", "body"), "[muted]body");
  assert.equal(paintBold(theme, "text", "Files"), "*[text]Files*");
});

test("ascii rules use pipe and hyphen", () => {
  assert.deepEqual(ruleChars(false), { vertical: "│", horizontal: "─" });
  assert.deepEqual(ruleChars(true), { vertical: "|", horizontal: "-" });
});
