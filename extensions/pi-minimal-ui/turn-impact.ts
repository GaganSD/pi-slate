export type TurnFilter = "tool" | "shell" | "subagent";

export type TurnEvent = {
  id: string;
  toolName: string;
  title: string;
  detail: string;
  isError: boolean;
  pending: boolean;
};

export type TurnImpactSnapshot = {
  revision: number;
  filesRead: number;
  toolsCalled: number;
  shellCommands: number;
  subagentsSpawned: number;
  events: TurnEvent[];
};

type PendingCall = {
  event: TurnEvent;
  input?: Record<string, unknown>;
};

const FILTERS: TurnFilter[] = ["tool", "shell", "subagent"];

/** Transient, UI-local facts observed during the current user prompt. */
export class TurnImpactTracker {
  private events: TurnEvent[] = [];
  private pending = new Map<string, PendingCall>();
  private reads = new Set<string>();
  private toolsCalled = 0;
  private shellCommands = 0;
  private subagentsSpawned = 0;
  private revision = 0;

  reset(): TurnImpactSnapshot {
    this.events = [];
    this.pending.clear();
    this.reads.clear();
    this.toolsCalled = 0;
    this.shellCommands = 0;
    this.subagentsSpawned = 0;
    this.revision += 1;
    return this.snapshot();
  }

  toolCall(call: { toolCallId: string; toolName: string; input?: Record<string, unknown> }): TurnImpactSnapshot {
    const input = call.input && typeof call.input === "object" ? call.input : undefined;
    this.toolsCalled += 1;
    if (isShellTool(call.toolName)) this.shellCommands += 1;
    if (call.toolName === "subagent") this.subagentsSpawned += 1;
    const event: TurnEvent = {
      id: call.toolCallId,
      toolName: call.toolName,
      title: eventTitle(call.toolName, input),
      detail: formatDetail(call.toolName, input, undefined, false, true),
      isError: false,
      pending: true,
    };
    this.events.push(event);
    this.pending.set(call.toolCallId, { event, input });
    this.revision += 1;
    return this.snapshot();
  }

  toolEnd(end: { toolCallId: string; isError: boolean; result?: unknown; toolName?: string }): TurnImpactSnapshot {
    let pending = this.pending.get(end.toolCallId);
    if (!pending) {
      const toolName = end.toolName || "tool";
      this.toolsCalled += 1;
      if (isShellTool(toolName)) this.shellCommands += 1;
      if (toolName === "subagent") this.subagentsSpawned += 1;
      const event: TurnEvent = {
        id: end.toolCallId,
        toolName,
        title: eventTitle(toolName, undefined),
        detail: "",
        isError: end.isError,
        pending: false,
      };
      this.events.push(event);
      pending = { event };
    }
    this.pending.delete(end.toolCallId);
    pending.event.pending = false;
    pending.event.isError = end.isError;
    pending.event.detail = formatDetail(pending.event.toolName, pending.input, end.result, end.isError, false);
    const path = typeof pending.input?.path === "string" ? pending.input.path : undefined;
    if (!end.isError && pending.event.toolName === "read" && path) this.reads.add(path);
    this.revision += 1;
    return this.snapshot();
  }

  snapshot(): TurnImpactSnapshot {
    return {
      revision: this.revision,
      filesRead: this.reads.size,
      toolsCalled: this.toolsCalled,
      shellCommands: this.shellCommands,
      subagentsSpawned: this.subagentsSpawned,
      events: this.events,
    };
  }
}

export function turnFilters(): TurnFilter[] {
  return FILTERS;
}

export function isShellTool(toolName: string): boolean {
  return toolName === "bash" || toolName === "powershell";
}

export function eventsForFilter(events: readonly TurnEvent[], filter: TurnFilter): TurnEvent[] {
  if (filter === "tool") return [...events];
  if (filter === "shell") return events.filter((event) => isShellTool(event.toolName));
  return events.filter((event) => event.toolName === "subagent");
}

export function eventTitle(toolName: string, input: Record<string, unknown> | undefined): string {
  const path = typeof input?.path === "string" ? input.path : undefined;
  const command = typeof input?.command === "string" ? input.command : undefined;
  const pattern = typeof input?.pattern === "string" ? input.pattern : undefined;
  const agent = typeof input?.agent === "string" ? input.agent : undefined;
  const task = typeof input?.task === "string" ? input.task : undefined;
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    return path ? `${toolName} ${path}` : toolName;
  }
  if (isShellTool(toolName)) return command ? `${toolName} ${command}` : toolName;
  if (toolName === "subagent") {
    return [agent, task].filter(Boolean).join(" · ") || "subagent";
  }
  if (path) return `${toolName} ${path}`;
  if (pattern) return `${toolName} ${pattern}`;
  return toolName;
}

export function formatResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text);
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    }).join("");
  }
  if (typeof result === "object" && result && "content" in result) {
    return formatResult((result as { content: unknown }).content);
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function formatDetail(
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: unknown,
  isError: boolean,
  pending: boolean,
): string {
  const state = pending ? "pending" : isError ? "error" : "ok";
  const args = input ? JSON.stringify(input, null, 2) : "{}";
  const body = formatResult(result);
  return [`${toolName} · ${state}`, args, body].filter((part) => part.length > 0).join("\n");
}

export function filterLabel(filter: TurnFilter): string {
  if (filter === "tool") return "tools called";
  if (filter === "shell") return "shell commands";
  return "subagents spawned";
}

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

export function formatTurnImpact(snapshot: TurnImpactSnapshot): string[] {
  return [
    plural(snapshot.toolsCalled, "tool") + " called",
    plural(snapshot.shellCommands, "shell command"),
    plural(snapshot.subagentsSpawned, "subagent") + " spawned",
  ];
}
