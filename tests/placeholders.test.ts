import assert from "node:assert/strict";
import test from "node:test";
import {
  formatImageLocation,
  imageFileUrl,
  imageLinkMarkdown,
  imageTokenAtCursor,
  mimeTypeForImagePath,
  nextImageNumber,
  renderStoredImageTokens,
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

test("displays leftover clipboard paths as placeholders", () => {
  assert.equal(rewriteClipboardPaths(`look\n"${PATH}"`, 1, new Map()), "look\n[image-1]");
  assert.equal(rewriteClipboardPaths("already [image-1]", 2, new Map()), "already [image-1]");
});

test("attaches mapped images and rewrites leftover paths on submit", () => {
  const store = new Map<string, string>([["1", PATH]]);
  const result = transformSubmittedText(
    `compare [image-1] with ${PATH_2}`,
    store,
    fakeImage,
  );
  assert.equal(result.text, "compare [image-1] with [image-2]");
  assert.deepEqual(result.images, [fakeImage(PATH), fakeImage(PATH_2)]);
  assert.equal(store.get("2"), PATH_2);
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
  assert.equal(imageTokenAtCursor(text, { line: 0, col: 13 }), undefined);
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

test("nextImageNumber continues from the session store", () => {
  const store = new Map<string, string>([["4", PATH]]);
  assert.equal(nextImageNumber("", store), 5);
  assert.equal(nextImageNumber("see [image-2]", store), 5);
  assert.equal(nextImageNumber("see [image-9]", store), 10);
});

test("submitted tokens keep counting across messages", () => {
  const store = new Map<string, string>([["1", PATH]]);
  const first = transformSubmittedText(`look at this`, store, fakeImage);
  assert.equal(first.text, "look at this");

  const second = transformSubmittedText(`and ${PATH_2}`, store, fakeImage);
  assert.equal(second.text, `and [image-2]`);
});

test("renderStoredImageTokens upgrades stored tokens to file links", () => {
  const store = new Map<string, string>([["1", PATH]]);
  const rendered = renderStoredImageTokens("check [image-1] please", store);
  assert.equal(rendered, `check [image-1](${imageFileUrl(PATH)}) please`);
});

test("renderStoredImageTokens leaves unknown tokens alone", () => {
  assert.equal(renderStoredImageTokens("check [image-1] please", new Map()), "check [image-1] please");
});

test("renderStoredImageTokens links bare clipboard paths and reuses stored numbers", () => {
  const store = new Map<string, string>([["1", PATH]]);
  const rendered = renderStoredImageTokens(`see ${PATH} and ${PATH_2}`, store);
  assert.equal(rendered, `see [image-1](${imageFileUrl(PATH)}) and [image-2](${imageFileUrl(PATH_2)})`);
});

test("renderStoredImageTokens is idempotent across renders", () => {
  const store = new Map<string, string>([["1", PATH]]);
  const once = renderStoredImageTokens(`see ${PATH}`, store);
  assert.equal(renderStoredImageTokens(once, store), once);
});

test("renderStoredImageTokens escapes spaces in file paths", () => {
  const spaced = "/tmp/my screenshots/pi-clipboard-f2634509-b0a8-489a-85f7-ce9dc69b976a.png";
  const store = new Map<string, string>([["1", spaced]]);
  const rendered = renderStoredImageTokens("[image-1]", store);
  assert.equal(rendered, `[image-1](${imageFileUrl(spaced)})`);
  assert.ok(!rendered.includes(" "));
});

test("pasted transcript links are not rewritten inside their file url", () => {
  const store = new Map<string, string>();
  const link = `[image-1](${imageFileUrl(PATH)})`;
  assert.equal(rewriteClipboardPaths(`compare ${link}`, nextImageNumber("", store), store), `compare ${link}`);
});
