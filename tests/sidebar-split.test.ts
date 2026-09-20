import assert from "node:assert/strict";
import test from "node:test";
import {
  bindSplitHost,
  hasForeignSplitOwner,
  SET_LAYOUT_ROOT,
  SPLIT_OWNER,
} from "../extensions/sidebar/split-host.ts";

type Node = { id: string; child?: Node };

function wrap(pane: string) {
  return (component: Node | undefined): Node | undefined => {
    if (!component) return component;
    const chat = component.child ?? component;
    return { id: pane, child: chat.id === "chat" ? chat : component.child };
  };
}

function unwrap(component: Node | undefined): Node | undefined {
  return component?.child ?? component;
}

function createHost(chat: Node) {
  return {
    layoutRoot: chat as Node | undefined,
    setLayoutRoot(component: Node | undefined) {
      this.layoutRoot = component;
    },
  };
}

test("a later remount takes over the live pane", () => {
  const chat = { id: "chat" };
  const host = createHost(chat);

  const staleDispose = bindSplitHost(host, wrap("stale"), unwrap);
  assert.ok(staleDispose);
  assert.equal(host.layoutRoot?.id, "stale");
  assert.equal(host.layoutRoot?.child, chat);

  const liveDispose = bindSplitHost(host, wrap("live"), unwrap);
  assert.ok(liveDispose);
  assert.equal(host.layoutRoot?.id, "live");
  assert.equal(host.layoutRoot?.child, chat);

  staleDispose();
  assert.equal(host.layoutRoot?.id, "live");
  assert.equal(host.layoutRoot?.child, chat);

  liveDispose();
  assert.equal(host.layoutRoot, chat);
});

test("disposing the current split unwraps the original chat root", () => {
  const chat = { id: "chat" };
  const host = createHost(chat);
  const dispose = bindSplitHost(host, wrap("pane"), unwrap);
  assert.ok(dispose);
  assert.notEqual(host.layoutRoot, chat);
  dispose();
  assert.equal(host.layoutRoot, chat);
});

test("foreign split owner fails closed and does not wrap", () => {
  const chat = { id: "chat" };
  const host = Object.assign(createHost(chat), {
    [Symbol.for("pi-minimal-ui.sidebar-split-owner")]: {},
  });
  assert.equal(hasForeignSplitOwner(host), true);
  const dispose = bindSplitHost(host, wrap("pane"), unwrap);
  assert.equal(dispose, undefined);
  assert.equal(host.layoutRoot, chat);
  assert.equal((host as { [SPLIT_OWNER]?: object })[SPLIT_OWNER], undefined);
  assert.equal((host as { [SET_LAYOUT_ROOT]?: unknown })[SET_LAYOUT_ROOT], undefined);
});

test("foreign setLayoutRoot symbol fails closed", () => {
  const chat = { id: "chat" };
  const original = (component: Node | undefined) => {
    host.layoutRoot = component;
  };
  const host = Object.assign(createHost(chat), {
    [Symbol.for("pi-minimal-ui.setLayoutRoot")]: original,
  });
  assert.equal(hasForeignSplitOwner(host), true);
  assert.equal(bindSplitHost(host, wrap("pane"), unwrap), undefined);
  assert.equal(host.layoutRoot, chat);
});

test("stale local symbols plus a foreign owner still fail closed", () => {
  const chat = { id: "chat" };
  const host = Object.assign(createHost(chat), {
    [SPLIT_OWNER]: {},
    [SET_LAYOUT_ROOT]: (component: Node | undefined) => {
      host.layoutRoot = component;
    },
    [Symbol.for("pi-minimal-ui.sidebar-split-owner")]: {},
  });
  assert.equal(hasForeignSplitOwner(host), true);
  assert.equal(bindSplitHost(host, wrap("pane"), unwrap), undefined);
  assert.equal(host.layoutRoot, chat);
});

test("same-package remount still works when we already own the root", () => {
  const chat = { id: "chat" };
  const host = createHost(chat);
  const first = bindSplitHost(host, wrap("one"), unwrap);
  assert.ok(first);
  assert.equal(hasForeignSplitOwner(host), false);
  const second = bindSplitHost(host, wrap("two"), unwrap);
  assert.ok(second);
  assert.equal(host.layoutRoot?.id, "two");
  first();
  assert.equal(host.layoutRoot?.id, "two");
  second();
  assert.equal(host.layoutRoot, chat);
});
