import { homedir } from "node:os";
import { imageTokenAtCursor, type ImageAttachment, type ImagePathStore } from "./placeholders.ts";
import { ImageWorkspaceView } from "./workspace.ts";
import type { Sidebar } from "./sidebar.ts";

export type PeekEditor = {
  getText(): string;
  getCursor(): { line: number; col: number };
};

export class ImagePeek {
  private shownId?: string;
  private readonly store: ImagePathStore;
  private readonly workspace: Sidebar;
  private readonly loadImage: (filePath: string) => ImageAttachment | undefined;

  constructor(
    store: ImagePathStore,
    workspace: Sidebar,
    loadImage: (filePath: string) => ImageAttachment | undefined,
  ) {
    this.store = store;
    this.workspace = workspace;
    this.loadImage = loadImage;
  }

  update(editor: PeekEditor): void {
    let theme;
    try {
      theme = this.workspace.requireTheme();
    } catch {
      this.hide();
      return;
    }

    const number = imageTokenAtCursor(editor.getText(), editor.getCursor());
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
        theme,
        homedir(),
        (path) => this.workspace.copyPath(path),
      ),
    );
    this.shownId = nextId;
  }

  hide(): void {
    if (!this.shownId) return;
    this.workspace.setView(undefined);
    this.shownId = undefined;
  }
}
