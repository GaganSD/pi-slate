export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export const DEFAULT_WIDTH_PERCENT = 20;
export const DEFAULT_MIN_WIDTH = 28;
export const DEFAULT_MIN_TERMINAL_WIDTH = 60;
export const SIDEBAR_EDITOR_RESERVE = 5;

export type WidthLayout = {
  widthPercent: number;
  minWidth: number;
  minTerminalWidth: number;
};

export const DEFAULT_WIDTH_LAYOUT: WidthLayout = {
  widthPercent: DEFAULT_WIDTH_PERCENT,
  minWidth: DEFAULT_MIN_WIDTH,
  minTerminalWidth: DEFAULT_MIN_TERMINAL_WIDTH,
};

export const SIDEBAR_MIN_TERMINAL_WIDTH = DEFAULT_MIN_TERMINAL_WIDTH;
export const SIDEBAR_MIN_WIDTH = DEFAULT_MIN_WIDTH;

export function compactPath(cwd: string | undefined, home?: string): string {
  if (!cwd) return "";
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}k`;
  return String(Math.round(value));
}

function trimFixed(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, "");
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatTokenCount(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return "— tokens";
  return `${formatInteger(tokens)} tokens`;
}

export function formatTokenRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "— tokens/sec";
  return `${formatInteger(Math.max(0, rate))} tokens/sec`;
}

export function formatTokenCountWithRate(
  tokens: number | null | undefined,
  rate: number | null | undefined,
): string {
  return `${formatTokenCount(tokens)} · ${formatTokenRate(rate)}`;
}

export function formatPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "—%";
  return `${Math.round(percent)}%`;
}

export function formatContextTokens(
  tokens: number | null | undefined,
  percent: number | null | undefined,
  rate: number | null | undefined,
): string {
  return `${formatTokenCount(tokens)} (${formatPercent(percent)}) · ${formatTokenRate(rate)}`;
}

export function formatContextUsed(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "— used";
  return `${Math.round(percent)}% used`;
}

export function formatMcpConnected(count: number): string {
  const servers = Math.max(0, Math.round(count));
  return `${servers} MCPs connected`;
}

export function formatSkillsLoaded(count: number): string {
  const skills = Math.max(0, Math.round(count));
  return `${skills} skills loaded`;
}

export function formatContextResources(skills: number, mcpCount: number | null): string {
  return `${formatSkillsLoaded(skills)} · ${formatMcpConnected(mcpCount ?? 0)}`;
}

export function countSkillCommands(commands: readonly { source?: string; sourceInfo?: { path?: string }; name?: string }[]): number {
  const seen = new Set<string>();
  for (const command of commands) {
    if (command.source !== "skill") continue;
    seen.add(command.sourceInfo?.path || command.name || "skill");
  }
  return seen.size;
}

export function parseMcpConnectedCount(data: unknown): number | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const count = (data as { connectedCount?: unknown }).connectedCount;
  if (typeof count !== "number" || !Number.isFinite(count)) return null;
  return Math.max(0, Math.round(count));
}

export function workspaceColumnWidth(
  totalWidth: number,
  layout: WidthLayout = DEFAULT_WIDTH_LAYOUT,
): number {
  if (totalWidth < layout.minTerminalWidth) return 0;
  return Math.max(layout.minWidth, Math.floor(totalWidth * (layout.widthPercent / 100)));
}

export function mainColumnWidth(
  totalWidth: number,
  layout: WidthLayout = DEFAULT_WIDTH_LAYOUT,
): number {
  return Math.max(1, totalWidth - workspaceColumnWidth(totalWidth, layout));
}
