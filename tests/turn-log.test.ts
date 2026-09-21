import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TurnLogView, wrapLines } from "../extensions/pi-minimal-ui/turn-log.ts";
import type { TurnEvent } from "../extensions/pi-minimal-ui/turn-impact.ts";

function theme(): Theme {
  return {
    fg: (_color, text) => text,
    bold: (text) => text,
  } as Theme;
}

function event(id: string, toolName: string, title = toolName): TurnEvent {
  return { id, toolName, title, detail: `full ${id}\nmore`, isError: false, pending: false };
}

test("wrapLines splits on width and keeps blank lines", () => {
  assert.deepEqual(wrapLines("abcdef", 3), ["abc", "def"]);
  assert.deepEqual(wrapLines("a\n\nb", 8), ["a", "", "b"]);
});

test("turn log lists a filter and expands the full message on click", () => {
  const view = new TurnLogView("tool", [event("1", "read", "read a.ts"), event("2", "bash", "bash ls")], theme());
  const collapsed = view.render(40, 4);
  assert.match(collapsed[0] ?? "", /tools called · 2/);
  assert.match(collapsed[1] ?? "", /▸ read a.ts/);
  assert.equal(view.handleClick(0, 1), true);
  const expanded = view.render(40, 6);
  assert.match(expanded[1] ?? "", /▾ read a.ts/);
  assert.match(expanded[2] ?? "", /full 1/);
  assert.match(expanded[3] ?? "", /more/);
});

test("turn log wheel scrolls the flattened list", () => {
  const events = ["a", "b", "c", "d"].map((id) => event(id, "bash", `bash ${id}`));
  const view = new TurnLogView("shell", events, theme());
  view.render(20, 2);
  assert.equal(view.handleWheel(1), true);
  const lines = view.render(20, 2);
  assert.match(lines[0] ?? "", /▸ bash a/);
});
