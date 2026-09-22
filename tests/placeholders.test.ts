import assert from "node:assert/strict";
import test from "node:test";
import {
  formatImageLocation,
  imageTokenAtCursor,
  mimeTypeForImagePath,
  nextImageNumber,
  noticeForInsert,
  rewriteClipboardPaths,
  transformSubmittedText,
  type ImageAttachment,
} from "../extensions/pi-slate/placeholders.ts";

const PATH =
  "/var/folders/rf/b88_3vnj1f51k8qv9wpz8gw00000gn/T/pi-clipboard-f2634509-b0a8-489a-85f7-ce9dc69b976a.png";
const PATH_2 =
  "/var/folders/rf/b88_3vnj1f51k8qv9wpz8gw00000gn/T/pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg";

function fakeImage(filePath: string): ImageAttachment {
  return { type: "image", data: `data:${filePath}`, mimeType: mimeTypeForImagePath(filePath) };
}

test("numbers placeholders from existing editor text", () => {
  assert.equal(nextImageNumber(""), 1);
  assert.equal(nextImageNumber("see [image 1] and [image-3]"), 4);
});

test("rewrites a pasted clipboard path to the next placeholder", () => {
  const store = new Map<string, string>();
  assert.equal(rewriteClipboardPaths(PATH, nextImageNumber(""), store), "[image-1]");
  assert.equal(store.get("1"), PATH);
  assert.equal(rewriteClipboardPaths(PATH_2, nextImageNumber("look at [image-1]\n"), store), "[image-2]");
  assert.equal(store.get("2"), PATH_2);
});

test("leaves ordinary pasted text alone", () => {
  const store = new Map<string, string>();
  assert.equal(rewriteClipboardPaths("hello", nextImageNumber(""), store), "hello");
  assert.equal(store.size, 0);
});

test("flushes a rewrite notice when the insert count crosses the interval", () => {
  // Input arrives in chunks, so the count skips over exact multiples.
  assert.equal(noticeForInsert(9, 8), undefined);
  assert.notEqual(noticeForInsert(12, 8), undefined);
  // One notice per interval crossed, not one per insert inside it.
  assert.equal(noticeForInsert(13, 12), undefined);
  assert.equal(noticeForInsert(19, 13), undefined);
  assert.notEqual(noticeForInsert(21, 19), undefined);
  // A fresh composer stays quiet until the first interval is reached.
  assert.equal(noticeForInsert(0, 0), undefined);
  assert.equal(noticeForInsert(4, 0), undefined);
});

test("cycles rewrite notices instead of repeating one", () => {
  const first = noticeForInsert(10, 9);
  const second = noticeForInsert(20, 19);
  assert.ok(first !== undefined && second !== undefined);
  assert.notEqual(first, second);
  // Single-step callers keep the original cadence.
  assert.equal(noticeForInsert(10), first);
});

test("previews percent-encoded clipboard paths", () => {
  const store = new Map<string, string>();
  assert.equal(rewriteClipboardPaths("/tmp/Screen%20Shot%202026-03-22.png", 1, store), "[image-1]");
  assert.equal(store.get("1"), "/tmp/Screen Shot 2026-03-22.png");
  assert.equal(rewriteClipboardPaths("file:///tmp/Screen%20Shot.png", 2, store), "[image-2]");
  assert.equal(store.get("2"), "/tmp/Screen Shot.png");
});

test("keeps raw clipboard paths that only look percent-encoded", () => {
  const store = new Map<string, string>();
  assert.equal(rewriteClipboardPaths("/tmp/50%%20off.png", 3, store), "[image-3]");
  assert.equal(store.get("3"), "/tmp/50%%20off.png");
});

test("previews screenshot paths with escaped spaces inside text", () => {
  const store = new Map<string, string>();
  const escaped =
    "/Users/melange/Desktop/screenshots/Screenshot\\ 2026-09-08\\ at\\ 14.02.06.jpeg";
  assert.equal(rewriteClipboardPaths(`see ${escaped} for the bug`, 1, store), "see [image-1] for the bug");
  assert.equal(store.get("1"), "/Users/melange/Desktop/screenshots/Screenshot 2026-09-08 at 14.02.06.jpeg");
});

test("previews backtick-quoted clipboard paths", () => {
  const store = new Map<string, string>();
  const spaced = "/Users/melange/Desktop/screenshots/Screenshot 2026-09-08 at 14.02.06.jpeg";
  assert.equal(rewriteClipboardPaths("paste `" + spaced + "` here", 1, store), "paste [image-1] here");
  assert.equal(store.get("1"), spaced);
});

test("rewrites a dropped image path to the next placeholder", () => {
  const dropped = "/Users/gagandevagiri/Downloads/images/4cef6d34aa241a4e98b472556ff933db.jpg";
  const spaced = "/Users/gagan/Desktop/Screenshot 2026-03-22 at 4.12.00 PM.png";
  const store = new Map<string, string>();
  assert.equal(rewriteClipboardPaths(dropped, 1, store), "[image-1]");
  assert.equal(store.get("1"), dropped);
  assert.equal(rewriteClipboardPaths(`'${spaced}'`, 2, store), "[image-2]");
  assert.equal(store.get("2"), spaced);
  assert.equal(rewriteClipboardPaths(`file://${dropped}`, 3, store), "[image-3]");
  assert.equal(rewriteClipboardPaths("notes /tmp/diagram.webp extra", 4, store), "notes [image-4] extra");
  assert.equal(store.get("4"), "/tmp/diagram.webp");
});

test("displays leftover clipboard paths as placeholders", () => {
  assert.equal(rewriteClipboardPaths(`look\n"${PATH}"`, 1, new Map()), "look\n[image-1]");
  assert.equal(rewriteClipboardPaths("already [image-1]", 2, new Map()), "already [image-1]");
});

test("attaches mapped images and rewrites leftover paths on submit", () => {
  const store = new Map<string, string>([["1", PATH]]);
  const dropped = "/tmp/screenshot.jpg";
  const result = transformSubmittedText(
    `compare [image-1] with ${PATH_2} and ${dropped}`,
    store,
    fakeImage,
  );
  assert.equal(result.text, "compare [image-1] with [image-2] and [image-3]");
  assert.deepEqual(result.images, [fakeImage(PATH), fakeImage(PATH_2), fakeImage(dropped)]);
  assert.equal(store.get("2"), PATH_2);
  assert.equal(store.get("3"), dropped);
});

test("formats clipboard image location details", () => {
  const location = formatImageLocation(PATH, "/Users/gagan", "1");
  assert.equal(location.name, "image-1.png");
  assert.equal(location.directory, "/var/folders/rf/b88_3vnj1f51k8qv9wpz8gw00000gn/T");
  assert.equal(location.kind, "PNG");
  assert.equal(location.source, "Clipboard");
  assert.equal(formatImageLocation(PATH_2, "/Users/gagan", "2").name, "image-2.jpg");
});

test("keeps ordinary image filenames", () => {
  const location = formatImageLocation("/tmp/screenshot.jpg", "/Users/gagan");
  assert.equal(location.name, "screenshot.jpg");
  assert.equal(location.kind, "JPEG");
  assert.equal(location.source, "File");
});

test("finds the image token under the caret", () => {
  const text = "see [image-1] and [image-2]";
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 4 }), "1");
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 12 }), "1");
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 13 }), "1");
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 14 }), undefined);
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 18 }), "2");
  assert.equal(imageTokenAtCursor("look\n[image-3]", { line: 1, col: 0 }), "3");
  assert.equal(imageTokenAtCursor("look\n[image-3]", { line: 0, col: 1 }), undefined);
  assert.equal(imageTokenAtCursor("old [image 1]", { line: 0, col: 5 }), "1");
});

test("skips missing files without dropping the path", () => {
  const store = new Map<string, string>([["1", PATH]]);
  const result = transformSubmittedText("[image-1]", store, () => undefined);
  assert.equal(result.text, "[image-1]");
  assert.deepEqual(result.images, []);

  const leftover = transformSubmittedText(PATH, new Map(), () => undefined);
  assert.equal(leftover.text, PATH);
  assert.deepEqual(leftover.images, []);
});
