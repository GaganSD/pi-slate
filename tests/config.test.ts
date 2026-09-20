import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SIDEBAR_SETTINGS,
  loadSidebarConfig,
  normalizeSidebarConfig,
  saveSidebarConfig,
  sanitizeMark,
  settingsFromConfig,
} from "../extensions/sidebar/config.ts";

test("missing and malformed files become defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidebar-config-"));
  const missing = loadSidebarConfig(join(dir, "missing.json"));
  assert.deepEqual(missing.settings, DEFAULT_SIDEBAR_SETTINGS);

  const badPath = join(dir, "bad.json");
  writeFileSync(badPath, "{not json", "utf8");
  const bad = loadSidebarConfig(badPath);
  assert.deepEqual(bad.settings, DEFAULT_SIDEBAR_SETTINGS);
});

test("sparse merge preserves unknown keys and fills defaults", () => {
  const merged = normalizeSidebarConfig({
    widthPercent: 33,
    extra: true,
    colors: { heading: "accent", pluginHue: "keep" },
    marks: { fileNew: "A", extraMark: "z" },
  });
  assert.equal(merged.enabled, true);
  assert.equal(merged.widthPercent, 33);
  assert.equal(merged.filesMaxLines, 5);
  assert.equal(merged.extra, true);
  assert.equal((merged.colors as { heading: string }).heading, "accent");
  assert.equal((merged.colors as { body: string }).body, "muted");
  assert.equal((merged.colors as { pluginHue: string }).pluginHue, "keep");
  assert.equal((merged.marks as { fileNew: string }).fileNew, "A");
  assert.equal((merged.marks as { extraMark: string }).extraMark, "z");
});

test("numeric settings clamp to documented bounds", () => {
  const low = settingsFromConfig({
    widthPercent: 1,
    minWidth: 2,
    minTerminalWidth: 10,
    filesMaxLines: 1,
  });
  assert.equal(low.widthPercent, 10);
  assert.equal(low.minWidth, 16);
  assert.equal(low.minTerminalWidth, 40);
  assert.equal(low.filesMaxLines, 2);

  const high = settingsFromConfig({
    widthPercent: 90,
    minWidth: 200,
    minTerminalWidth: 400,
    filesMaxLines: 99,
  });
  assert.equal(high.widthPercent, 40);
  assert.equal(high.minWidth, 80);
  assert.equal(high.minTerminalWidth, 200);
  assert.equal(high.filesMaxLines, 20);
});

test("invalid colors fall back to defaults", () => {
  const settings = settingsFromConfig({
    colors: {
      heading: "#ff00aa",
      body: "muted",
      fileNew: "not-a-token",
    },
  });
  assert.equal(settings.colors.heading, "text");
  assert.equal(settings.colors.body, "muted");
  assert.equal(settings.colors.fileNew, "success");
});

test("marks reject empty, control, escape, and wide values", () => {
  assert.equal(sanitizeMark("", "N"), "N");
  assert.equal(sanitizeMark("\u001b[31mX", "N"), "N");
  assert.equal(sanitizeMark("\n", "N"), "N");
  assert.equal(sanitizeMark("NM", "N"), "N");
  assert.equal(sanitizeMark("漢", "N"), "N");
  assert.equal(sanitizeMark("A", "N"), "A");
  assert.equal(sanitizeMark("*", "o"), "*");
});

test("ascii settings stay boolean and keep unicode defaults until applied", () => {
  const settings = settingsFromConfig({ ascii: true });
  assert.equal(settings.ascii, true);
  assert.equal(settings.marks.planPending, "○");
  assert.equal(settings.marks.planActive, "◐");
  assert.equal(settings.marks.planDone, "✓");
});

test("save is atomic and keeps unknown keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidebar-config-"));
  const path = join(dir, "sidebar.json");
  saveSidebarConfig({ widthPercent: 25, keepMe: "yes" }, path);
  const written = JSON.parse(readFileSync(path, "utf8")) as { widthPercent: number; keepMe: string; enabled: boolean };
  assert.equal(written.widthPercent, 25);
  assert.equal(written.keepMe, "yes");
  assert.equal(written.enabled, true);
  const reloaded = loadSidebarConfig(path);
  assert.equal(reloaded.settings.widthPercent, 25);
  assert.equal(reloaded.stored.keepMe, "yes");
});
