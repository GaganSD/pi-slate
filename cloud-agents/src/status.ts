import { hostname } from "node:os";
import type { CommandRunner } from "./oci.ts";
import { REMOTE_ROOT_SEGMENT, type SessionRecord } from "./remote.ts";
import type { PersistedHost, PersistedState } from "./state.ts";

export type CloudConnection = "ok" | "unreachable" | "unknown";
export type CloudMode = "local" | "local-known" | "remote";

export type CloudStatus = {
  mode: CloudMode;
  host: string;
  connection: CloudConnection;
  repo?: string;
  path?: string;
  baseBranch?: string;
  workingBranch?: string;
  piSession?: string;
  tmuxSession?: string;
  subagentRuns: "unknown";
  commitsOnlyLocal: boolean | "unknown";
  notes: string[];
};

export type StatusQuery = {
  cwd: string;
  run?: CommandRunner;
  sessionId?: string;
  sessionName?: string;
  persisted?: PersistedState;
  live?: SessionRecord;
};

export function isRemoteCloudWorkspace(cwd: string): boolean {
  const normalized = cwd.replaceAll("\\", "/");
  return normalized.includes(`/${REMOTE_ROOT_SEGMENT}/sessions/`);
}

export async function inspectCloudStatus(query: StatusQuery): Promise<CloudStatus> {
  if (isRemoteCloudWorkspace(query.cwd)) {
    return await inspectRemoteStatus(query);
  }
  return inspectLocalStatus(query);
}

export function formatCloudStatus(status: CloudStatus): string {
  const lines = [
    `Pi Cloud status`,
    `mode: ${status.mode}`,
    `host: ${status.host}`,
    `connection: ${status.connection}`,
    `repo: ${status.repo ?? "unknown"}`,
    `path: ${status.path ?? "unknown"}`,
    `base branch: ${status.baseBranch ?? "unknown"}`,
    `working branch: ${status.workingBranch ?? "unknown"}`,
    `pi session: ${status.piSession ?? "unknown"}`,
    `tmux: ${status.tmuxSession ?? "unknown"}`,
    `subagent runs: ${status.subagentRuns}`,
    `commits only local: ${status.commitsOnlyLocal === "unknown" ? "unknown" : status.commitsOnlyLocal ? "yes" : "no"}`,
    ...status.notes.map((note) => `note: ${note}`),
  ];
  return lines.join("\n");
}

function inspectLocalStatus(query: StatusQuery): CloudStatus {
  const host = query.persisted?.host;
  const session = query.live ?? newestSession(query.persisted, host);
  if (!host && !session) {
    return {
      mode: "local",
      host: "none",
      connection: "unknown",
      subagentRuns: "unknown",
      commitsOnlyLocal: "unknown",
      notes: ["Cloud is not active. Ordinary `pi` is unchanged. Start with `pi --cloud`."],
    };
  }
  return {
    mode: "local-known",
    host: describeHost(host),
    connection: "unknown",
    repo: session?.repo,
    path: session?.remotePath,
    baseBranch: session?.baseBranch,
    workingBranch: session?.workingBranch,
    piSession: session?.piSession ?? session?.id,
    tmuxSession: session?.tmuxSession,
    subagentRuns: "unknown",
    commitsOnlyLocal: "unknown",
    notes: [
      "This is last-known local state, not a live SSH inspect.",
      "Unknown or unreachable work is shown as unknown, not idle.",
    ],
  };
}

export function sessionIdFromCloudPath(cwd: string): string | undefined {
  const match = cwd.replaceAll("\\", "/").match(/\/pi-cloud\/sessions\/([^/]+)/);
  return match?.[1];
}

async function inspectRemoteStatus(query: StatusQuery): Promise<CloudStatus> {
  const git = query.run ? await readGit(query.run, query.cwd) : undefined;
  const sessionId = query.sessionId ?? sessionIdFromCloudPath(query.cwd);
  const recorded =
    query.live ??
    query.persisted?.sessions.find((session) => session.id === sessionId || session.piSession === sessionId);
  const notes = [
    "Remote `/cloud` is read-only status.",
    "Sign in to the model provider on this VM; local laptop credentials are not copied.",
  ];
  if (git?.ahead === "unknown" || (git?.origin === undefined && !recorded?.repo)) {
    notes.push("Git state is unknown.");
  }
  if (!git?.baseBranch && !recorded?.baseBranch) {
    notes.push("Base branch is unknown without @{upstream} or a saved session record.");
  }
  return {
    mode: "remote",
    host: hostname() || "unknown",
    connection: "ok",
    repo: git?.origin ?? recorded?.repo,
    path: query.cwd,
    baseBranch: git?.baseBranch ?? recorded?.baseBranch,
    workingBranch: git?.branch ?? recorded?.workingBranch,
    piSession: sessionId ?? query.sessionName ?? recorded?.piSession ?? "unknown",
    tmuxSession: recorded?.tmuxSession,
    subagentRuns: "unknown",
    commitsOnlyLocal: git?.ahead === "unknown" || git?.ahead === undefined ? "unknown" : git.ahead,
    notes,
  };
}

async function readGit(
  run: CommandRunner,
  cwd: string,
): Promise<{ origin?: string; branch?: string; baseBranch?: string; ahead: boolean | "unknown" }> {
  const origin = await run(["git", "-C", cwd, "remote", "get-url", "origin"]);
  const branch = await run(["git", "-C", cwd, "branch", "--show-current"]);
  const upstream = await run([
    "git",
    "-C",
    cwd,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (origin.code !== 0 && branch.code !== 0) {
    return { ahead: "unknown" };
  }
  let ahead: boolean | "unknown" = "unknown";
  if (upstream.code === 0) {
    const count = await run(["git", "-C", cwd, "rev-list", "--count", "@{upstream}..HEAD"]);
    if (count.code === 0) ahead = Number(count.stdout.trim()) > 0;
  } else {
    ahead = true;
  }
  return {
    origin: origin.code === 0 ? origin.stdout.trim() || undefined : undefined,
    branch: branch.code === 0 ? branch.stdout.trim() || undefined : undefined,
    baseBranch: upstream.code === 0 ? stripRemote(upstream.stdout.trim()) : undefined,
    ahead,
  };
}

function stripRemote(ref: string): string {
  return ref.replace(/^origin\//, "") || ref;
}

function newestSession(state: PersistedState | undefined, host?: PersistedHost): SessionRecord | undefined {
  const sessions = state?.sessions ?? [];
  const scoped = host ? sessions.filter((session) => session.hostId === host.id) : sessions;
  return scoped.at(-1);
}

function describeHost(host?: PersistedHost): string {
  if (!host) return "unknown";
  return `${host.user}@${host.address} (${host.displayName})`;
}
