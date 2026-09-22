import { homedir } from "node:os";
import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  imageTokenAtCursor,
  nextImageNumber,
  noticeForInsert,
  rewriteClipboardPaths,
  type ImageAttachment,
  type ImagePathStore,
} from "./placeholders.ts";
import { ImageWorkspaceView } from "./workspace.ts";
import type { Sidebar } from "./sidebar.ts";

export class ImagePeek {
  private shownId?: string;
  private inserts = 0;
  private readonly originalHandleMouse: CustomEditor["handleMouse"];
  private readonly originalHandleInput: CustomEditor["handleInput"];

  constructor(
    private readonly store: ImagePathStore,
    private readonly editor: CustomEditor,
    private readonly workspace: Sidebar,
    private readonly loadImage: (filePath: string) => ImageAttachment | undefined,
    private readonly onNotice: (text: string) => void = () => {},
  ) {
    this.originalHandleMouse = this.editor.handleMouse;
    this.originalHandleInput = this.editor.handleInput;
    this.editor.handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
      const result = this.originalHandleMouse.call(this.editor, event);
      this.update();
      return result;
    };
    this.editor.handleInput = (data: string): void => {
      this.originalHandleInput.call(this.editor, data);
      // Input arrives in chunks, so count the keystrokes inside each chunk
      // rather than the chunk itself; pasted blocks are not typing.
      const keys = data.startsWith("\x1b[200~")
        ? 0
        : data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
      const before = this.inserts;
      this.inserts += keys;
      // Flush a pending rewrite notice every few inserts so normalized paths
      // stay discoverable without interrupting typing bursts.
      const notice = noticeForInsert(this.inserts, before);
      if (notice !== undefined) this.onNotice(notice);
      this.update();
    };
  }

  update(): void {
    const text = this.editor.getText();
    const rewritten = rewriteClipboardPaths(text, nextImageNumber(text), this.store);
    if (rewritten !== text) this.editor.setText(rewritten);
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
    this.editor.handleMouse = this.originalHandleMouse;
    this.editor.handleInput = this.originalHandleInput;
    this.hide();
  }
}
