import assert from "node:assert/strict";
import test from "node:test";
import { ImagePeek } from "../extensions/sidebar/image-peek.ts";
import type { ImageAttachment } from "../extensions/sidebar/placeholders.ts";
import type { WorkspaceView } from "../extensions/sidebar/workspace.ts";

const PATH = "/tmp/pi-clipboard-11111111-2222-3333-4444-555555555555.png";

function fakeSidebar() {
  let view: WorkspaceView | undefined;
  return {
    view: () => view,
    requireTheme: () => ({
      fg: (_token: string, text: string) => text,
      bold: (text: string) => text,
    }),
    currentViewId: () => view?.id,
    setView(next: WorkspaceView | undefined) {
      view = next;
    },
    copyPath() {},
  };
}

test("caret on an image token shows that file in Preview", () => {
  const sidebar = fakeSidebar();
  const store = new Map([["1", PATH]]);
  const peek = new ImagePeek(
    store,
    sidebar as never,
    (): ImageAttachment => ({ type: "image", data: "aaaa", mimeType: "image/png" }),
  );
  peek.update({ getText: () => "see [image-1]", getCursor: () => ({ line: 0, col: 4 }) });
  assert.equal(sidebar.currentViewId(), `image:1:${PATH}`);
});

test("moving the caret off the token clears Preview", () => {
  const sidebar = fakeSidebar();
  const store = new Map([["1", PATH]]);
  const peek = new ImagePeek(
    store,
    sidebar as never,
    (): ImageAttachment => ({ type: "image", data: "aaaa", mimeType: "image/png" }),
  );
  peek.update({ getText: () => "see [image-1] later", getCursor: () => ({ line: 0, col: 4 }) });
  assert.ok(sidebar.currentViewId());
  peek.update({ getText: () => "see [image-1] later", getCursor: () => ({ line: 0, col: 0 }) });
  assert.equal(sidebar.currentViewId(), undefined);
});
