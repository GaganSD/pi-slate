export type TurnImpactSnapshot = {
  revision: number;
  filesRead: number;
  filesModified: number;
  filesDeleted: number;
  shellCommands: number;
  testsPassed: number;
  testsFailed: number;
  testsUnknown: number;
};

type PendingCall = {
  read?: string;
  modify?: string;
  deleted?: string[];
  test?: boolean;
};

/** Transient, UI-local facts observed during the current user prompt. */
export class TurnImpactTracker {
  private reads = new Set<string>();
  private modified = new Set<string>();
  private deleted = new Set<string>();
  private pending = new Map<string, PendingCall>();
  private shellCommands = 0;
  private testsPassed = 0;
  private testsFailed = 0;
  private testsUnknown = 0;
  private revision = 0;

  reset(): TurnImpactSnapshot {
    this.reads.clear();
    this.modified.clear();
    this.deleted.clear();
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
    const pending: PendingCall = this.pending.get(call.toolCallId) ?? {};
    if (call.toolName === "read" && path) pending.read = path;
    if ((call.toolName === "edit" || call.toolName === "write") && path) pending.modify = path;
    if (call.toolName === "bash" || call.toolName === "powershell") {
      this.shellCommands += 1;
      const command = typeof call.input?.command === "string" ? call.input.command : "";
      const deleted = deletedPathsFromCommand(command);
      if (deleted.length) pending.deleted = deleted;
      if (isTestCommand(command)) {
        pending.test = true;
        this.testsUnknown += 1;
      }
    }
    if (pending.read || pending.modify || pending.deleted || pending.test) {
      this.pending.set(call.toolCallId, pending);
    }
    this.revision += 1;
    return this.snapshot();
  }

  toolEnd(end: { toolCallId: string; isError: boolean }): TurnImpactSnapshot {
    const pending = this.pending.get(end.toolCallId);
    if (!pending) return this.snapshot();
    this.pending.delete(end.toolCallId);
    if (!end.isError && pending.read) this.reads.add(pending.read);
    if (!end.isError && pending.modify) this.modified.add(pending.modify);
    if (!end.isError && pending.deleted) {
      for (const path of pending.deleted) this.deleted.add(path);
    }
    if (pending.test) {
      this.testsUnknown = Math.max(0, this.testsUnknown - 1);
      if (end.isError) this.testsFailed += 1;
      else this.testsPassed += 1;
    }
    this.revision += 1;
    return this.snapshot();
  }

  snapshot(): TurnImpactSnapshot {
    return {
      revision: this.revision,
      filesRead: this.reads.size,
      filesModified: this.modified.size,
      filesDeleted: this.deleted.size,
      shellCommands: this.shellCommands,
      testsPassed: this.testsPassed,
      testsFailed: this.testsFailed,
      testsUnknown: this.testsUnknown,
    };
  }
}

export function isTestCommand(command: string): boolean {
  // Deliberately recognize runner invocations only, rather than arbitrary text containing “test”.
  return /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|[;&|]\s*|\s)(?:vitest|jest|pytest|go\s+test|cargo\s+test|node\s+--test)\b/.test(command);
}

export function deletedPathsFromCommand(command: string): string[] {
  const paths: string[] = [];
  for (const chunk of command.split(/(?:&&|\|\||;)/)) {
    const tokens = chunk.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    if (tokens[i] === "sudo") i += 1;
    if (tokens[i] === "git" && tokens[i + 1] === "rm") i += 2;
    else if (tokens[i] === "rm" || tokens[i] === "rmdir" || tokens[i] === "unlink") i += 1;
    else continue;
    const found = tokens.slice(i).filter((token) => !token.startsWith("-"));
    paths.push(...(found.length > 0 ? found : ["(deleted)"]));
  }
  return paths;
}

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}

export function formatTurnImpact(snapshot: TurnImpactSnapshot): string[] {
  const lines = [
    `${plural(snapshot.filesRead, "file")} read · ${plural(snapshot.filesModified, "file")} modified`,
  ];
  if (snapshot.filesDeleted) lines.push(plural(snapshot.filesDeleted, "file") + " deleted");
  lines.push(plural(snapshot.shellCommands, "shell command"));
  const tests = [
    snapshot.testsPassed ? `${plural(snapshot.testsPassed, "test")} passed` : "",
    snapshot.testsFailed ? `${plural(snapshot.testsFailed, "test")} failed` : "",
    snapshot.testsUnknown ? `${plural(snapshot.testsUnknown, "test")} running/unknown` : "",
  ].filter(Boolean).join(" · ");
  if (tests) lines.push(tests);
  return lines;
}
