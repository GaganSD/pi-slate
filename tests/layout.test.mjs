import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_LOGO,
  PI_LOGO_ASCII,
  centerOffset,
  compactPath,
  footerVisibility,
  countSkillCommands,
  formatContextMeta,
  formatContextResources,
  formatContextUsage,
  formatInteger,
  formatMcpConnected,
  formatPercent,
  formatSkillsLoaded,
  formatSpend,
  formatTokenCount,
  formatTokenRate,
  parseMcpConnectedCount,
  mainColumnWidth,
  modelLabel,
  workspaceColumnWidth,
} from "../extensions/pi-minimal-ui/layout.ts";
import {
  FILES_WIDGET_MAX_LINES,
  filesWidgetDesiredHeight,
  fitImageCells,
  placeWorkspaceImage,
  sidebarDockLines,
  sidebarRowSlots,
  splitSidebarContent,
  workspacePaneSlots,
} from "../extensions/pi-minimal-ui/workspace-layout.ts";

test("logo preserves the official four-row geometry and terminal aspect ratio", () => {
  assert.deepEqual(PI_LOGO, ["██████  ", "██  ██  ", "████  ██", "██    ██"]);
  assert.deepEqual(PI_LOGO_ASCII, ["######  ", "##  ##  ", "####  ##", "##    ##"]);
  assert.ok(PI_LOGO.every((line) => line.length === 8));
  assert.ok(PI_LOGO_ASCII.every((line) => line.length === 8));
  assert.ok(PI_LOGO_ASCII.every((line) => /^[ #]+$/.test(line)));
});

test("header content is centered without negative padding", () => {
  assert.equal(centerOffset(190, 78), 56);
  assert.equal(centerOffset(79, 78), 0);
  assert.equal(centerOffset(40, 78), 0);
});

test("footer progressively reveals optional metadata", () => {
  assert.deepEqual(footerVisibility(40), {
    showBranch: false,
    showModel: false,
    showThinking: false,
  });
  assert.deepEqual(footerVisibility(100), {
    showBranch: true,
    showModel: true,
    showThinking: true,
  });
});

test("sidebar context labels match the OpenCode-style facts", () => {
  assert.equal(formatInteger(18958), "18,958");
  assert.equal(formatTokenCount(18958), "18,958 tokens");
  assert.equal(formatTokenCount(null), "— tokens");
  assert.equal(formatTokenRate(42.4), "42/s");
  assert.equal(formatTokenRate(null), "—/s");
  assert.equal(formatPercent(2.4), "2%");
  assert.equal(formatPercent(null), "—%");
  assert.equal(formatSpend(1.234), "$1.23");
  assert.equal(formatSpend(null), "$0.00");
  assert.equal(formatContextUsage(3485, 2.4, 1.234), "3,485 tokens (2%) · $1.23");
  assert.equal(formatContextUsage(null, null, null), "— tokens (—%) · $0.00");
  assert.equal(formatContextMeta(42.4, 12, 0), "42/s · 12 skills · 0 MCPs");
});

test("model label stays safe with missing data", () => {
  assert.equal(modelLabel(undefined), "no model");
});

test("workspace column is 20% once the terminal is wide enough", () => {
  assert.equal(workspaceColumnWidth(50), 0);
  assert.equal(workspaceColumnWidth(100), 28);
  assert.equal(workspaceColumnWidth(200), 40);
  assert.equal(workspaceColumnWidth(203), 40);
  assert.equal(mainColumnWidth(200), 160);
});

test("sidebar rows pin the footer dock and give the rest to content", () => {
  assert.deepEqual(sidebarRowSlots(0), { contentHeight: 0, dockHeight: 0 });
  assert.deepEqual(sidebarRowSlots(2), { contentHeight: 0, dockHeight: 2 });
  assert.deepEqual(sidebarRowSlots(5), { contentHeight: 3, dockHeight: 2 });
  assert.deepEqual(sidebarRowSlots(20), { contentHeight: 18, dockHeight: 2 });
  assert.equal(sidebarDockLines(), 2);
  assert.deepEqual(sidebarRowSlots(20, sidebarDockLines()), { contentHeight: 18, dockHeight: 2 });
});

test("MCP and skill counts share the Context resource line", () => {
  assert.equal(formatMcpConnected(0), "0 MCPs");
  assert.equal(formatMcpConnected(1), "1 MCPs");
  assert.equal(formatMcpConnected(2), "2 MCPs");
  assert.equal(formatSkillsLoaded(0), "0 skills");
  assert.equal(formatSkillsLoaded(3), "3 skills");
  assert.equal(formatContextResources(3, 2), "3 skills · 2 MCPs");
  assert.equal(formatContextResources(0, null), "0 skills · 0 MCPs");
  assert.equal(countSkillCommands([
    { source: "skill", sourceInfo: { path: "/skills/a/SKILL.md" }, name: "a" },
    { source: "skill", sourceInfo: { path: "/skills/a/SKILL.md" }, name: "a:1" },
    { source: "extension", sourceInfo: { path: "/ext.ts" }, name: "minimal-ui" },
  ]), 1);
  assert.equal(parseMcpConnectedCount({ connectedCount: 2 }), 2);
  assert.equal(parseMcpConnectedCount({ connectedCount: -1 }), 0);
  assert.equal(parseMcpConnectedCount({}), null);
  assert.equal(parseMcpConnectedCount(null), null);
});

test("files widget stays compact and never exceeds five lines", () => {
  assert.equal(FILES_WIDGET_MAX_LINES, 5);
  assert.equal(filesWidgetDesiredHeight(0), 2);
  assert.equal(filesWidgetDesiredHeight(1), 2);
  assert.equal(filesWidgetDesiredHeight(4), 5);
  assert.equal(filesWidgetDesiredHeight(12), 5);
});

test("sidebar content uses a compact summary and retains Preview", () => {
  for (const height of [1, 2, 6, 20]) {
    const slots = splitSidebarContent(height, 5);
    assert.equal("reservedHeight" in slots, false);
    assert.ok(slots.filesHeight <= FILES_WIDGET_MAX_LINES);
    assert.ok(slots.summaryHeight >= 0 && slots.dividerHeight >= 0 && slots.peekHeight >= 0);
    assert.equal(slots.summaryHeight + slots.dividerHeight + slots.peekHeight, height);
    assert.ok(slots.peekHeight >= 1);
  }
  assert.deepEqual(splitSidebarContent(20, 5), {
    summaryHeight: 13, filesHeight: 5, dividerHeight: 1, peekHeight: 6,
  });
  assert.deepEqual(splitSidebarContent(6, 5), {
    summaryHeight: 4, filesHeight: 1, dividerHeight: 1, peekHeight: 1,
  });
  assert.deepEqual(splitSidebarContent(3, 5), {
    summaryHeight: 1, filesHeight: 0, dividerHeight: 1, peekHeight: 1,
  });
});

test("workspace pane always reserves caption rows", () => {
  assert.deepEqual(workspacePaneSlots(0), { imageHeight: 0, captionHeight: 0 });
  assert.deepEqual(workspacePaneSlots(1), { imageHeight: 0, captionHeight: 1 });
  assert.deepEqual(workspacePaneSlots(3), { imageHeight: 2, captionHeight: 1 });
  assert.deepEqual(workspacePaneSlots(4), { imageHeight: 3, captionHeight: 1 });
  assert.deepEqual(workspacePaneSlots(20), { imageHeight: 19, captionHeight: 1 });
});

test("images contain-fit and never upscale", () => {
  assert.deepEqual(fitImageCells(10, 10, 40, 20, 9, 18), { columns: 2, rows: 1 });
  assert.deepEqual(fitImageCells(4000, 3000, 36, 20, 9, 18), { columns: 36, rows: 14 });
  assert.deepEqual(fitImageCells(4000, 1000, 36, 20, 9, 18), { columns: 36, rows: 5 });
  assert.deepEqual(fitImageCells(800, 600, 0, 20), { columns: 0, rows: 0 });
});

test("image and caption sit on the bottom of the workspace pane", () => {
  const placed = placeWorkspaceImage(8, 2, ["meta", "name", "dir"]);
  assert.equal(placed.lines.length, 8);
  assert.equal(placed.imageStart, 3);
  assert.equal(placed.imageRows, 2);
  assert.equal(placed.captionStart, 5);
  assert.deepEqual(placed.lines.slice(5), ["meta", "name", "dir"]);
  assert.equal(placed.lines[0], "");
  assert.equal(placed.lines[2], "");
});

test("a full-height image still keeps the caption underneath", () => {
  const placed = placeWorkspaceImage(8, 20, ["meta", "name", "dir"]);
  assert.equal(placed.imageStart, 0);
  assert.equal(placed.imageRows, 5);
  assert.deepEqual(placed.lines.slice(5), ["meta", "name", "dir"]);
});

test("home paths use a tilde without rewriting lookalikes", () => {
  assert.equal(compactPath("/Users/gagan/GitHub/pi", "/Users/gagan"), "~/GitHub/pi");
  assert.equal(compactPath("/Users/gagandev/pi", "/Users/gagan"), "/Users/gagandev/pi");
});
