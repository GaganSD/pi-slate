// The source SVG is a 4×4 square grid. Terminal cells are approximately twice
// as tall as they are wide, so every source square occupies two columns.
// Keep the empty fourth column on the first two rows. The header centers this
// fixed-width canvas as a whole; trimming those spaces distorts the mark.
export const PI_LOGO = ["██████  ", "██  ██  ", "████  ██", "██    ██"];
export const PI_LOGO_ASCII = ["######  ", "##  ##  ", "####  ##", "##    ##"];

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}k`;
  return String(Math.round(value));
}

function trimFixed(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, "");
}

export function compactPath(cwd: string | undefined, home?: string): string {
  if (!cwd) return "";
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

export function modelLabel(model: { id?: string; name?: string } | undefined): string {
  if (!model) return "no model";
  return model.id || model.name || "unknown model";
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

export function formatSpend(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return "$0.00 spent";
  return `$${Math.max(0, cost).toFixed(2)} spent`;
}

export function formatContextSummary(
  tokens: number | null | undefined,
  percent: number | null | undefined,
  spend: number | null | undefined,
): string {
  return [formatTokenCount(tokens), formatContextUsed(percent), formatSpend(spend)].join(" · ");
}

export function formatCompactContext(
  tokens: number | null | undefined,
  percent: number | null | undefined,
  spend: number | null | undefined,
  rate: number | null | undefined = 0,
): string {
  return [
    formatTokenCount(tokens).replace(" tokens", ""),
    formatTokenRate(rate).replace(" tokens/sec", "/s"),
    formatContextUsed(percent).replace(" used", ""),
    formatSpend(spend).replace(" spent", ""),
  ].join(" · ");
}

export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

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

export function contextLabel(usage: { percent: number | null; contextWindow: number } | undefined): string {
  if (!usage) return "context —";
  const percent = usage.percent === null ? "—" : `${usage.percent.toFixed(1)}%`;
  return `${percent}/${formatCount(usage.contextWindow)}`;
}

export function footerVisibility(width: number): {
  showBranch: boolean;
  showModel: boolean;
  showThinking: boolean;
} {
  return {
    showBranch: width >= 42,
    showModel: width >= 66,
    showThinking: width >= 80,
  };
}

export function centerOffset(viewportWidth: number, contentWidth: number): number {
  return Math.max(0, Math.floor((viewportWidth - contentWidth) / 2));
}

export const WORKSPACE_MIN_TERMINAL_WIDTH = 60;
export const WORKSPACE_MIN_WIDTH = 28;
export const WORKSPACE_EDITOR_RESERVE = 5;
export const SIDEBAR_MIN_TERMINAL_WIDTH = WORKSPACE_MIN_TERMINAL_WIDTH;
export const SIDEBAR_MIN_WIDTH = WORKSPACE_MIN_WIDTH;
export const SIDEBAR_EDITOR_RESERVE = WORKSPACE_EDITOR_RESERVE;

export function workspaceColumnWidth(totalWidth: number): number {
  if (totalWidth < WORKSPACE_MIN_TERMINAL_WIDTH) return 0;
  return Math.max(WORKSPACE_MIN_WIDTH, Math.floor(totalWidth * 0.2));
}

export function mainColumnWidth(totalWidth: number): number {
  return Math.max(1, totalWidth - workspaceColumnWidth(totalWidth));
}
