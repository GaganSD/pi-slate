import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { ImagePeek } from "./image-peek.ts";
import {
  displayImagePlaceholders,
  mimeTypeForImagePath,
  rewriteInsertedText,
  transformSubmittedText,
  type ImageAttachment,
  type ImagePathStore,
} from "./placeholders.ts";
import type { Sidebar } from "./sidebar.ts";

const ORIGINAL_INSERT = Symbol.for("pi-extensions.sidebar.insertTextAtCursor");
const ORIGINAL_PASTE = Symbol.for("pi-extensions.sidebar.handlePaste");
const ORIGINAL_INPUT = Symbol.for("pi-extensions.sidebar.handleInput");
const ORIGINAL_MOUSE = Symbol.for("pi-extensions.sidebar.handleMouse");

type EditorPaste = (text: string) => void;

type PatchableEditor = Editor & {
  handlePaste(text: string): void;
  [ORIGINAL_INSERT]?: Editor["insertTextAtCursor"];
  [ORIGINAL_PASTE]?: EditorPaste;
  [ORIGINAL_INPUT]?: Editor["handleInput"];
  [ORIGINAL_MOUSE]?: Editor["handleMouse"];
};

export type ImagePlaceholders = {
  hidePeek(): void;
  dispose(): void;
};

function loadImage(filePath: string): ImageAttachment | undefined {
  if (!existsSync(filePath)) return undefined;
  return {
    type: "image",
    data: readFileSync(filePath).toString("base64"),
    mimeType: mimeTypeForImagePath(filePath),
  };
}

function peekSafe(peek: ImagePeek, editor: Peekable): void {
  try {
    peek.update(editor);
  } catch {
    // Peek must not break typing or paste.
  }
}

type Peekable = { getText(): string; getCursor(): { line: number; col: number } };

function installEditorPatches(store: ImagePathStore, peek: ImagePeek): () => void {
  const proto = Editor.prototype as PatchableEditor;
  proto[ORIGINAL_INSERT] ??= proto.insertTextAtCursor;
  proto[ORIGINAL_PASTE] ??= proto.handlePaste;
  proto[ORIGINAL_INPUT] ??= proto.handleInput;
  proto[ORIGINAL_MOUSE] ??= proto.handleMouse;
  const originalInsert = proto[ORIGINAL_INSERT];
  const originalPaste = proto[ORIGINAL_PASTE];
  const originalInput = proto[ORIGINAL_INPUT];
  const originalMouse = proto[ORIGINAL_MOUSE];

  function insertPatch(this: Editor, text: string) {
    const result = originalInsert.call(this, rewriteInsertedText(text, this.getText(), store));
    peekSafe(peek, this);
    return result;
  }
  function pastePatch(this: Editor, text: string) {
    originalPaste.call(this, rewriteInsertedText(text, this.getText(), store));
    peekSafe(peek, this);
  }
  function inputPatch(this: Editor, data: string) {
    originalInput.call(this, data);
    peekSafe(peek, this);
  }
  function mousePatch(this: Editor, event: Parameters<Editor["handleMouse"]>[0]) {
    const result = originalMouse.call(this, event);
    peekSafe(peek, this);
    return result;
  }

  proto.insertTextAtCursor = insertPatch;
  proto.handlePaste = pastePatch;
  proto.handleInput = inputPatch;
  proto.handleMouse = mousePatch;

  return () => {
    if (proto.insertTextAtCursor === insertPatch) {
      proto.insertTextAtCursor = originalInsert;
      if (proto[ORIGINAL_INSERT] === originalInsert) delete proto[ORIGINAL_INSERT];
    }
    if (proto.handlePaste === pastePatch) {
      proto.handlePaste = originalPaste;
      if (proto[ORIGINAL_PASTE] === originalPaste) delete proto[ORIGINAL_PASTE];
    }
    if (proto.handleInput === inputPatch) {
      proto.handleInput = originalInput;
      if (proto[ORIGINAL_INPUT] === originalInput) delete proto[ORIGINAL_INPUT];
    }
    if (proto.handleMouse === mousePatch) {
      proto.handleMouse = originalMouse;
      if (proto[ORIGINAL_MOUSE] === originalMouse) delete proto[ORIGINAL_MOUSE];
    }
  };
}

export function installImagePlaceholders(pi: ExtensionAPI, workspace: Sidebar): ImagePlaceholders {
  const store: ImagePathStore = new Map();
  const peek = new ImagePeek(store, workspace, loadImage);
  const uninstallEditorPatches = installEditorPatches(store, peek);

  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (messageType !== "user") return markdown;
    return displayImagePlaceholders(markdown);
  });

  pi.on("input", async (event) => {
    peek.hide();
    const result = transformSubmittedText(event.text, store, loadImage, event.images ?? []);
    if (result.text === event.text && result.images.length === (event.images?.length ?? 0)) {
      return { action: "continue" as const };
    }
    return {
      action: "transform" as const,
      text: result.text,
      images: result.images,
    };
  });

  return {
    hidePeek() {
      peek.hide();
    },
    dispose() {
      peek.hide();
      uninstallEditorPatches();
    },
  };
}
