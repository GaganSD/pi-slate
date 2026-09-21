import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Sidebar } from "../extensions/pi-minimal-ui/sidebar.ts";
import { DiffWorkspaceView, type WorkspaceView } from "../extensions/pi-minimal-ui/workspace.ts";
import type { FileChange } from "../extensions/pi-minimal-ui/files-modified.ts";

function theme(): Theme {
  return {
    fg: (color, text) => `[${color}]${text}`,
    bold: (text) => text,
  } as Theme;
}

function view(id: string): WorkspaceView {
  return { id, render: () => [id], invalidate() {} };
}

function mouse(partial: Partial<TuiMouseEvent> & Pick<TuiMouseEvent, "type" | "y">): TuiMouseEvent {
  return {
    button: "left",
    x: 2,
    screenX: 2,
    screenY: partial.y,
    width: 40,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    ...partial,
  };
}

function attachSidebar(): Sidebar {
  const sidebar = new Sidebar();
  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
    showOverlay() {
      return { hide() {} };
    },
  } as unknown as TUI;
  sidebar.attach(tui, theme());
  return sidebar;
}

test("DiffWorkspaceView highlights added, removed, and context lines", () => {
  const preview = new DiffWorkspaceView(
    "a.ts",
    "diff",
    ["diff --git a/a.ts b/a.ts", "@@ -1,1 +1,2 @@", " context", "-removed", "+added"].join("\n"),
    theme(),
  );
  assert.equal(preview.id, "diff:a.ts:diff");
  assert.deepEqual(preview.render(80, 5), [
    "[dim]diff --git a/a.ts b/a.ts",
    "[accent]@@ -1,1 +1,2 @@",
    "[toolDiffContext] context",
    "[toolDiffRemoved]-removed",
    "[toolDiffAdded]+added",
  ]);
  assert.deepEqual(new DiffWorkspaceView("a.ts", "loading", "", theme()).render(80, 1), [
    "[toolDiffContext]Loading change…",
  ]);
});

test("a selected file preview returns after a temporary image peek", () => {
  const sidebar = new Sidebar();
  const fileView = view("diff:a.ts:diff");
  const imageView = view("image:1:/tmp/pic.png");

  sidebar.setSelectedPreview(fileView);
  assert.equal(sidebar.currentViewId(), "diff:a.ts:diff");

  sidebar.setView(imageView);
  assert.equal(sidebar.currentViewId(), "image:1:/tmp/pic.png");

  sidebar.setView(undefined);
  assert.equal(sidebar.currentViewId(), "diff:a.ts:diff");
});

test("clicking a changed file selects it instead of copying its path", () => {
  const sidebar = attachSidebar();
  const selected: FileChange[] = [];
  const copied: string[] = [];
  sidebar.setActions({
    copyPath: (filePath) => copied.push(filePath),
    selectFile: (file) => selected.push(file),
  });
  sidebar.setFiles([
    { index: " ", worktree: "M", path: "src/a.ts" },
    { index: "?", worktree: "?", path: "src/b.ts" },
  ]);
  sidebar.render(40);

  const heading = sidebar.handleMouse(mouse({ type: "click", y: 2 }));
  assert.equal(heading, undefined);
  const first = sidebar.handleMouse(mouse({ type: "click", y: 3 }));
  assert.deepEqual(first, { handled: true });
  assert.equal(selected[0]?.path, "src/a.ts");
  assert.deepEqual(copied, []);
});

test("summary leaves blank lines between its sections", () => {
  const sidebar = attachSidebar();
  sidebar.setFiles([
    { index: " ", worktree: "M", path: "src/a.ts" },
    { index: "?", worktree: "?", path: "src/b.ts" },
  ]);
  sidebar.setTurnImpact({
    revision: 1,
    filesRead: 1,
    toolsCalled: 6,
    shellCommands: 5,
    subagentsSpawned: 0,
    events: [],
  });
  const labels = sidebar.render(40).map((line) => line.replace(/\[\w+\]/g, "").replace(/^│\s?/, ""));
  const summary = labels.indexOf("Summary");
  const files = labels.indexOf("Files Changed · 2");
  const lastTurn = labels.indexOf("Last Turn");
  assert.ok(summary >= 0 && files === summary + 2);
  assert.equal(labels[summary + 1], "");
  assert.ok(lastTurn > files);
  assert.equal(labels[lastTurn - 1], "");
  assert.equal(labels[lastTurn + 1], "");
  assert.equal(labels[lastTurn + 2], "1 file read");
  assert.equal(labels[lastTurn + 3], "6 tools called");
  assert.equal(labels[lastTurn + 4], "5 shell commands");
  assert.equal(labels[lastTurn + 5], "0 subagents spawned");
});

test("clicking a last-turn fact opens that list in Preview", () => {
  const sidebar = attachSidebar();
  sidebar.setTurnImpact({
    revision: 1,
    filesRead: 1,
    toolsCalled: 1,
    shellCommands: 0,
    subagentsSpawned: 0,
    events: [{ id: "r1", toolName: "read", title: "read a.ts", detail: "full read", isError: false, pending: false }],
  });
  const labels = sidebar.render(40).map((line) => line.replace(/\[\w+\]/g, "").replace(/^│\s?/, ""));
  const lastTurn = labels.indexOf("Last Turn");
  assert.deepEqual(sidebar.handleMouse(mouse({ type: "click", y: lastTurn + 2 })), { handled: true, render: true });
  assert.equal(sidebar.currentViewId(), "turn:read");
  const preview = sidebar.render(40).map((line) => line.replace(/\[\w+\]/g, "")).join("\n");
  assert.match(preview, /read a.ts/);
});
