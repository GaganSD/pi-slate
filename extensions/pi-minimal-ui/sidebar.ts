import { resolve } from "node:path";
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
import { planPanel, type PlanItem } from "./plan.ts";
import { installSidebarSplit } from "./sidebar-split.ts";
import { displayedTokenRate } from "./token-rate.ts";
import type { WorkspaceView } from "./workspace.ts";
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
};

export class Sidebar implements Component {
  private tui?: TUI;
  private theme?: Theme;
  private handle?: OverlayHandle;
  private splitDispose?: () => void;
  private view?: WorkspaceView;
  private contextData: SidebarContextData = { tokens: null, percent: null, tokensPerSec: 0 };
  private lastSlots = { planHeight: 0, peekHeight: 0, dividerHeight: 0, filesDivider: 0, filesHeight: 0 };
  private mcpConnected: number | null = null;
  private skillsLoaded = 0;
  private todos: PlanItem[] = [];
  private todoRev = 0;
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

  setView(view: WorkspaceView | undefined): void {
    if (this.view?.id === view?.id) return;
    this.view = view;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

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

  setTodos(todos: PlanItem[]): void {
    if (sameTodos(this.todos, todos)) return;
    this.todos = todos;
    this.todoRev += 1;
    this.contentCached = undefined;
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
    return this.view?.id;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { filesHeight, filesDivider, planHeight, dividerHeight, peekHeight } = this.lastSlots;
    const planStart = filesHeight + filesDivider;
    const peekStart = planStart + planHeight + dividerHeight;
    if (event.type === "wheel" && event.y >= 0 && event.y < filesHeight) {
      if (!this.scrollFiles(-(event.wheelDelta ?? 0))) return undefined;
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left" && event.y >= 0 && event.y < filesHeight) {
      const file = fileAtPanelRow(this.files, filesHeight, this.filesOffset, event.y);
      if (!file) return undefined;
      this.copyPath(this.cwd ? resolve(this.cwd, file.path) : file.path);
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left" || !this.view?.handleClick) return undefined;
    const titleOffset = peekHeight > 1 ? 1 : 0;
    const y = event.y - peekStart - titleOffset;
    if (y < 0 || y >= peekHeight - titleOffset) return undefined;
    if (!this.view.handleClick(event.x, y)) return undefined;
    return { handled: true };
  }

  invalidate(): void {
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.view?.invalidate();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const height = Math.max(1, this.tui?.terminal.rows ?? 1);
    const { contentHeight, dockHeight } = sidebarRowSlots(
      height,
      sidebarDockLines(),
    );
    const contentKey = `${width}x${contentHeight}:${this.todoRev}:${this.filesRev}:${this.filesOffset}:${this.view?.id ?? ""}`;
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
    this.view = undefined;
    this.files = [];
    this.filesRev = 0;
    this.filesOffset = 0;
    this.cwd = "";
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.lastSlots = { planHeight: 0, peekHeight: 0, dividerHeight: 0, filesDivider: 0, filesHeight: 0 };
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
      this.lastSlots = { planHeight: 0, peekHeight: 0, dividerHeight: 0, filesDivider: 0, filesHeight: 0 };
      return [];
    }
    const { filesHeight, filesDivider, planHeight, dividerHeight, peekHeight } = this.lastSlots = splitSidebarContent(
      height,
      filesWidgetDesiredHeight(this.files.length),
    );
    const lines: string[] = [...this.filesLines(width, filesHeight, theme)];
    this.pushRule(lines, filesDivider, width, theme);
    lines.push(...this.padBlock(this.planLines(width, planHeight, theme), planHeight, width, theme));
    this.pushRule(lines, dividerHeight, width, theme);
    lines.push(...this.peekLines(width, peekHeight, theme));
    return lines;
  }

  private planLines(width: number, maxHeight: number, theme: Theme | undefined): string[] {
    if (maxHeight < 1) return [];
    if (this.todos.length === 0) {
      const lines = [this.heading("Plan", width, theme)];
      if (maxHeight > 1) lines.push(this.body("none", width, theme, "dim"));
      return lines;
    }
    if (!theme) return [];
    return planPanel(this.todos, maxHeight).map((line) => {
      if (line.type === "heading") return this.heading(`Plan ${line.done}/${line.total}`, width, theme);
      if (line.type === "overflow") return this.body(`+${line.count} more`, width, theme, "dim");
      const mark = line.item.status === "done"
        ? theme.fg("success", "✓")
        : line.item.status === "in_progress"
          ? theme.fg("accent", "◐")
          : theme.fg("dim", "○");
      const text = line.item.status === "done" ? theme.fg("dim", line.item.text) : theme.fg("muted", line.item.text);
      return this.decorateLine(`${" ".repeat(line.depth)}${mark} ${text}`, width, theme);
    });
  }

  private peekLines(width: number, maxHeight: number, theme: Theme | undefined): string[] {
    if (maxHeight < 1) return [];
    const lines = [this.heading("Preview", width, theme)];
    const bodyHeight = maxHeight - 1;
    if (bodyHeight < 1) return lines;
    if (!this.view) {
      lines.push(this.body("none", width, theme, "dim"));
      return this.padBlock(lines, maxHeight, width, theme);
    }
    const peek = this.view.render(Math.max(0, width - 2), bodyHeight);
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

function sameTodos(left: PlanItem[], right: PlanItem[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return other !== undefined
      && item.id === other.id
      && item.status === other.status
      && item.parentId === other.parentId
      && item.text === other.text;
  });
}
