import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  allocateImageId,
  getCapabilities,
  getCellDimensions,
  getImageDimensions,
  imageFallback,
  renderImage,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { classifyDiffLine } from "./git-diff.ts";
import { formatImageLocation, type ImageAttachment } from "./placeholders.ts";
import { fitImageCells, placeWorkspaceImage, workspacePaneSlots } from "./workspace-layout.ts";

export type WorkspaceView = {
  id: string;
  render(width: number, height: number): string[];
  invalidate(): void;
  handleClick?(x: number, y: number): boolean;
  handleWheel?(delta: number): boolean;
};

export class DiffWorkspaceView implements WorkspaceView {
  readonly id: string;
  private readonly state: "loading" | "diff" | "empty" | "error";
  private readonly text: string;
  private readonly theme: Theme;
  private cached?: { key: string; lines: string[] };

  constructor(
    id: string,
    state: "loading" | "diff" | "empty" | "error",
    text: string,
    theme: Theme,
  ) {
    this.id = `diff:${id}:${state}`;
    this.state = state;
    this.text = text;
    this.theme = theme;
  }

  invalidate(): void { this.cached = undefined; }

  render(width: number, height: number): string[] {
    const key = `${width}x${height}`;
    if (this.cached?.key === key) return this.cached.lines;
    const source = this.state === "loading" ? ["Loading change…"]
      : this.state === "diff" ? this.text.split(/\r?\n/)
      : [this.text || (this.state === "empty" ? "No text diff is available." : "Preview unavailable.")];
    const lines = source.slice(0, Math.max(0, height)).map((line) => {
      const kind = classifyDiffLine(line);
      const tone = kind === "added" ? "toolDiffAdded"
        : kind === "removed" ? "toolDiffRemoved"
        : kind === "hunk" ? "accent"
        : kind === "header" ? "dim"
        : "toolDiffContext";
      return truncateToWidth(this.theme.fg(tone, line), width, "…");
    });
    while (lines.length < Math.max(0, height)) lines.push("");
    this.cached = { key, lines };
    return lines;
  }
}

export class ImageWorkspaceView implements WorkspaceView {
  readonly id: string;
  private readonly filePath: string;
  private readonly attachment: ImageAttachment;
  private readonly theme: Theme;
  private readonly onCopyPath?: (filePath: string) => void;
  private imageId?: number;
  private cached?: { key: string; lines: string[] };
  private filenameRow?: number;
  private readonly location: ReturnType<typeof formatImageLocation>;

  constructor(
    number: string,
    filePath: string,
    attachment: ImageAttachment,
    theme: Theme,
    home?: string,
    onCopyPath?: (filePath: string) => void,
  ) {
    this.id = `image:${number}:${filePath}`;
    this.filePath = filePath;
    this.attachment = attachment;
    this.theme = theme;
    this.onCopyPath = onCopyPath;
    this.location = formatImageLocation(filePath, home, number);
  }

  invalidate(): void {
    this.cached = undefined;
    this.filenameRow = undefined;
  }

  handleClick(_x: number, y: number): boolean {
    if (this.filenameRow === undefined || y !== this.filenameRow || !this.onCopyPath) return false;
    this.onCopyPath(this.filePath);
    return true;
  }

  render(width: number, height: number): string[] {
    const key = `${width}x${height}`;
    if (this.cached?.key === key) return this.cached.lines;
    const { imageHeight, captionHeight } = workspacePaneSlots(height);
    const caption = this.captionLines(width).slice(0, captionHeight);
    if (imageHeight < 1) {
      const placed = placeWorkspaceImage(height, 0, caption);
      this.filenameRow = caption.length > 0 ? placed.captionStart : undefined;
      this.cached = { key, lines: placed.lines };
      return placed.lines;
    }

    const imageLines = this.renderImageLines(width, imageHeight);
    const placed = placeWorkspaceImage(height, imageLines.length, caption);
    for (let i = 0; i < placed.imageRows; i++) {
      placed.lines[placed.imageStart + i] = imageLines[i] ?? "";
    }
    this.filenameRow = caption.length > 0 ? placed.captionStart : undefined;
    this.cached = { key, lines: placed.lines };
    return placed.lines;
  }

  private fallbackLines(
    width: number,
    dimensions: { widthPx: number; heightPx: number },
  ): string[] {
    return [
      truncateToWidth(
        this.theme.fg("muted", imageFallback(this.attachment.mimeType, dimensions, this.location.name)),
        width,
      ),
    ];
  }

  private captionLines(width: number): string[] {
    return [truncateToWidth(this.theme.fg("muted", `Filename: ${this.location.name}`), width)];
  }

  private renderImageLines(width: number, imageHeight: number): string[] {
    const dimensions = getImageDimensions(this.attachment.data, this.attachment.mimeType) ?? {
      widthPx: 800,
      heightPx: 600,
    };
    const cell = getCellDimensions();
    const fit = fitImageCells(
      dimensions.widthPx,
      dimensions.heightPx,
      width,
      imageHeight,
      cell.widthPx,
      cell.heightPx,
    );
    if (fit.columns < 1 || fit.rows < 1) return [];

    const caps = getCapabilities();
    if (!caps.images) {
      return this.fallbackLines(width, dimensions);
    }

    this.imageId ??= allocateImageId();
    const result = renderImage(this.attachment.data, dimensions, {
      maxWidthCells: fit.columns,
      maxHeightCells: fit.rows,
      imageId: this.imageId,
      moveCursor: false,
    });
    if (!result) {
      return this.fallbackLines(width, dimensions);
    }

    if (caps.images === "kitty") {
      const lines = [result.sequence];
      for (let i = 1; i < result.rows; i++) lines.push("");
      return lines;
    }

    const lines: string[] = [];
    for (let i = 0; i < result.rows - 1; i++) lines.push("");
    const moveUp = result.rows > 1 ? `\x1b[${result.rows - 1}A` : "";
    lines.push(moveUp + result.sequence);
    return lines;
  }
}
