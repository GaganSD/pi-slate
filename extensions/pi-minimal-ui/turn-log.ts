import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { compactDisplayText } from "./layout.ts";
import {
  eventsForFilter,
  filterLabel,
  isShellTool,
  type TurnEvent,
  type TurnFilter,
} from "./turn-impact.ts";
import type { WorkspaceView } from "./workspace.ts";

export class TurnLogView implements WorkspaceView {
  readonly id: string;
  readonly title: string;
  private events: readonly TurnEvent[];
  private readonly filter: TurnFilter;
  private readonly theme: Theme;
  private cwd?: string;
  private home?: string;
  private readonly onChange?: () => void;
  private expanded = new Set<string>();
  private offset = 0;
  private cached?: { key: string; lines: string[] };
  private rows: Array<{ event?: TurnEvent; text: string }> = [];

  constructor(filter: TurnFilter, events: readonly TurnEvent[], theme: Theme, onChange?: () => void, cwd?: string, home?: string) {
    this.id = `turn:${filter}`;
    this.title = filterLabel(filter);
    this.filter = filter;
    this.events = events;
    this.theme = theme;
    this.onChange = onChange;
    this.cwd = cwd;
    this.home = home;
  }

  setEvents(events: readonly TurnEvent[]): void {
    this.events = events;
    this.cached = undefined;
  }

  setPlace(cwd?: string, home?: string): void {
    if (this.cwd === cwd && this.home === home) return;
    this.cwd = cwd;
    this.home = home;
    this.cached = undefined;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  handleClick(_x: number, y: number): boolean {
    const row = this.rows[this.offset + y];
    if (!row?.event) return false;
    if (this.expanded.has(row.event.id)) this.expanded.delete(row.event.id);
    else this.expanded.add(row.event.id);
    this.cached = undefined;
    this.onChange?.();
    return true;
  }

  handleWheel(delta: number): boolean {
    if (delta === 0) return false;
    const maxOffset = Math.max(0, this.rows.length - 1);
    const next = Math.max(0, Math.min(maxOffset, this.offset + delta));
    if (next === this.offset) return false;
    this.offset = next;
    this.cached = undefined;
    this.onChange?.();
    return true;
  }

  render(width: number, height: number): string[] {
    this.rows = this.buildRows(Math.max(1, width));
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.rows.length - 1)));
    const key = `${width}x${height}:${this.offset}:${[...this.expanded].join(",")}:${this.events.length}`;
    if (this.cached?.key === key) return this.cached.lines;
    const lines = this.rows.slice(this.offset, this.offset + height).map((row) => row.text);
    while (lines.length < Math.max(0, height)) lines.push("");
    this.cached = { key, lines };
    return lines;
  }

  private buildRows(width: number): Array<{ event?: TurnEvent; text: string }> {
    const items = eventsForFilter(this.events, this.filter);
    const rows: Array<{ event?: TurnEvent; text: string }> = [];
    if (items.length === 0) {
      rows.push({ text: truncateToWidth(this.theme.fg("dim", "none"), width, "…") });
      return rows;
    }
    for (const event of items) {
      const mark = this.expanded.has(event.id) ? "▾" : "▸";
      const tone = eventTone(event);
      const title = compactDisplayText(event.title, this.cwd, this.home);
      rows.push({
        event,
        text: truncateToWidth(this.theme.fg(tone, `${mark} ${title}`), width, "…"),
      });
      if (!this.expanded.has(event.id)) continue;
      for (const line of wrapLines(compactDisplayText(event.detail, this.cwd, this.home), width)) {
        rows.push({ text: truncateToWidth(this.theme.fg("dim", line || " "), width, "…") });
      }
    }
    return rows;
  }
}

export function eventTone(event: TurnEvent): "error" | "warning" | "accent" | "success" | "muted" {
  if (event.isError) return "error";
  if (event.pending) return "warning";
  if (event.toolName === "read") return "accent";
  if (event.toolName === "edit" || event.toolName === "write") return "warning";
  if (event.toolName === "subagent") return "success";
  if (isShellTool(event.toolName)) return "muted";
  return "muted";
}

export function wrapLines(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length === 0) {
      lines.push("");
      continue;
    }
    for (let i = 0; i < raw.length; i += max) lines.push(raw.slice(i, i + max));
  }
  return lines.length > 0 ? lines : [""];
}
