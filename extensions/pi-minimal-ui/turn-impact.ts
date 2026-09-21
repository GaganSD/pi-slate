export type TurnImpactSnapshot = {
  revision: number;
  filesRead: number;
  filesModified: number;
  shellCommands: number;
  testsPassed: number;
  testsFailed: number;
  testsUnknown: number;
};

type PendingCall = { kind: "read" | "modify" | "test"; path?: string };

/** Transient, UI-local facts observed during the current Pi turn. */
export class TurnImpactTracker {
  private reads = new Set<string>();
  private modified = new Set<string>();
  private pending = new Map<string, PendingCall>();
  private shellCommands = 0;
  private testsPassed = 0;
  private testsFailed = 0;
  private testsUnknown = 0;
  private revision = 0;

  reset(): TurnImpactSnapshot {
    this.reads.clear();
    this.modified.clear();
    this.pending.clear();
    this.shellCommands = 0;
    this.testsPassed = 0;
    this.testsFailed = 0;
    this.testsUnknown = 0;
    this.revision += 1;
    return this.snapshot();
  }

  toolCall(call: { toolCallId: string; toolName: string; input?: { path?: unknown; command?: unknown } }): TurnImpactSnapshot {
    const path = typeof call.input?.path === "string" && call.input.path.trim() ? call.input.path : undefined;
    if (call.toolName === "read" && path) this.pending.set(call.toolCallId, { kind: "read", path });
    if ((call.toolName === "edit" || call.toolName === "write") && path) {
      this.pending.set(call.toolCallId, { kind: "modify", path });
    }
    if (call.toolName === "bash" || call.toolName === "powershell") {
      this.shellCommands += 1;
      const command = typeof call.input?.command === "string" ? call.input.command : "";
      if (isTestCommand(command)) {
        this.pending.set(call.toolCallId, { kind: "test" });
        this.testsUnknown += 1;
      }
    }
    this.revision += 1;
    return this.snapshot();
  }

  toolEnd(end: { toolCallId: string; isError: boolean }): TurnImpactSnapshot {
    const pending = this.pending.get(end.toolCallId);
    if (!pending) return this.snapshot();
    this.pending.delete(end.toolCallId);
    if (pending.kind === "read" && !end.isError && pending.path) this.reads.add(pending.path);
    if (pending.kind === "modify" && !end.isError && pending.path) this.modified.add(pending.path);
    if (pending.kind === "test") {
      this.testsUnknown = Math.max(0, this.testsUnknown - 1);
      if (end.isError) this.testsFailed += 1;
      else this.testsPassed += 1;
    }
    this.revision += 1;
    return this.snapshot();
  }

  snapshot(): TurnImpactSnapshot {
    return { revision: this.revision, filesRead: this.reads.size, filesModified: this.modified.size,
      shellCommands: this.shellCommands, testsPassed: this.testsPassed, testsFailed: this.testsFailed,
      testsUnknown: this.testsUnknown };
  }
}

export function isTestCommand(command: string): boolean {
  // Deliberately recognize runner invocations only, rather than arbitrary text containing “test”.
  return /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|[;&|]\s*|\s)(?:vitest|jest|pytest|go\s+test|cargo\s+test|node\s+--test)\b/.test(command);
}

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

export function formatTurnImpact(snapshot: TurnImpactSnapshot): string[] {
  const lines = [
    `${plural(snapshot.filesRead, "file")} read · ${plural(snapshot.filesModified, "file")} modified`,
    plural(snapshot.shellCommands, "shell command"),
  ];
  const tests = [
    snapshot.testsPassed ? `${plural(snapshot.testsPassed, "test")} passed` : "",
    snapshot.testsFailed ? `${plural(snapshot.testsFailed, "test")} failed` : "",
    snapshot.testsUnknown ? `${plural(snapshot.testsUnknown, "test")} running/unknown` : "",
  ].filter(Boolean).join(" · ");
  if (tests) lines.push(tests);
  return lines;
}
