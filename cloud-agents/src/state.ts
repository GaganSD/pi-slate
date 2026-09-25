import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionRecord, SessionRegistry } from "./remote.ts";
import { isRecord } from "./util.ts";

export const STATE_VERSION = 1 as const;
export const DEFAULT_STATE_DIR = join(homedir(), ".pi", "cloud-agents");

export type SetupStep = "auth" | "discover" | "enroll" | "ready";

export type PersistedHost = {
  id: string;
  ocid: string;
  address: string;
  user: string;
  expectedHostKey: string;
  displayName: string;
  compartmentId?: string;
  region?: string;
  operatingSystem?: string;
};

export type PersistedState = {
  version: typeof STATE_VERSION;
  setupStep: SetupStep;
  host?: PersistedHost;
  sessions: SessionRecord[];
  identityFile?: string;
  sshPublicKey?: string;
};

export function defaultState(): PersistedState {
  return { version: STATE_VERSION, setupStep: "auth", sessions: [] };
}

export function statePath(dir: string): string {
  return join(dir, "state.json");
}

export function identityPath(dir: string): string {
  return join(dir, "ssh", "id_ed25519");
}

export async function loadState(dir: string): Promise<PersistedState> {
  try {
    const raw = await readFile(statePath(dir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const state = asPersistedState(parsed);
    return state ?? defaultState();
  } catch {
    return defaultState();
  }
}

export async function saveState(dir: string, state: PersistedState): Promise<void> {
  const path = statePath(dir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function createFileRegistry(dir: string): SessionRegistry {
  return {
    async get(id) {
      const state = await loadState(dir);
      const record = state.sessions.find((session) => session.id === id);
      return record ? { ...record } : undefined;
    },
    async put(record) {
      const state = await loadState(dir);
      const next = state.sessions.filter((session) => session.id !== record.id);
      next.push({ ...record });
      await saveState(dir, { ...state, sessions: next });
    },
    async list(query = {}) {
      const state = await loadState(dir);
      return state.sessions.filter((record) => {
        if (query.hostId && record.hostId !== query.hostId) return false;
        if (query.repo && record.repo !== query.repo) return false;
        if (query.baseBranch && record.baseBranch !== query.baseBranch) return false;
        return true;
      });
    },
  };
}

function asPersistedState(value: unknown): PersistedState | undefined {
  if (!isRecord(value) || value.version !== STATE_VERSION) return undefined;
  const setupStep = value.setupStep;
  if (setupStep !== "auth" && setupStep !== "discover" && setupStep !== "enroll" && setupStep !== "ready") {
    return undefined;
  }
  const sessions = Array.isArray(value.sessions) ? value.sessions.filter(isSessionRecord) : [];
  const host = isPersistedHost(value.host) ? value.host : undefined;
  return {
    version: STATE_VERSION,
    setupStep,
    host,
    sessions,
    identityFile: typeof value.identityFile === "string" ? value.identityFile : undefined,
    sshPublicKey: typeof value.sshPublicKey === "string" ? value.sshPublicKey : undefined,
  };
}

function isPersistedHost(value: unknown): value is PersistedHost {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.ocid === "string" &&
    typeof value.address === "string" &&
    typeof value.user === "string" &&
    typeof value.expectedHostKey === "string" &&
    typeof value.displayName === "string"
  );
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.hostId === "string" &&
    typeof value.repo === "string" &&
    typeof value.baseBranch === "string" &&
    typeof value.workingBranch === "string" &&
    typeof value.tmuxSession === "string" &&
    typeof value.remotePath === "string" &&
    typeof value.piSession === "string" &&
    typeof value.status === "string" &&
    value.worktreesOwnedBy === "subagents"
  );
}
