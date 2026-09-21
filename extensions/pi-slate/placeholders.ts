import { compactPath } from "./layout.ts";

export const CLIPBOARD_PATH_RE =
  /"?((?:\/|[A-Za-z]:\\)[^\s"'`]*[/\\]pi-clipboard-[0-9a-fA-F-]+\.(?:png|jpe?g|webp|gif))"?/g;

export type ImageAttachment = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ImagePathStore = Map<string, string>;

function imageToken(number: number | string): string {
  return `[image-${number}]`;
}

export function nextImageNumber(text: string): number {
  let max = 0;
  for (const match of text.matchAll(/\[image[ -](\d+)\]/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function imageTokenAtCursor(
  text: string,
  cursor: { line: number; col: number },
): string | undefined {
  const line = text.split("\n")[cursor.line];
  if (line === undefined) return undefined;
  for (const match of line.matchAll(/\[image[ -](\d+)\]/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (cursor.col >= start && cursor.col < end) return match[1];
  }
  return undefined;
}

function storedNumberForPath(store: ImagePathStore, filePath: string): string | undefined {
  for (const [number, storedPath] of store) {
    if (storedPath === filePath) return number;
  }
  return undefined;
}

export function formatImageLocation(
  filePath: string,
  home?: string,
  number?: string,
): { name: string; directory: string; kind: string; source: string } {
  const rawName = filePath.replace(/^.*[/\\]/, "");
  const directory = filePath.slice(0, Math.max(0, filePath.length - rawName.length - 1));
  const kind = mimeTypeForImagePath(filePath).replace("image/", "").toUpperCase();
  const clipboard = rawName.startsWith("pi-clipboard-");
  const ext = rawName.includes(".") ? rawName.slice(rawName.lastIndexOf(".")) : "";
  return {
    name: clipboard ? `image-${number ?? "1"}${ext}` : rawName,
    directory: compactPath(directory, home),
    kind,
    source: clipboard ? "Clipboard" : "File",
  };
}

export function mimeTypeForImagePath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

export function rewriteClipboardPaths(
  text: string,
  startAt: number,
  store: ImagePathStore,
): string {
  let number = startAt;
  CLIPBOARD_PATH_RE.lastIndex = 0;
  return text.replace(CLIPBOARD_PATH_RE, (_full, filePath: string) => {
    const label = imageToken(number);
    store.set(String(number), filePath);
    number += 1;
    return label;
  });
}

export function rewriteInsertedText(
  inserted: string,
  editorText: string,
  store: ImagePathStore,
): string {
  CLIPBOARD_PATH_RE.lastIndex = 0;
  if (!CLIPBOARD_PATH_RE.test(inserted)) return inserted;
  return rewriteClipboardPaths(inserted, nextImageNumber(editorText), store);
}

export function displayImagePlaceholders(text: string): string {
  CLIPBOARD_PATH_RE.lastIndex = 0;
  if (!CLIPBOARD_PATH_RE.test(text)) return text;
  return rewriteClipboardPaths(text, nextImageNumber(text), new Map());
}

export function transformSubmittedText(
  text: string,
  store: ImagePathStore,
  load: (filePath: string) => ImageAttachment | undefined,
  existingImages: ImageAttachment[] = [],
): { text: string; images: ImageAttachment[] } {
  const images = [...existingImages];
  const seen = new Set<string>();

  for (const match of text.matchAll(/\[image[ -](\d+)\]/g)) {
    const filePath = store.get(match[1]);
    if (!filePath || seen.has(filePath)) continue;
    const image = load(filePath);
    if (!image) continue;
    images.push(image);
    seen.add(filePath);
  }

  let number = nextImageNumber(text);
  CLIPBOARD_PATH_RE.lastIndex = 0;
  const nextText = text.replace(CLIPBOARD_PATH_RE, (full, filePath: string) => {
    const existing = storedNumberForPath(store, filePath);
    if (existing && seen.has(filePath)) return imageToken(existing);
    const image = load(filePath);
    if (!image) return full;
    const label = imageToken(number);
    store.set(String(number), filePath);
    images.push(image);
    seen.add(filePath);
    number += 1;
    return label;
  });

  return { text: nextText, images };
}
