import { existsSync, readFileSync } from "node:fs";
import type { CustomEditor, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { ImagePeek } from "./image-peek.ts";
import {
  mimeTypeForImagePath,
  nextImageNumber,
  rewriteClipboardPaths,
  transformSubmittedText,
  type ImageAttachment,
  type ImagePathStore,
} from "./placeholders.ts";
import type { Sidebar } from "./sidebar.ts";

const ORIGINAL_INSERT = Symbol.for("pi-slate.image-placeholders.insertTextAtCursor");
const ORIGINAL_PASTE = Symbol.for("pi-slate.image-placeholders.handlePaste");
const ORIGINAL_CHAR = Symbol.for("pi-slate.image-placeholders.insertCharacter");

type PatchableEditor = {
  insertTextAtCursor(text: string): void;
  handlePaste(text: string): void;
  insertCharacter(char: string, skipUndoCoalescing?: boolean): void;
  [ORIGINAL_INSERT]?: (text: string) => void;
  [ORIGINAL_PASTE]?: (text: string) => void;
  [ORIGINAL_CHAR]?: (char: string, skipUndoCoalescing?: boolean) => void;
};

export type ImagePlaceholders = {
  attachEditor(editor: CustomEditor): void;
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

function installEditorPatch(store: ImagePathStore, onInserted: () => void): () => void {
  const proto = Editor.prototype as unknown as PatchableEditor;
  proto[ORIGINAL_INSERT] ??= proto.insertTextAtCursor;
  proto[ORIGINAL_PASTE] ??= proto.handlePaste;
  proto[ORIGINAL_CHAR] ??= proto.insertCharacter;
  const originalInsert = proto[ORIGINAL_INSERT];
  const originalPaste = proto[ORIGINAL_PASTE];
  const originalChar = proto[ORIGINAL_CHAR];
  const rewrite = (editor: Editor, text: string) => rewriteClipboardPaths(text, nextImageNumber(editor.getText()), store);
  function insertPatch(this: Editor, text: string) {
    const result = originalInsert.call(this, rewrite(this, text));
    onInserted();
    return result;
  }
  function pastePatch(this: Editor, text: string) {
    originalPaste.call(this, rewrite(this, text));
    onInserted();
  }
  function charPatch(this: Editor, char: string, skipUndoCoalescing?: boolean) {
    const next = rewrite(this, char);
    originalChar.call(this, next, skipUndoCoalescing);
    if (next !== char) onInserted();
  }
  proto.insertTextAtCursor = insertPatch;
  proto.handlePaste = pastePatch;
  proto.insertCharacter = charPatch;
  return () => {
    if (proto.insertTextAtCursor === insertPatch) {
      proto.insertTextAtCursor = originalInsert;
      if (proto[ORIGINAL_INSERT] === originalInsert) delete proto[ORIGINAL_INSERT];
    }
    if (proto.handlePaste === pastePatch) {
      proto.handlePaste = originalPaste;
      if (proto[ORIGINAL_PASTE] === originalPaste) delete proto[ORIGINAL_PASTE];
    }
    if (proto.insertCharacter === charPatch) {
      proto.insertCharacter = originalChar;
      if (proto[ORIGINAL_CHAR] === originalChar) delete proto[ORIGINAL_CHAR];
    }
  };
}

export function installImagePlaceholders(pi: ExtensionAPI, workspace: Sidebar): ImagePlaceholders {
  const store: ImagePathStore = new Map();
  let peek: ImagePeek | undefined;
  const uninstallEditorPatch = installEditorPatch(store, () => peek?.update());

  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (messageType !== "user") return markdown;
    return rewriteClipboardPaths(markdown, nextImageNumber(markdown), new Map());
  });

  pi.on("input", async (event) => {
    peek?.hide();
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
    attachEditor(editor) {
      peek?.dispose();
      peek = new ImagePeek(store, editor, workspace, loadImage);
    },
    dispose() {
      peek?.dispose();
      peek = undefined;
      uninstallEditorPatch();
    },
  };
}
