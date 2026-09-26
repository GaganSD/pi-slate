import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  COMPOSER_HINT,
  composerLabels,
  composerPaddingX,
  frameComposerLines,
  inscribedBorder,
} from "../extensions/pi-slate/composer.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = {
  fg: (_name: string, text: string) => text,
} as Theme;

test("composer padding follows density", () => {
  assert.equal(composerPaddingX("comfortable"), 4);
  assert.equal(composerPaddingX("compact"), 2);
});

test("inscribed border keeps rounded corners and truncates the right label first", () => {
  const line = inscribedBorder(" left ", " right ", 16, (text) => text, "╰", "╯");
  assert.equal(line[0], "╰");
  assert.equal(line.at(-1), "╯");
  assert.ok(line.includes("left"));
  const squeezed = inscribedBorder(" project / main ", " model · high ", 18, (text) => text, "╰", "╯");
  assert.equal(visibleWidth(squeezed), 18);
  assert.ok(squeezed.startsWith("╰"));
  assert.ok(squeezed.endsWith("╯"));
  assert.ok(squeezed.includes("project"));
});

test("composer labels hide model on minimal footer and at narrow widths", () => {
  const wide = composerLabels(
    { project: "pi-configs", branch: "main", model: "grok-4.6", thinking: "medium", footer: "standard" },
    theme,
    100,
  );
  assert.match(wide.left, /pi-configs \/ main/);
  assert.match(wide.right, /grok-4.6/);
  assert.match(wide.right, /medium/);

  const minimal = composerLabels(
    { project: "pi-configs", branch: "main", model: "grok-4.6", thinking: "medium", footer: "minimal" },
    theme,
    100,
  );
  assert.equal(minimal.right, "");

  const narrow = composerLabels(
    { project: "pi-configs", branch: "main", model: "grok-4.6", thinking: "medium", footer: "standard" },
    theme,
    40,
  );
  assert.match(narrow.left, /pi-configs/);
  assert.doesNotMatch(narrow.left, /main/);
  assert.equal(narrow.right, "");
});

test("empty composer frames sides, prompt, and send hint", () => {
  const width = 40;
  const lines = frameComposerLines(
    ["╭" + "─".repeat(width - 2) + "╮", " ".repeat(width), "╰" + "─".repeat(width - 2) + "╯"],
    { width, empty: true, paddingX: 4, hint: COMPOSER_HINT, paint: (text) => text },
  );
  assert.equal(lines.length, 4);
  assert.equal(stripVTControlCharacters(lines[1] ?? "").startsWith("│ ›"), true);
  assert.equal(stripVTControlCharacters(lines[1] ?? "").endsWith("│"), true);
  assert.match(stripVTControlCharacters(lines[2] ?? ""), /↵ send {2}· esc/);
  assert.equal(visibleWidth(lines[2] ?? ""), width);
});

test("composer keeps a one-cell reverse cursor", () => {
  const width = 24;
  const cursorLine = `    \x1b[7m \x1b[0m${" ".repeat(width - 5)}`;
  const lines = frameComposerLines(
    ["╭" + "─".repeat(width - 2) + "╮", cursorLine, "╰" + "─".repeat(width - 2) + "╯"],
    { width, empty: false, paddingX: 4, hint: COMPOSER_HINT, paint: (text) => text },
  );
  const body = lines[1] ?? "";
  assert.match(body, /\x1b\[7m \x1b\[0m/);
  assert.doesNotMatch(body, /\x1b\[7m {2,}/);
  assert.equal(visibleWidth(body), width);
});

test("typed composer drops the prompt and hint", () => {
  const width = 20;
  const lines = frameComposerLines(
    ["╭" + "─".repeat(width - 2) + "╮", "    hello           ", "╰" + "─".repeat(width - 2) + "╯"],
    { width, empty: false, paddingX: 4, hint: COMPOSER_HINT, paint: (text) => text },
  );
  assert.equal(lines.length, 3);
  const body = stripVTControlCharacters(lines[1] ?? "");
  assert.equal(body.startsWith("│"), true);
  assert.doesNotMatch(body, /›/);
  assert.doesNotMatch(lines.join("\n"), /send/);
});


