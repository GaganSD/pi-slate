import { homedir } from "node:os";
import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  imageTokenAtCursor,
  nextImageNumber,
  rewriteClipboardPaths,
  type ImageAttachment,
  type ImagePathStore,
} from "./placeholders.ts";
import { ImageWorkspaceView } from "./workspace.ts";
import type { Sidebar } from "./sidebar.ts";

export class ImagePeek {
  private shownId?: string;
  private rewriteTimer?: ReturnType<typeof setTimeout>;
  private readonly originalHandleMouse: CustomEditor["handleMouse"];
  private readonly originalHandleInput: CustomEditor["handleInput"];
  private readonly store: ImagePathStore;
  private readonly editor: CustomEditor;
  private readonly workspace: Sidebar;
  private readonly loadImage: (filePath: string) => ImageAttachment | undefined;

  constructor(
    store: ImagePathStore,
    editor: CustomEditor,
    workspace: Sidebar,
    loadImage: (filePath: string) => ImageAttachment | undefined,
  ) {
    this.store = store;
    this.editor = editor;
    this.workspace = workspace;
    this.loadImage = loadImage;
    this.originalHandleMouse = this.editor.handleMouse;
    this.originalHandleInput = this.editor.handleInput;
    this.editor.handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
      const result = this.originalHandleMouse.call(this.editor, event);
      this.update();
      return result;
    };
    this.editor.handleInput = (data: string): void => {
      this.originalHandleInput.call(this.editor, data);
      // ponytail: unbracketed Finder drops have no completion marker. A 50 ms
      // quiet period avoids replacing filename prefixes during a normal burst;
      // a deliberate pause after a complete path still counts as completion.
      clearTimeout(this.rewriteTimer);
      this.rewriteTimer = setTimeout(() => this.rewrite(), 50);
      this.update();
    };
  }

  rewrite(): void {
    const text = this.editor.getText();
    const rewritten = rewriteClipboardPaths(text, nextImageNumber(text), this.store);
    if (rewritten !== text) this.editor.setText(rewritten);
    this.update();
  }

  update(): void {
    const number = imageTokenAtCursor(this.editor.getText(), this.editor.getCursor());
    const filePath = number ? this.store.get(number) : undefined;
    if (!number || !filePath) {
      this.hide();
      return;
    }

    const nextId = `image:${number}:${filePath}`;
    if (this.shownId === nextId && this.workspace.currentViewId() === nextId) return;

    const image = this.loadImage(filePath);
    if (!image) {
      this.hide();
      return;
    }

    this.workspace.setView(
      new ImageWorkspaceView(
        number,
        filePath,
        image,
        this.workspace.requireTheme(),
        homedir(),
      ),
    );
    this.shownId = nextId;
  }

  hide(): void {
    if (!this.shownId) return;
    this.workspace.setView(undefined);
    this.shownId = undefined;
  }

  dispose(): void {
    clearTimeout(this.rewriteTimer);
    this.editor.handleMouse = this.originalHandleMouse;
    this.editor.handleInput = this.originalHandleInput;
    this.hide();
  }
}
