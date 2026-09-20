import { resolve } from "node:path";
import { type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  isViewportTUI,
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
  type WidthLayout,
} from "./layout.ts";
import {
  clampFilesOffset,
  fileAtPanelRow,
  fileMark,
  filesPanel,
  formatFileLabel,
  sameFiles,
  type FileChange,
  type FileMarkStyle,
} from "./files-modified.ts";
import { planPanel, type PlanItem, type PlanStatus } from "./plan.ts";
import { installSidebarSplit } from "./sidebar-split.ts";
import { hasForeignSplitOwner } from "./split-host.ts";
import { displayedTokenRate } from "./token-rate.ts";
import { paint, paintBold, resolveThemeColor, ruleChars } from "./tokens.ts";
import {
  filesWidgetDesiredHeight,
  sidebarDockLines,
  sidebarRowSlots,
  splitSidebarContent,
} from "./workspace-layout.ts";

export type SidebarContextData = {
  tokens: number | null;
  percent: number | null;
  tokensPerSec: number;
};

export type SidebarActions = {
  copyPath(filePath: string): void;
};

export type SidebarColors = {
  heading: ThemeColor;
  body: ThemeColor;
  dim: ThemeColor;
  rule: ThemeColor;
  fileNew: ThemeColor;
  fileModified: ThemeColor;
  fileDeleted: ThemeColor;
  fileRenamed: ThemeColor;
  fileUnmerged: ThemeColor;
  planPending: ThemeColor;
  planActive: ThemeColor;
  planDone: ThemeColor;
};

export type SidebarMarks = {
  fileNew: string;
  fileModified: string;
  fileDeleted: string;
  fileRenamed: string;
  fileUnmerged: string;
  planPending: string;
  planActive: string;
  planDone: string;
};

export type SidebarSettings = {
  enabled: boolean;
  ascii: boolean;
  filesMaxLines: number;
  widthPercent: number;
  minWidth: number;
  minTerminalWidth: number;
  colors: SidebarColors;
  marks: SidebarMarks;
};

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = {
  enabled: true,
  ascii: false,
  filesMaxLines: 5,
  widthPercent: 20,
  minWidth: 28,
  minTerminalWidth: 60,
  colors: {
    heading: "text",
    body: "muted",
    dim: "dim",
    rule: "borderMuted",
    fileNew: "success",
    fileModified: "warning",
    fileDeleted: "error",
    fileRenamed: "accent",
    fileUnmerged: "error",
    planPending: "dim",
    planActive: "accent",
    planDone: "success",
  },
  marks: {
    fileNew: "N",
    fileModified: "M",
    fileDeleted: "D",
    fileRenamed: "R",
    fileUnmerged: "U",
    planPending: "○",
    planActive: "◐",
    planDone: "✓",
  },
};

const ASCII_PLAN_MARKS = {
  planPending: "o",
  planActive: "*",
  planDone: "x",
} as const;

export type SidebarAttachResult = "split" | "overlay" | "foreign" | "idle";

export class Sidebar implements Component {
  private tui?: TUI;
  private theme?: Theme;
  private handle?: OverlayHandle;
  private splitDispose?: () => void;
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
  private settings: SidebarSettings = { ...DEFAULT_SIDEBAR_SETTINGS, colors: { ...DEFAULT_SIDEBAR_SETTINGS.colors }, marks: { ...DEFAULT_SIDEBAR_SETTINGS.marks } };
  splitActive = false;

  requireTheme(): Theme {
    if (!this.theme) throw new Error("sidebar is not attached");
    return this.theme;
  }

  widthLayout(): WidthLayout {
    return {
      widthPercent: this.settings.widthPercent,
      minWidth: this.settings.minWidth,
      minTerminalWidth: this.settings.minTerminalWidth,
    };
  }

  attach(tui: TUI, theme: Theme): SidebarAttachResult {
    this.tui = tui;
    this.theme = theme;
    if (!this.settings.enabled) return "idle";
    if (this.splitDispose || this.handle) return this.splitActive ? "split" : "overlay";
    if (isViewportTUI(tui) && hasForeignSplitOwner(tui)) return "foreign";

    this.splitDispose = installSidebarSplit(tui, this, () => this.widthLayout());
    this.splitActive = Boolean(this.splitDispose);
    this.contentCached = undefined;
    this.dockCached = undefined;
    if (this.splitActive) return "split";

    this.handle = tui.showOverlay(this, {
      nonCapturing: true,
      anchor: "top-right",
      width: `${this.settings.widthPercent}%`,
      minWidth: this.settings.minWidth,
      maxHeight: "100%",
      margin: { top: 0, right: 0, bottom: SIDEBAR_EDITOR_RESERVE, left: 0 },
      visible: (termWidth) => termWidth >= this.settings.minTerminalWidth,
    });
    return "overlay";
  }

  unmount(): void {
    this.splitDispose?.();
    this.splitDispose = undefined;
    this.splitActive = false;
    this.handle?.hide();
    this.handle = undefined;
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.lastSlots = { planHeight: 0, peekHeight: 0, dividerHeight: 0, filesDivider: 0, filesHeight: 0 };
  }

  setSettings(settings: SidebarSettings): void {
    this.settings = {
      ...settings,
      colors: { ...settings.colors },
      marks: { ...settings.marks },
    };
    this.contentCached = undefined;
    this.dockCached = undefined;
    if (!this.tui || !this.theme) {
      this.tui?.requestRender();
      return;
    }
    const shouldShow = this.settings.enabled;
    const shown = Boolean(this.splitDispose || this.handle);
    if (!shouldShow && shown) {
      this.unmount();
    } else if (shouldShow && !shown) {
      this.attach(this.tui, this.theme);
    } else if (shouldShow && this.handle && !this.splitActive) {
      this.handle.hide();
      this.handle = undefined;
      this.attach(this.tui, this.theme);
    }
    this.tui.requestRender();
  }

  setActions(actions: SidebarActions): void {
    this.actions = actions;
  }

  copyPath(filePath: string): void {
    this.actions?.copyPath(filePath);
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
      Math.max(0, filesWidgetDesiredHeight(files.length, this.settings.filesMaxLines) - 1),
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

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { filesHeight } = this.lastSlots;
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
    return undefined;
  }

  invalidate(): void {
    this.contentCached = undefined;
    this.dockCached = undefined;
  }

  render(width: number): string[] {
    const theme = this.theme;
    const height = Math.max(1, this.tui?.terminal.rows ?? 1);
    const { contentHeight, dockHeight } = sidebarRowSlots(
      height,
      sidebarDockLines(),
    );
    const contentKey = `${width}x${contentHeight}:${this.todoRev}:${this.filesRev}:${this.filesOffset}:${this.settings.ascii}:${this.settings.filesMaxLines}`;
    const dockKey = `${width}x${dockHeight}:${this.contextData.tokens}:${this.contextData.percent}:${displayedTokenRate(this.contextData.tokensPerSec)}:${this.skillsLoaded}:${this.mcpConnected}:${this.settings.ascii}`;
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
    this.unmount();
    this.files = [];
    this.filesRev = 0;
    this.filesOffset = 0;
    this.cwd = "";
    this.tui = undefined;
    this.theme = undefined;
  }

  private fileStyle(): FileMarkStyle {
    const { marks, colors } = this.settings;
    return {
      marks: {
        fileNew: marks.fileNew,
        fileModified: marks.fileModified,
        fileDeleted: marks.fileDeleted,
        fileRenamed: marks.fileRenamed,
        fileUnmerged: marks.fileUnmerged,
      },
      tones: {
        fileNew: colorTone(colors.fileNew, "success"),
        fileModified: colorTone(colors.fileModified, "warning"),
        fileDeleted: colorTone(colors.fileDeleted, "error"),
        fileRenamed: colorTone(colors.fileRenamed, "accent"),
        fileUnmerged: colorTone(colors.fileUnmerged, "error"),
      },
    };
  }

  private planMark(status: PlanStatus): { mark: string; color: ThemeColor } {
    const ascii = this.settings.ascii;
    const marks = this.settings.marks;
    const colors = this.settings.colors;
    if (status === "done") {
      return { mark: ascii ? ASCII_PLAN_MARKS.planDone : marks.planDone, color: colors.planDone };
    }
    if (status === "in_progress") {
      return { mark: ascii ? ASCII_PLAN_MARKS.planActive : marks.planActive, color: colors.planActive };
    }
    return { mark: ascii ? ASCII_PLAN_MARKS.planPending : marks.planPending, color: colors.planPending };
  }

  private dockLines(width: number, height: number, theme: Theme | undefined): string[] {
    if (height < 1) return [];
    const tokens = formatContextTokens(
      this.contextData.tokens,
      this.contextData.percent,
      this.contextData.tokensPerSec,
    );
    const resources = formatContextResources(this.skillsLoaded, this.mcpConnected);
    if (height === 1) return [theme ? this.body(tokens, width, theme, "body") : tokens];

    const lines: string[] = [];
    if (height >= 4) lines.push(this.rule(width, theme));
    lines.push(this.heading("Context", width, theme));
    if (lines.length < height) lines.push(theme ? this.body(tokens, width, theme, "body") : this.decorateLine(tokens, width, theme));
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
      filesWidgetDesiredHeight(this.files.length, this.settings.filesMaxLines),
      this.settings.filesMaxLines,
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
      const mark = this.planMark(line.item.status);
      const text = line.item.status === "done"
        ? paint(theme, this.settings.colors.dim, line.item.text)
        : paint(theme, this.settings.colors.body, line.item.text);
      return this.decorateLine(`${" ".repeat(line.depth)}${paint(theme, mark.color, mark.mark)} ${text}`, width, theme);
    });
  }

  private peekLines(width: number, maxHeight: number, theme: Theme | undefined): string[] {
    if (maxHeight < 1) return [];
    const lines = [this.heading("Preview", width, theme)];
    if (maxHeight > 1) lines.push(this.body("none", width, theme, "dim"));
    return this.padBlock(lines, maxHeight, width, theme);
  }

  private filesLines(width: number, maxHeight: number, theme: Theme | undefined): string[] {
    if (maxHeight < 1) return [];
    const panel = filesPanel(this.files, maxHeight, this.filesOffset);
    this.filesOffset = panel.offset;
    const style = this.fileStyle();
    return panel.lines.map((line) => {
      if (line.type === "heading") {
        const label = line.count > 0 ? `Files Changed · ${line.count}` : "Files Changed";
        return this.heading(label, width, theme);
      }
      if (line.type === "empty") return this.body("none", width, theme, "dim");
      const mark = fileMark(line.item, style);
      const label = formatFileLabel(line.item);
      if (!theme) return this.decorateLine(`${mark.mark} ${label}`, width, theme);
      return this.decorateLine(`${paint(theme, mark.tone, mark.mark)} ${paint(theme, this.settings.colors.body, label)}`, width, theme);
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
    lines.push(this.rule(width, theme));
  }

  private padBlock(block: string[], height: number, width: number, theme: Theme | undefined): string[] {
    const lines = block.slice(0, height);
    while (lines.length < height) lines.push(this.decorateLine("", width, theme));
    return lines;
  }

  private heading(label: string, width: number, theme: Theme | undefined): string {
    if (!theme) return this.decorateLine(label, width, theme);
    return this.decorateLine(paintBold(theme, this.settings.colors.heading, label), width, theme);
  }

  private body(text: string, width: number, theme: Theme | undefined, tone: "body" | "dim"): string {
    if (!theme) return this.decorateLine(text, width, theme);
    const color = tone === "dim" ? this.settings.colors.dim : this.settings.colors.body;
    return this.decorateLine(paint(theme, color, text), width, theme);
  }

  private rule(width: number, theme: Theme | undefined): string {
    const chars = ruleChars(this.settings.ascii);
    const bar = chars.horizontal.repeat(Math.max(0, width - 1));
    if (!theme) return `${chars.vertical}${bar}`;
    return `${paint(theme, this.settings.colors.rule, chars.vertical)}${paint(theme, this.settings.colors.rule, bar)}`;
  }

  private decorateLine(line: string, width: number, theme: Theme | undefined): string {
    const chars = ruleChars(this.settings.ascii);
    if (!theme) return truncateToWidth(line, width);
    if (line.length === 0) return paint(theme, this.settings.colors.rule, chars.vertical);
    return `${paint(theme, this.settings.colors.rule, chars.vertical)}${truncateToWidth(` ${line}`, Math.max(0, width - 1))}`;
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

function colorTone(
  color: ThemeColor,
  fallback: FileMarkStyle["tones"]["fileNew"],
): FileMarkStyle["tones"]["fileNew"] {
  const resolved = resolveThemeColor(color, fallback);
  if (resolved === "success" || resolved === "warning" || resolved === "error" || resolved === "accent" || resolved === "muted") {
    return resolved;
  }
  return fallback;
}
