import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
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

export class StateLoadError extends Error {
  readonly code = "corrupt-state";
  constructor(message: string) {
    super(message);
    this.name = "StateLoadError";
  }
}

export class StateLockError extends Error {
  readonly code = "concurrent-start";
  constructor(message: string) {
    super(message);
    this.name = "StateLockError";
  }
}

export function defaultState(): PersistedState {
  return { version: STATE_VERSION, setupStep: "auth", sessions: [] };
}

export function statePath(dir: string): string {
  return join(dir, "state.json");
}

export function identityPath(dir: string): string {
  return join(dir, "ssh", "id_ed25519");
}

export function setupLockPath(dir: string): string {
  return join(dir, "setup.lock");
}

export function stateWriteLockPath(dir: string): string {
  return join(dir, "state.write.lock");
}

export async function loadState(dir: string): Promise<PersistedState> {
  const path = statePath(dir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return defaultState();
    throw new StateLoadError(
      `state.json exists but cannot be read (${errorMessage(error)}). Refusing first-run create so a duplicate VM cannot be launched.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new StateLoadError(
      "state.json is corrupt JSON. Refusing to treat this as a first run. Inspect the file; do not delete it to force another create unless you have confirmed no VM exists.",
    );
  }
  const state = asPersistedState(parsed);
  if (!state) {
    throw new StateLoadError(
      "state.json failed strict validation. Refusing first-run create. Ambiguous or partial state must be inspected, not overwritten.",
    );
  }
  return state;
}

export async function saveState(dir: string, state: PersistedState): Promise<void> {
  const parsed = asPersistedState(state);
  if (!parsed) {
    throw new StateLoadError("refusing to write invalid Pi Cloud state");
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = statePath(dir);
  const tmp = join(dir, `state.json.tmp.${process.pid}.${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function withExclusiveLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  await acquireExclusiveLock(lockPath);
  try {
    return await work();
  } finally {
    await releaseExclusiveLock(lockPath);
  }
}

export async function acquireExclusiveLock(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new StateLockError(
        `exclusive lock already exists at ${lockPath}. Another pi --cloud may be in flight. If no other process is running, inspect that lock and remove it only after you confirm no create is in flight. Automatic steal is refused.`,
      );
    }
    throw error;
  }
}

export async function releaseExclusiveLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true });
}

export async function updateState(
  dir: string,
  mutate: (state: PersistedState) => PersistedState | Promise<PersistedState>,
): Promise<PersistedState> {
  return await withExclusiveLock(stateWriteLockPath(dir), async () => {
    const current = await loadState(dir);
    const next = await mutate(current);
    await saveState(dir, next);
    return next;
  });
}

export function createFileRegistry(dir: string): SessionRegistry {
  return {
    async get(id) {
      const state = await loadState(dir);
      const record = state.sessions.find((session) => session.id === id);
      return record ? { ...record } : undefined;
    },
    async put(record) {
      await updateState(dir, (state) => {
        const next = state.sessions.filter((session) => session.id !== record.id);
        next.push({ ...record });
        return { ...state, sessions: next };
      });
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

export function asPersistedState(value: unknown): PersistedState | undefined {
  if (!isRecord(value) || value.version !== STATE_VERSION) return undefined;
  const setupStep = value.setupStep;
  if (setupStep !== "auth" && setupStep !== "discover" && setupStep !== "enroll" && setupStep !== "ready") {
    return undefined;
  }
  if (!Array.isArray(value.sessions) || !value.sessions.every(isSessionRecord)) return undefined;
  if (value.host !== undefined && !isPersistedHost(value.host)) return undefined;
  if ((setupStep === "enroll" || setupStep === "ready") && !isPersistedHost(value.host)) return undefined;
  if (value.identityFile !== undefined && typeof value.identityFile !== "string") return undefined;
  if (value.sshPublicKey !== undefined && typeof value.sshPublicKey !== "string") return undefined;
  const host = isPersistedHost(value.host) ? value.host : undefined;
  return {
    version: STATE_VERSION,
    setupStep,
    host,
    sessions: value.sessions.filter(isSessionRecord),
    identityFile: typeof value.identityFile === "string" ? value.identityFile : undefined,
    sshPublicKey: typeof value.sshPublicKey === "string" ? value.sshPublicKey : undefined,
  };
}

function isPersistedHost(value: unknown): value is PersistedHost {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.ocid === "string" &&
    value.ocid.length > 0 &&
    typeof value.address === "string" &&
    typeof value.user === "string" &&
    value.user.length > 0 &&
    typeof value.expectedHostKey === "string" &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0
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

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
