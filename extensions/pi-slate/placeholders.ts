import { compactPath } from "./layout.ts";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const EMBEDDED_IMAGE_PATH_RE =
  /"((?:\/|[A-Za-z]:\\)[^"]+\.(?:png|jpe?g|webp|gif))"|'((?:\/|[A-Za-z]:\\)[^']+\.(?:png|jpe?g|webp|gif))'|((?:file:\/\/)?(?:\/|[A-Za-z]:\\)[^\s"'`]+\.(?:png|jpe?g|webp|gif))/gi;

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
    if (cursor.col >= start && cursor.col <= end) return match[1];
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

function decodeImagePath(raw: string): string | undefined {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  if (value.startsWith("file://")) {
    const rest = value.slice("file://".length);
    try {
      value = decodeURIComponent(rest);
    } catch {
      value = rest;
    }
    if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  }
  value = value.replace(/\\ /g, " ");
  if (!IMAGE_EXT_RE.test(value)) return undefined;
  if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) return undefined;
  return value;
}

function assignImageToken(store: ImagePathStore, filePath: string, number: { value: number }): string {
  const label = imageToken(number.value);
  store.set(String(number.value), filePath);
  number.value += 1;
  return label;
}

function replaceEmbeddedImagePaths(
  text: string,
  replace: (full: string, filePath: string) => string,
): string {
  EMBEDDED_IMAGE_PATH_RE.lastIndex = 0;
  return text.replace(EMBEDDED_IMAGE_PATH_RE, (full, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
    const filePath = decodeImagePath(doubleQuoted ?? singleQuoted ?? bare ?? full);
    if (!filePath) return full;
    return replace(full, filePath);
  });
}

export function rewriteClipboardPaths(
  text: string,
  startAt: number,
  store: ImagePathStore,
): string {
  const number = { value: startAt };
  const dropped = decodeImagePath(text);
  if (dropped) return assignImageToken(store, dropped, number);
  return replaceEmbeddedImagePaths(text, (_full, filePath) => assignImageToken(store, filePath, number));
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

  const number = { value: nextImageNumber(text) };
  const attach = (full: string, filePath: string): string => {
    const existing = storedNumberForPath(store, filePath);
    if (existing && seen.has(filePath)) return imageToken(existing);
    const image = load(filePath);
    if (!image) return full;
    const label = assignImageToken(store, filePath, number);
    images.push(image);
    seen.add(filePath);
    return label;
  };

  const dropped = decodeImagePath(text);
  const nextText = dropped ? attach(text, dropped) : replaceEmbeddedImagePaths(text, attach);
  return { text: nextText, images };
}
