import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  eventsForFilter,
  filterLabel,
  type TurnEvent,
  type TurnFilter,
} from "./turn-impact.ts";
import type { WorkspaceView } from "./workspace.ts";

export class TurnLogView implements WorkspaceView {
  readonly id: string;
  private events: readonly TurnEvent[];
  private readonly filter: TurnFilter;
  private readonly theme: Theme;
  private readonly onChange?: () => void;
  private expanded = new Set<string>();
  private offset = 0;
  private cached?: { key: string; lines: string[] };
  private rows: Array<{ event?: TurnEvent; text: string }> = [];

  constructor(filter: TurnFilter, events: readonly TurnEvent[], theme: Theme, onChange?: () => void) {
    this.id = `turn:${filter}`;
    this.filter = filter;
    this.events = events;
    this.theme = theme;
    this.onChange = onChange;
  }

  setEvents(events: readonly TurnEvent[]): void {
    this.events = events;
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
    const rows: Array<{ event?: TurnEvent; text: string }> = [{
      text: truncateToWidth(this.theme.fg("muted", `${filterLabel(this.filter)} · ${items.length}`), width, "…"),
    }];
    if (items.length === 0) {
      rows.push({ text: truncateToWidth(this.theme.fg("dim", "none"), width, "…") });
      return rows;
    }
    for (const event of items) {
      const mark = this.expanded.has(event.id) ? "▾" : "▸";
      const tone = event.isError ? "error" : event.pending ? "warning" : "muted";
      rows.push({
        event,
        text: truncateToWidth(this.theme.fg(tone, `${mark} ${event.title}`), width, "…"),
      });
      if (!this.expanded.has(event.id)) continue;
      for (const line of wrapLines(event.detail, width)) {
        rows.push({ text: truncateToWidth(this.theme.fg("dim", line || " "), width, "…") });
      }
    }
    return rows;
  }
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
