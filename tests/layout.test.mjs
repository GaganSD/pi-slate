import test from "node:test";
import assert from "node:assert/strict";
import {
  countSkillCommands,
  formatContextResources,
  formatContextTokens,
  formatContextUsed,
  formatCount,
  formatInteger,
  formatMcpConnected,
  formatPercent,
  formatSkillsLoaded,
  formatTokenCount,
  formatTokenCountWithRate,
  formatTokenRate,
  parseMcpConnectedCount,
  mainColumnWidth,
  workspaceColumnWidth,
} from "../extensions/sidebar/layout.ts";
import {
  FILES_WIDGET_MAX_LINES,
  filesWidgetDesiredHeight,
  sidebarDockLines,
  sidebarRowSlots,
  splitContentSlot,
  splitSidebarContent,
} from "../extensions/sidebar/workspace-layout.ts";

test("sidebar context labels match the OpenCode-style facts", () => {
  assert.equal(formatInteger(18958), "18,958");
  assert.equal(formatTokenCount(18958), "18,958 tokens");
  assert.equal(formatTokenCount(null), "— tokens");
  assert.equal(formatTokenRate(42.4), "42 tokens/sec");
  assert.equal(formatTokenRate(null), "— tokens/sec");
  assert.equal(formatTokenCountWithRate(3485, 42.4), "3,485 tokens · 42 tokens/sec");
  assert.equal(formatPercent(2.4), "2%");
  assert.equal(formatPercent(null), "—%");
  assert.equal(formatContextTokens(3485, 2.4, 42.4), "3,485 tokens (2%) · 42 tokens/sec");
  assert.equal(formatContextTokens(null, null, null), "— tokens (—%) · — tokens/sec");
  assert.equal(formatContextUsed(2.4), "2% used");
  assert.equal(formatContextUsed(null), "— used");
});

test("labels stay compact and safe with missing data", () => {
  assert.equal(formatCount(500_000), "500k");
  assert.equal(formatCount(1_250_000), "1.25m");
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
  assert.deepEqual(sidebarRowSlots(4), { contentHeight: 0, dockHeight: 4 });
  assert.deepEqual(sidebarRowSlots(5), { contentHeight: 1, dockHeight: 4 });
  assert.deepEqual(sidebarRowSlots(20), { contentHeight: 16, dockHeight: 4 });
  assert.equal(sidebarDockLines(), 4);
  assert.deepEqual(sidebarRowSlots(20, sidebarDockLines()), { contentHeight: 16, dockHeight: 4 });
  const content = sidebarRowSlots(24).contentHeight;
  assert.deepEqual(splitContentSlot(content, 1, true), { planHeight: 9, peekHeight: 10, dividerHeight: 1 });
});

test("MCP and skill counts share the Context resource line", () => {
  assert.equal(formatMcpConnected(0), "0 MCPs connected");
  assert.equal(formatMcpConnected(1), "1 MCPs connected");
  assert.equal(formatMcpConnected(2), "2 MCPs connected");
  assert.equal(formatSkillsLoaded(0), "0 skills loaded");
  assert.equal(formatSkillsLoaded(3), "3 skills loaded");
  assert.equal(formatContextResources(3, 2), "3 skills loaded · 2 MCPs connected");
  assert.equal(formatContextResources(0, null), "0 skills loaded · 0 MCPs connected");
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

test("sidebar content pins files at the top and always keeps plan and preview", () => {
  assert.deepEqual(splitSidebarContent(20, 5), {
    filesHeight: 5,
    filesDivider: 1,
    planHeight: 6,
    dividerHeight: 1,
    peekHeight: 7,
  });
  assert.deepEqual(splitSidebarContent(20, 2), {
    filesHeight: 2,
    filesDivider: 1,
    planHeight: 8,
    dividerHeight: 1,
    peekHeight: 8,
  });
  assert.deepEqual(splitSidebarContent(6, 5), {
    filesHeight: 4,
    filesDivider: 0,
    planHeight: 1,
    dividerHeight: 0,
    peekHeight: 1,
  });
  assert.deepEqual(splitSidebarContent(1, 2), {
    filesHeight: 1,
    filesDivider: 0,
    planHeight: 0,
    dividerHeight: 0,
    peekHeight: 0,
  });
});

test("content slot splits plan and peek evenly", () => {
  assert.deepEqual(splitContentSlot(10, 0, false), { planHeight: 0, peekHeight: 10, dividerHeight: 0 });
  assert.deepEqual(splitContentSlot(10, 8, false), { planHeight: 10, peekHeight: 0, dividerHeight: 0 });
  assert.deepEqual(splitContentSlot(10, 0, true), { planHeight: 0, peekHeight: 10, dividerHeight: 0 });
  assert.deepEqual(splitContentSlot(10, 1, true), { planHeight: 4, peekHeight: 5, dividerHeight: 1 });
  assert.deepEqual(splitContentSlot(11, 8, true), { planHeight: 5, peekHeight: 5, dividerHeight: 1 });
  assert.deepEqual(splitContentSlot(3, 8, true), { planHeight: 1, peekHeight: 1, dividerHeight: 1 });
  assert.deepEqual(splitContentSlot(2, 8, true), { planHeight: 1, peekHeight: 1, dividerHeight: 0 });
  assert.deepEqual(splitContentSlot(1, 8, true), { planHeight: 1, peekHeight: 0, dividerHeight: 0 });
  assert.deepEqual(splitContentSlot(0, 3, true), { planHeight: 0, peekHeight: 0, dividerHeight: 0 });
});
