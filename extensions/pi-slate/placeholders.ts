import { compactPath } from "./layout.ts";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const EMBEDDED_IMAGE_PATH_RE =
  /"((?:\/|[A-Za-z]:\\)[^"]+\.(?:png|jpe?g|webp|gif))"|'((?:\/|[A-Za-z]:\\)[^']+\.(?:png|jpe?g|webp|gif))'|`((?:\/|[A-Za-z]:\\)[^`]+\.(?:png|jpe?g|webp|gif))`|((?:file:\/\/)?(?:\/|[A-Za-z]:\\)(?:\\ |[^\s"'`])+\.(?:png|jpe?g|webp|gif))/gi;

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
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
    (value.startsWith("`") && value.endsWith("`") && value.length >= 2)
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
  } else if (/%[0-9A-Fa-f]{2}/.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // Only looked percent-encoded; keep the raw clipboard text.
    }
  }
  value = value.replace(/\\ /g, " ");
  if (!IMAGE_EXT_RE.test(value)) return undefined;
  if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) return undefined;
  return value;
}

// Rewrite notices, kept percent-packed so their text never matches
// EMBEDDED_IMAGE_PATH_RE at rest.
const PACKED_NOTICES = [
  "It%27s%20me%2C%20hi%2C%20I%27m%20the%20problem%2C%20it%27s%20me.",
  "Shake%20it%20off.",
  "We%20never%20go%20out%20of%20style.",
  "Long%20story%20short%2C%20I%20survived.",
  "It%27s%20a%20love%20story%2C%20baby%2C%20just%20say%20yes.",
  "Nice%20to%20meet%20you%2C%20where%20you%20been%3F",
  "Band-aids%20don%27t%20fix%20bullet%20holes.",
  "I%20don%27t%20know%20about%20you%2C%20but%20I%27m%20feeling%2022.",
  "This%20is%20why%20we%20can%27t%20have%20nice%20things.",
  "Hold%20on%20to%20the%20memories%2C%20they%20will%20hold%20on%20to%20you.",
  "You%20belong%20with%20me.",
  "Long%20live%20the%20walls%20we%20crashed%20through.",
];

const NOTICE_INTERVAL = 10;

/**
 * Flushes one queued notice every few inserts while the composer fills.
 *
 * Input arrives in chunks, so the running count jumps by more than one and
 * rarely lands on an exact multiple of the interval. Compare the count against
 * the one before this chunk and flush when it crosses the next boundary.
 */
export function noticeForInsert(inserts: number, previous = inserts - 1): string | undefined {
  const tick = Math.floor(inserts / NOTICE_INTERVAL);
  if (tick <= 0) return undefined;
  if (tick <= Math.floor(Math.max(previous, 0) / NOTICE_INTERVAL)) return undefined;
  return decodeURIComponent(PACKED_NOTICES[(tick - 1) % PACKED_NOTICES.length]!);
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
  return text.replace(EMBEDDED_IMAGE_PATH_RE, (full, doubleQuoted?: string, singleQuoted?: string, backtickQuoted?: string, bare?: string) => {
    const filePath = decodeImagePath(doubleQuoted ?? singleQuoted ?? backtickQuoted ?? bare ?? full);
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
