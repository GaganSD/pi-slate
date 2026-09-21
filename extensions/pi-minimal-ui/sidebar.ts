import { type Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  type Component,
  type OverlayHandle,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  formatContextResources,
  formatContextTokens,
  SIDEBAR_EDITOR_RESERVE,
  SIDEBAR_MIN_TERMINAL_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./layout.ts";
import {
  clampFilesOffset,
  fileAtPanelRow,
  fileMark,
  filesPanel,
  formatFileLabel,
  sameFiles,
  type FileChange,
} from "./files-modified.ts";
import { installSidebarSplit } from "./sidebar-split.ts";
import { displayedTokenRate } from "./token-rate.ts";
import type { WorkspaceView } from "./workspace.ts";
import { formatTurnImpact, type TurnImpactSnapshot } from "./turn-impact.ts";
import {
  filesWidgetDesiredHeight,
  sidebarDockLines,
  sidebarRowSlots,
  splitSidebarContent,
} from "./workspace-layout.ts";

const KITTY_PREFIX = "\x1b_G";

export type SidebarContextData = {
  tokens: number | null;
  percent: number | null;
  tokensPerSec: number;
};

export type SidebarActions = {
  copyPath(filePath: string): void;
  selectFile(file: FileChange): void;
};

export class Sidebar implements Component {
  private tui?: TUI;
  private theme?: Theme;
  private handle?: OverlayHandle;
  private splitDispose?: () => void;
  private selectedView?: WorkspaceView;
  private transientView?: WorkspaceView;
  private turnImpact: TurnImpactSnapshot = { revision: 0, filesRead: 0, filesModified: 0, filesDeleted: 0, shellCommands: 0, testsPassed: 0, testsFailed: 0, testsUnknown: 0 };
  private contextData: SidebarContextData = { tokens: null, percent: null, tokensPerSec: 0 };
  private lastSlots = { summaryHeight: 0, peekHeight: 0, dividerHeight: 0, filesHeight: 0, filesStart: 0 };
  private mcpConnected: number | null = null;
  private skillsLoaded = 0;
  private files: FileChange[] = [];
  private filesRev = 0;
  private filesOffset = 0;
  private cwd = "";
  private contentCached?: { key: string; lines: string[] };
  private dockCached?: { key: string; lines: string[] };
  private actions?: SidebarActions;
  splitActive = false;

  requireTheme(): Theme {
    if (!this.theme) throw new Error("sidebar is not attached");
    return this.theme;
  }

  attach(tui: TUI, theme: Theme): void {
    this.tui = tui;
    this.theme = theme;
    if (this.splitDispose || this.handle) return;
    this.splitDispose = installSidebarSplit(tui, this);
    this.splitActive = Boolean(this.splitDispose);
    this.contentCached = undefined;
    this.dockCached = undefined;
    if (this.splitActive) return;
    this.handle = tui.showOverlay(this, {
      nonCapturing: true,
      anchor: "top-right",
      width: "20%",
      minWidth: SIDEBAR_MIN_WIDTH,
      maxHeight: "100%",
      margin: { top: 0, right: 0, bottom: SIDEBAR_EDITOR_RESERVE, left: 0 },
      visible: (termWidth) => termWidth >= SIDEBAR_MIN_TERMINAL_WIDTH,
    });
  }

  setActions(actions: SidebarActions): void {
    this.actions = actions;
  }

  copyPath(filePath: string): void {
    this.actions?.copyPath(filePath);
  }

  /** Temporary image preview; it overrides but never discards a selected file preview. */
  setView(view: WorkspaceView | undefined): void {
    if (this.transientView?.id === view?.id) return;
    this.transientView = view;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setSelectedPreview(view: WorkspaceView | undefined): void {
    if (this.selectedView?.id === view?.id) return;
    this.selectedView = view;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setTurnImpact(impact: TurnImpactSnapshot): void {
    if (this.turnImpact.revision === impact.revision) return;
    this.turnImpact = impact;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  private effectiveView(): WorkspaceView | undefined { return this.transientView ?? this.selectedView; }

  setContext(data: SidebarContextData): void {
    if (
      this.contextData.tokens === data.tokens &&
      this.contextData.percent === data.percent &&
      displayedTokenRate(this.contextData.tokensPerSec) === displayedTokenRate(data.tokensPerSec)
    ) {
      return;
    }
    this.contextData = data;
    this.dockCached = undefined;
    this.tui?.requestRender();
  }

  setCwd(cwd: string): void {
    if (this.cwd === cwd) return;
    this.cwd = cwd;
  }

  setFiles(files: FileChange[]): void {
    if (sameFiles(this.files, files)) return;
    this.files = files;
    this.filesRev += 1;
    this.filesOffset = clampFilesOffset(
      this.filesOffset,
      files.length,
      Math.max(0, filesWidgetDesiredHeight(files.length) - 1),
    );
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setMcpConnected(count: number | null): void {
    if (this.mcpConnected === count) return;
    this.mcpConnected = count;
    this.dockCached = undefined;
    this.tui?.requestRender();
  }

  setSkillsLoaded(count: number): void {
    const next = Math.max(0, Math.round(count));
    if (this.skillsLoaded === next) return;
    this.skillsLoaded = next;
    this.dockCached = undefined;
    this.tui?.requestRender();
  }

  currentViewId(): string | undefined {
    return this.effectiveView()?.id;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { summaryHeight, filesHeight, dividerHeight, peekHeight, filesStart } = this.lastSlots;
    const peekStart = summaryHeight + dividerHeight;
    if (event.type === "wheel" && event.y >= filesStart && event.y < filesStart + filesHeight) {
      if (!this.scrollFiles(-(event.wheelDelta ?? 0))) return undefined;
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left" && event.y >= filesStart && event.y < filesStart + filesHeight) {
      const file = fileAtPanelRow(this.files, filesHeight, this.filesOffset, event.y - filesStart);
      if (!file) return undefined;
      this.actions?.selectFile(file);
      return { handled: true };
    }
    const view = this.effectiveView();
    if (event.type !== "click" || event.button !== "left" || !view?.handleClick) return undefined;
    const titleOffset = peekHeight > 1 ? 1 : 0;
    const y = event.y - peekStart - titleOffset;
    if (y < 0 || y >= peekHeight - titleOffset || !view.handleClick(event.x, y)) return undefined;
    return { handled: true };
  }

  invalidate(): void {
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.selectedView?.invalidate();
    this.transientView?.invalidate();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const height = Math.max(1, this.tui?.terminal.rows ?? 1);
    const { contentHeight, dockHeight } = sidebarRowSlots(
      height,
      sidebarDockLines(),
    );
    const contentKey = `${width}x${contentHeight}:${this.filesRev}:${this.filesOffset}:${this.turnImpact.revision}:${this.effectiveView()?.id ?? ""}`;
    const dockKey = `${width}x${dockHeight}:${this.contextData.tokens}:${this.contextData.percent}:${displayedTokenRate(this.contextData.tokensPerSec)}:${this.skillsLoaded}:${this.mcpConnected}`;
    const content = this.contentCached?.key === contentKey
      ? this.contentCached.lines
      : this.contentLines(width, contentHeight, theme);
    const dock = this.dockCached?.key === dockKey
      ? this.dockCached.lines
      : this.dockLines(width, dockHeight, theme);
    this.contentCached = { key: contentKey, lines: content };
    this.dockCached = { key: dockKey, lines: dock };
    return [...content, ...dock].slice(0, height);
  }

  dispose(): void {
    this.splitDispose?.();
    this.splitDispose = undefined;
    this.splitActive = false;
    this.handle?.hide();
    this.handle = undefined;
    this.selectedView = undefined;
    this.transientView = undefined;
    this.files = [];
    this.filesRev = 0;
    this.filesOffset = 0;
    this.cwd = "";
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.lastSlots = { summaryHeight: 0, peekHeight: 0, dividerHeight: 0, filesHeight: 0, filesStart: 0 };
    this.tui = undefined;
    this.theme = undefined;
  }

  private dockLines(width: number, height: number, theme: Theme | undefined): string[] {
    if (height < 1) return [];
    const tokens = formatContextTokens(
      this.contextData.tokens,
      this.contextData.percent,
      this.contextData.tokensPerSec,
    );
    const resources = formatContextResources(this.skillsLoaded, this.mcpConnected);
    if (height === 1) return [theme ? this.body(tokens, width, theme, "muted") : tokens];

    const lines: string[] = [];
    if (height >= 4 && theme) lines.push(this.rule(width, theme));
    else if (height >= 4) lines.push("─".repeat(Math.max(0, width)));
    lines.push(this.heading("Context", width, theme));
    if (lines.length < height) lines.push(theme ? this.body(tokens, width, theme, "muted") : this.decorateLine(tokens, width, theme));
    if (lines.length < height) lines.push(theme ? this.body(resources, width, theme, "dim") : this.decorateLine(resources, width, theme));
    while (lines.length < height) lines.push(this.decorateLine("", width, theme));
    return lines.slice(0, height);
  }

  private contentLines(width: number, height: number, theme: Theme | undefined): string[] {
    if (height < 1) {
      this.lastSlots = { summaryHeight: 0, peekHeight: 0, dividerHeight: 0, filesHeight: 0, filesStart: 0 };
      return [];
    }
    const slots = splitSidebarContent(height, filesWidgetDesiredHeight(this.files.length));
    this.lastSlots = { ...slots, filesStart: 0 };
    const lines: string[] = [...this.summaryLines(width, slots.summaryHeight, slots.filesHeight, theme)];
    this.pushRule(lines, slots.dividerHeight, width, theme);
    lines.push(...this.peekLines(width, slots.peekHeight, theme));
    return lines;
  }

  private summaryLines(width: number, height: number, filesHeight: number, theme: Theme | undefined): string[] {
    if (height < 1) return [];
    const empty = this.decorateLine("", width, theme);
    const files = this.filesLines(width, filesHeight, theme);
    const impact = formatTurnImpact(this.turnImpact).map((line) => this.body(line, width, theme, "muted"));
    const extra = Math.max(0, height - (1 + files.length + 1 + impact.length));
    const lines = [this.heading("Summary", width, theme)];
    if (extra > 0) lines.push(empty);
    this.lastSlots = { ...this.lastSlots, filesStart: lines.length };
    lines.push(...files);
    if (extra > 1) lines.push(empty);
    if (lines.length < height) lines.push(this.heading("Last Turn", width, theme));
    if (extra > 2) lines.push(empty);
    for (const line of impact) {
      if (lines.length >= height) break;
      lines.push(line);
    }
    return this.padBlock(lines, height, width, theme);
  }

  private peekLines(width: number, maxHeight: number, theme: Theme | undefined): string[] {
    if (maxHeight < 1) return [];
    const lines = [this.heading("Preview", width, theme)];
    const bodyHeight = maxHeight - 1;
    if (bodyHeight < 1) return lines;
    const view = this.effectiveView();
    if (!view) {
      lines.push(this.body("none", width, theme, "dim"));
      return this.padBlock(lines, maxHeight, width, theme);
    }
    const peek = view.render(Math.max(0, width - 2), bodyHeight);
    for (let row = 0; row < bodyHeight; row++) {
      lines.push(this.decorateLine(peek[row] ?? "", width, theme));
    }
    return lines;
  }

  private filesLines(width: number, maxHeight: number, theme: Theme | undefined): string[] {
    if (maxHeight < 1) return [];
    const panel = filesPanel(this.files, maxHeight, this.filesOffset);
    this.filesOffset = panel.offset;
    return panel.lines.map((line) => {
      if (line.type === "heading") {
        const label = line.count > 0 ? `Files Changed · ${line.count}` : "Files Changed";
        return this.heading(label, width, theme);
      }
      if (line.type === "empty") return this.body("none", width, theme, "dim");
      const mark = fileMark(line.item);
      const label = formatFileLabel(line.item);
      if (!theme) return this.decorateLine(`${mark.mark} ${label}`, width, theme);
      return this.decorateLine(`${theme.fg(mark.tone, mark.mark)} ${theme.fg("muted", label)}`, width, theme);
    });
  }

  private scrollFiles(delta: number): boolean {
    if (delta === 0 || this.files.length === 0) return false;
    const bodyHeight = Math.max(0, this.lastSlots.filesHeight - (this.lastSlots.filesHeight > 1 ? 1 : 0));
    const next = clampFilesOffset(this.filesOffset + delta, this.files.length, bodyHeight);
    if (next === this.filesOffset) return false;
    this.filesOffset = next;
    this.contentCached = undefined;
    this.tui?.requestRender();
    return true;
  }

  private pushRule(lines: string[], height: number, width: number, theme: Theme | undefined): void {
    if (height < 1) return;
    lines.push(theme ? this.rule(width, theme) : "─".repeat(Math.max(0, width)));
  }

  private padBlock(block: string[], height: number, width: number, theme: Theme | undefined): string[] {
    const lines = block.slice(0, height);
    while (lines.length < height) lines.push(this.decorateLine("", width, theme));
    return lines;
  }

  private heading(label: string, width: number, theme: Theme | undefined): string {
    if (!theme) return this.decorateLine(label, width, theme);
    return this.decorateLine(theme.bold(theme.fg("text", label)), width, theme);
  }

  private body(text: string, width: number, theme: Theme | undefined, color: "muted" | "dim"): string {
    if (!theme) return this.decorateLine(text, width, theme);
    return this.decorateLine(theme.fg(color, text), width, theme);
  }

  private rule(width: number, theme: Theme): string {
    return `${theme.fg("borderMuted", "│")}${theme.fg("borderMuted", "─".repeat(Math.max(0, width - 1)))}`;
  }

  private decorateLine(line: string, width: number, theme: Theme | undefined): string {
    if (line.includes(KITTY_PREFIX) || line.includes("\x1b]1337;File=")) {
      return theme ? `${theme.fg("borderMuted", "│")} ${line}` : `│ ${line}`;
    }
    if (!theme) return truncateToWidth(line, width);
    if (line.length === 0) return theme.fg("borderMuted", "│");
    return `${theme.fg("borderMuted", "│")}${truncateToWidth(` ${line}`, Math.max(0, width - 1))}`;
  }
}
