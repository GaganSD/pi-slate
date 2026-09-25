import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  classifySshHostFingerprintSource,
  GUEST_SSH_HOST_FINGERPRINT_SOURCE,
  isUsableGuestSshHostFingerprint,
  SERIAL_CONSOLE_FINGERPRINT_SOURCE,
  spawnCommand,
  type CommandResult,
  type CommandRunner,
} from "./oci.ts";

/** Guest Ubuntu sshd keys may be enrolled only from independently authenticated cloud-init console history. */
export const REQUIRED_HOST_KEY_SOURCE = GUEST_SSH_HOST_FINGERPRINT_SOURCE;

export const SESSION_BRANCH_PREFIX = "pi/";
export const TMUX_SESSION_PREFIX = "pi-";
export const REMOTE_ROOT_SEGMENT = "pi-cloud";
export const WORKTREES_OWNED_BY = "subagents" as const;
export const MIN_REMOTE_NODE = "22.19";

const HOST_NAME =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOST_KEY_RE =
  /^(ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com)\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/;
const SECRET_PATH_RE = /(?:^|[\\/])(?:\.oci|\.env|secrets\.yml|id_rsa|id_ed25519|id_ecdsa)(?:$|[\\/])/;

export type RemoteHost = {
  id: string;
  address: string;
  user: string;
  expectedHostKey: string;
};

export type PinnedHost = {
  host: RemoteHost;
  knownHostsPath: string;
  aliases: readonly string[];
  source: typeof REQUIRED_HOST_KEY_SOURCE;
};

export type RemoteBlockerCode =
  | "untrusted-host-key-source"
  | "missing-host-key"
  | "invalid-host-key"
  | "host-key-mismatch"
  | "invalid-host"
  | "unpinned-host"
  | "ssh-failure"
  | "unreachable"
  | "dirty-worktree"
  | "unpushed-branch"
  | "missing-origin"
  | "missing-base-branch"
  | "invalid-repo"
  | "invalid-branch"
  | "invalid-session"
  | "concurrent-start"
  | "duplicate-parent"
  | "stale-session"
  | "wrong-arch"
  | "missing-tool"
  | "unknown-status";

export type RemoteBlocker = {
  code: RemoteBlockerCode;
  message: string;
};

export type HostKeyEnrollment = {
  host: RemoteHost;
  source: string;
  aliases?: readonly string[];
};

export type PinResult =
  | { ok: true; pinned: PinnedHost }
  | { ok: false; blockers: RemoteBlocker[] };

export type RepoSelectionInput = {
  cwd?: string;
  repo?: string;
  branch?: string;
  sessionId: string;
};

export type RepoSelection =
  | {
      ok: true;
      repo: string;
      baseBranch: string;
      workingBranch: string;
      inferred: boolean;
    }
  | { ok: false; blockers: RemoteBlocker[] };

export type SessionStatus =
  | "starting"
  | "running"
  | "detached"
  | "exited"
  | "rebooted"
  | "stale"
  | "unreachable"
  | "unknown";

export type SessionRecord = {
  id: string;
  hostId: string;
  repo: string;
  baseBranch: string;
  workingBranch: string;
  tmuxSession: string;
  remotePath: string;
  piSession: string;
  bootId?: string;
  status: SessionStatus;
  worktreesOwnedBy: typeof WORKTREES_OWNED_BY;
};

export type SessionRegistry = {
  get(id: string): Promise<SessionRecord | undefined>;
  put(record: SessionRecord): Promise<void>;
  list(query?: { hostId?: string; repo?: string; baseBranch?: string }): Promise<SessionRecord[]>;
};

export type AttachRunner = (argv: readonly string[]) => Promise<{ code: number; stderr: string }>;

export type StartRequest = {
  pinned: PinnedHost;
  cwd?: string;
  repo?: string;
  branch?: string;
  sessionId?: string;
  identityFile?: string;
};

export type StartResult =
  | { status: "started"; session: SessionRecord }
  | { status: "blocked"; blockers: RemoteBlocker[]; session?: SessionRecord };

export type AttachRequest = {
  pinned: PinnedHost;
  sessionId: string;
  identityFile?: string;
};

export type AttachResult = {
  status: "detached" | "exited" | "rebooted" | "unreachable" | "blocked" | "unknown";
  blockers: RemoteBlocker[];
  session?: SessionRecord;
};

export type InspectQuery = {
  pinned: PinnedHost;
  sessionId: string;
  identityFile?: string;
};

export type InspectResult = {
  session?: SessionRecord;
  blockers: RemoteBlocker[];
  connection: "ok" | "unreachable" | "unknown";
};

export type RemoteTransportOptions = {
  run?: CommandRunner;
  attach?: AttachRunner;
  knownHostsDir?: string;
  registry?: SessionRegistry;
  randomId?: () => string;
  remotePiArgv?: readonly string[];
};

export type RemoteTransport = {
  pinHostKey(enrollment: HostKeyEnrollment): Promise<PinResult>;
  selectRepo(input: RepoSelectionInput): Promise<RepoSelection>;
  start(request: StartRequest): Promise<StartResult>;
  attach(request: AttachRequest): Promise<AttachResult>;
  inspect(query: InspectQuery): Promise<InspectResult>;
};

export function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Quote every remote argv element so OpenSSH's remote shell cannot resplit or inject. */
export function quoteRemoteCommand(command: readonly string[]): string {
  return command.map(posixQuote).join(" ");
}

/** Inverse of quoteRemoteCommand. Invalid input is empty (fail-closed). */
export function unquoteRemoteCommand(quoted: string): string[] {
  if (!quoted || /[\n\r]/.test(quoted)) return [];
  const words: string[] = [];
  let i = 0;
  while (i < quoted.length) {
    if (quoted[i] === " ") {
      i += 1;
      continue;
    }
    if (quoted[i] !== "'") return [];
    let word = "";
    while (i < quoted.length && quoted[i] !== " ") {
      if (quoted[i] === "'") {
        i += 1;
        const start = i;
        const end = quoted.indexOf("'", i);
        if (end < 0) return [];
        word += quoted.slice(start, end);
        i = end + 1;
        continue;
      }
      if (quoted[i] === "\\" && quoted[i + 1] === "'") {
        word += "'";
        i += 2;
        continue;
      }
      return [];
    }
    words.push(word);
  }
  return words;
}

export function isPosixQuotedCommand(quoted: string): boolean {
  const words = unquoteRemoteCommand(quoted);
  return words.length > 0 && quoteRemoteCommand(words) === quoted;
}

export function isSafeHostAddress(value: string): boolean {
  const address = value.trim();
  if (!address || address.length > 253) return false;
  if (looksLikeInjection(address)) return false;
  if (IPV4.test(address)) {
    return address.split(".").every((part) => Number(part) <= 255);
  }
  if (address.includes(":")) {
    return IPV6.test(address) && address.split(":").length >= 3;
  }
  return HOST_NAME.test(address);
}

export function isSafeUser(value: string): boolean {
  return USER_RE.test(value) && !looksLikeInjection(value);
}

export function isSafeSessionId(value: string): boolean {
  return ID_RE.test(value) && !value.includes("..") && !looksLikeInjection(value);
}

export function isSafeBranch(value: string): boolean {
  return BRANCH_RE.test(value) && !value.includes("..") && !value.startsWith("/") && !looksLikeInjection(value);
}

export function isSafeRepo(value: string): boolean {
  if (!value || looksLikeInjection(value) || value.includes("..") || /\s/.test(value)) return false;
  if (OWNER_REPO.test(value)) return true;
  if (/^https:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=-]+$/.test(value)) {
    return !value.includes(";") && !value.includes("|") && !value.includes("$");
  }
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.\/-]+\.git$/.test(value)) return true;
  if (/^ssh:\/\/[A-Za-z0-9._@:-]+\/[A-Za-z0-9_.\/-]+$/.test(value)) return true;
  return false;
}

export function workingBranchFor(sessionId: string): string {
  return `${SESSION_BRANCH_PREFIX}${sessionId}`;
}

export function tmuxSessionFor(sessionId: string): string {
  return `${TMUX_SESSION_PREFIX}${sessionId}`;
}

export function normalizeRepo(value: string): string {
  if (OWNER_REPO.test(value)) return `https://github.com/${value}.git`;
  return value;
}

export function canonicalizeRepo(value: string): string {
  let normalized = normalizeRepo(value).trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const scp = /^git@([^:]+):(.+)$/.exec(normalized);
  if (scp) normalized = `https://${scp[1]}/${scp[2]}`;
  return normalized.toLowerCase();
}

export function sameRepo(left: string, right: string): boolean {
  return canonicalizeRepo(left) === canonicalizeRepo(right);
}

export function nodeVersionAtLeast(raw: string, minimum = MIN_REMOTE_NODE): boolean {
  const actual = parseDottedVersion(raw);
  const needed = parseDottedVersion(minimum);
  if (!actual || !needed) return false;
  for (let i = 0; i < Math.max(actual.length, needed.length); i += 1) {
    const a = actual[i] ?? 0;
    const b = needed[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function parseDottedVersion(raw: string): number[] | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function sshDestination(host: RemoteHost): string {
  const address = host.address.includes(":") ? `[${host.address}]` : host.address;
  return `${host.user}@${address}`;
}

export function parseHostKey(raw: string): { type: string; data: string; comment: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("SHA256:") || trimmed.startsWith("MD5:")) return undefined;
  const tokens = trimmed.split(/\s+/);
  const keyIndex = tokens.findIndex((_, index) => HOST_KEY_RE.test(tokens.slice(index).join(" ")));
  if (keyIndex < 0 || tokens.length - keyIndex < 2) return undefined;
  const type = tokens[keyIndex];
  const data = tokens[keyIndex + 1];
  const comment = tokens.slice(keyIndex + 2).join(" ");
  if (!HOST_KEY_RE.test(`${type} ${data}${comment ? ` ${comment}` : ""}`)) return undefined;
  return { type, data, comment };
}

export function buildKnownHostsBody(aliases: readonly string[], expectedHostKey: string): string | undefined {
  const parsed = parseHostKey(expectedHostKey);
  if (!parsed) return undefined;
  const hosts = unique(aliases.filter(isSafeHostAddress));
  if (hosts.length === 0) return undefined;
  const comment = parsed.comment ? ` ${parsed.comment}` : "";
  return `${hosts.join(",")} ${parsed.type} ${parsed.data}${comment}\n`;
}

export function buildSshArgv(input: {
  host: RemoteHost;
  knownHostsPath: string;
  command?: readonly string[];
  tty?: boolean;
  identityFile?: string;
}): string[] {
  const argv = [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${input.knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "HashKnownHosts=no",
  ];
  if (input.tty) argv.push("-tt");
  else argv.push("-o", "RequestTTY=no");
  if (input.identityFile) argv.push("-i", input.identityFile);
  argv.push(sshDestination(input.host));
  if (input.command && input.command.length > 0) {
    argv.push(quoteRemoteCommand(input.command));
  }
  return argv;
}

export function sshArgvIsSecure(argv: readonly string[]): boolean {
  if (argv[0] !== "ssh") return false;
  if (argv.some((part) => part.includes("accept-new"))) return false;
  if (argv.some((part) => /StrictHostKeyChecking=(?:no|off|ask|accept-new)/i.test(part))) return false;
  if (argv.some((part) => /UserKnownHostsFile=\/dev\/null/i.test(part))) return false;
  if (!argv.includes("StrictHostKeyChecking=yes")) return false;
  if (!argv.some((part) => part.startsWith("UserKnownHostsFile=") && part.length > "UserKnownHostsFile=".length)) {
    return false;
  }
  const dest = sshDestinationIndex(argv);
  if (dest < 0) return false;
  const rest = argv.slice(dest + 1);
  if (rest.includes("--") || rest.length !== 1 || !isPosixQuotedCommand(rest[0] ?? "")) return false;
  const remote = unquoteRemoteCommand(rest[0] ?? "");
  if (remote[0] === "sh" || remote[0] === "bash" || (remote[0] === "env" && remote.includes("-c"))) return false;
  return true;
}

export function looksLikeSecretTransfer(argv: readonly string[]): boolean {
  if (argv[0] === "scp" || argv[0] === "rsync") return true;
  const remote = argv[0] === "ssh" ? remoteArgv(argv) : argv;
  return remote.some((part) => SECRET_PATH_RE.test(part));
}

export function remoteArgv(argv: readonly string[]): readonly string[] {
  const dest = sshDestinationIndex(argv);
  if (dest < 0) return [];
  const rest = argv.slice(dest + 1);
  if (rest.includes("--") || rest.length !== 1) return [];
  return unquoteRemoteCommand(rest[0] ?? "");
}

function sshDestinationIndex(argv: readonly string[]): number {
  return argv.findIndex((part, index) => index > 0 && !part.startsWith("-") && part.includes("@"));
}

export function classifySshFailure(result: CommandResult): RemoteBlocker {
  const text = `${result.stdout}\n${result.stderr}`;
  if (/HOST KEY VERIFICATION FAILED|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
    return {
      code: "host-key-mismatch",
      message: "SSH host identity changed; connection blocked",
    };
  }
  if (/connection refused|timed out|network is unreachable|no route to host|could not resolve/i.test(text)) {
    return {
      code: "unreachable",
      message: result.stderr.trim() || "SSH host is unreachable",
    };
  }
  return {
    code: "ssh-failure",
    message: result.stderr.trim() || `SSH failed with exit ${result.code}`,
  };
}

export function classifyRemotePresence(input: {
  registry?: SessionRecord;
  reachable: boolean;
  tmuxAlive?: boolean;
  bootId?: string;
  sessionDir?: boolean;
}): SessionStatus {
  if (!input.reachable) return input.registry ? "unreachable" : "unreachable";
  if (input.tmuxAlive) return input.registry?.status === "detached" ? "detached" : "running";
  if (input.registry && input.bootId && input.registry.bootId && input.bootId !== input.registry.bootId) {
    return "rebooted";
  }
  if (input.registry && input.sessionDir === false) return "stale";
  if (input.registry && input.tmuxAlive === false && input.sessionDir) return "exited";
  if (input.registry && input.tmuxAlive === undefined) return "unknown";
  return input.registry ? "unknown" : "unknown";
}

export function createMemoryRegistry(seed: SessionRecord[] = []): SessionRegistry {
  const map = new Map(seed.map((record) => [record.id, { ...record }]));
  return {
    async get(id) {
      const record = map.get(id);
      return record ? { ...record } : undefined;
    },
    async put(record) {
      map.set(record.id, { ...record });
    },
    async list(query = {}) {
      return [...map.values()].filter((record) => {
        if (query.hostId && record.hostId !== query.hostId) return false;
        if (query.repo && record.repo !== query.repo) return false;
        if (query.baseBranch && record.baseBranch !== query.baseBranch) return false;
        return true;
      });
    },
  };
}

export function createRemoteTransport(options: RemoteTransportOptions = {}): RemoteTransport {
  const run = options.run ?? spawnCommand;
  const attachRun = options.attach ?? spawnInteractive;
  const knownHostsDir = options.knownHostsDir ?? join(homedir(), ".pi", "cloud-agents", "known_hosts.d");
  const registry = options.registry ?? createMemoryRegistry();
  const randomId = options.randomId ?? defaultRandomId;
  const remotePiArgv = options.remotePiArgv ?? ["pi"];
  const pins = new Map<string, PinnedHost>();
  const startLocks = new Set<string>();

  const pinHostKey = async (enrollment: HostKeyEnrollment): Promise<PinResult> => {
    const hostError = validateHost(enrollment.host);
    if (hostError) return { ok: false, blockers: [hostError] };
    const source = classifySshHostFingerprintSource(enrollment.source);
    const keySource = classifySshHostFingerprintSource(enrollment.host.expectedHostKey);
    if (
      !isUsableGuestSshHostFingerprint(source) ||
      keySource === SERIAL_CONSOLE_FINGERPRINT_SOURCE ||
      source === SERIAL_CONSOLE_FINGERPRINT_SOURCE
    ) {
      return {
        ok: false,
        blockers: [
          {
            code: "untrusted-host-key-source",
            message:
              source === SERIAL_CONSOLE_FINGERPRINT_SOURCE || keySource === SERIAL_CONSOLE_FINGERPRINT_SOURCE
                ? "serial-console service key must not be enrolled as the Ubuntu sshd host key"
                : "guest sshd fingerprint must come from independently authenticated cloud-init console-history",
          },
        ],
      };
    }
    if (!enrollment.host.expectedHostKey.trim()) {
      return { ok: false, blockers: [blocker("missing-host-key", "expected guest sshd host key is empty")] };
    }
    const aliases = unique([enrollment.host.address, ...(enrollment.aliases ?? [])]);
    if (aliases.some((alias) => !isSafeHostAddress(alias))) {
      return { ok: false, blockers: [blocker("invalid-host", "a public IP or tailnet alias is not a safe host token")] };
    }
    const body = buildKnownHostsBody(aliases, enrollment.host.expectedHostKey);
    if (!body) {
      return {
        ok: false,
        blockers: [blocker("invalid-host-key", "expectedHostKey must be an OpenSSH public host key, not a fingerprint")],
      };
    }
    const knownHostsPath = join(knownHostsDir, `${enrollment.host.id}.known_hosts`);
    await mkdir(dirname(knownHostsPath), { recursive: true });
    await writeFile(knownHostsPath, body, { mode: 0o600 });
    const pinned: PinnedHost = {
      host: enrollment.host,
      knownHostsPath,
      aliases,
      source: REQUIRED_HOST_KEY_SOURCE,
    };
    pins.set(enrollment.host.id, pinned);
    return { ok: true, pinned };
  };

  const selectRepo = async (input: RepoSelectionInput): Promise<RepoSelection> => {
    return await selectRepoAndBase(input, run);
  };

  const start = async (request: StartRequest): Promise<StartResult> => {
    const pinnedError = requirePinned(pins, request.pinned);
    if (pinnedError) return { status: "blocked", blockers: [pinnedError] };
    const identityError = validateIdentity(request.identityFile);
    if (identityError) return { status: "blocked", blockers: [identityError] };
    const sessionId = request.sessionId ?? randomId();
    if (!isSafeSessionId(sessionId)) {
      return { status: "blocked", blockers: [blocker("invalid-session", "session id is not a safe token")] };
    }
    const selected = await selectRepoAndBase({ ...request, sessionId }, run);
    if (!selected.ok) return { status: "blocked", blockers: selected.blockers };
    const lockKey = `${request.pinned.host.id}:${sessionId}`;
    if (startLocks.has(lockKey)) {
      return {
        status: "blocked",
        blockers: [blocker("concurrent-start", "another start is already running for this session")],
      };
    }
    startLocks.add(lockKey);
    const paths = remotePaths(request.pinned.host, sessionId);
    const record: SessionRecord = {
      id: sessionId,
      hostId: request.pinned.host.id,
      repo: selected.repo,
      baseBranch: selected.baseBranch,
      workingBranch: selected.workingBranch,
      tmuxSession: tmuxSessionFor(sessionId),
      remotePath: paths.work,
      piSession: sessionId,
      status: "starting",
      worktreesOwnedBy: WORKTREES_OWNED_BY,
    };
    await registry.put(record);
    try {
      const ssh = (command: readonly string[]) =>
        runSecureSsh(run, {
          host: request.pinned.host,
          knownHostsPath: request.pinned.knownHostsPath,
          identityFile: request.identityFile,
          command,
        });

      const arch = await ssh(["uname", "-m"]);
      if (arch.code !== 0) return sshBlocked(arch, record);
      if (!isArm64(arch.stdout)) {
        return {
          status: "blocked",
          blockers: [blocker("wrong-arch", `remote uname -m is ${arch.stdout.trim() || "unknown"}; ARM64 required`)],
          session: record,
        };
      }

      const tools = await ensureRemoteTools(ssh);
      if (!tools.ok) return { status: "blocked", blockers: tools.blockers, session: record };

      const existing = await ssh(["tmux", "has-session", "-t", record.tmuxSession]);
      if (existing.code === 0) {
        return {
          status: "blocked",
          blockers: [blocker("duplicate-parent", "remote tmux already has this Pi parent; attach instead of starting")],
          session: { ...record, status: "running" },
        };
      }

      const prepared = await ssh(["mkdir", "-p", paths.session]);
      if (prepared.code !== 0) return sshBlocked(prepared, record);

      const locked = await ssh(["mkdir", paths.lock]);
      if (locked.code !== 0) {
        const presence = await inspectRemote(ssh, record);
        if (presence.tmuxAlive) {
          return {
            status: "blocked",
            blockers: [blocker("concurrent-start", "remote start lock is held by a live Pi parent")],
            session: { ...record, status: "running", bootId: presence.bootId },
          };
        }
        return {
          status: "blocked",
          blockers: [blocker("concurrent-start", "remote start lock already exists")],
          session: { ...record, status: presence.status },
        };
      }

      const boot = await ssh(["cat", "/proc/sys/kernel/random/boot_id"]);
      if (boot.code !== 0) {
        await ssh(["rmdir", paths.lock]);
        return sshBlocked(boot, record);
      }
      record.bootId = boot.stdout.trim();
      await ssh(["cp", "/proc/sys/kernel/random/boot_id", paths.boot]);

      const cloned = await ensureRemoteRepo(ssh, record);
      if (!cloned.ok) {
        await ssh(["rmdir", paths.lock]);
        return { status: "blocked", blockers: cloned.blockers, session: record };
      }

      const piArgv = remotePiArgv.includes("--session-id")
        ? [...remotePiArgv]
        : [...remotePiArgv, "--session-id", sessionId];
      const started = await ssh([
        "tmux",
        "new-session",
        "-d",
        "-s",
        record.tmuxSession,
        "-c",
        record.remotePath,
        ...piArgv,
      ]);
      if (started.code !== 0) {
        await ssh(["rmdir", paths.lock]);
        return sshBlocked(started, record);
      }
      const verified = await ssh(["tmux", "has-session", "-t", record.tmuxSession]);
      await ssh(["rmdir", paths.lock]);
      if (verified.code !== 0) {
        return {
          status: "blocked",
          blockers: [blocker("missing-tool", `tmux session ${record.tmuxSession} did not start; Pi parent is not running`)],
          session: record,
        };
      }

      const live: SessionRecord = { ...record, status: "running" };
      await registry.put(live);
      return { status: "started", session: live };
    } finally {
      startLocks.delete(lockKey);
    }
  };

  const inspect = async (query: InspectQuery): Promise<InspectResult> => {
    const pinnedError = requirePinned(pins, query.pinned);
    if (pinnedError) return { blockers: [pinnedError], connection: "unknown" };
    const identityError = validateIdentity(query.identityFile);
    if (identityError) return { blockers: [identityError], connection: "unknown" };
    if (!isSafeSessionId(query.sessionId)) {
      return { blockers: [blocker("invalid-session", "session id is not a safe token")], connection: "unknown" };
    }
    const recorded = await registry.get(query.sessionId);
    const ssh = (command: readonly string[]) =>
      runSecureSsh(run, {
        host: query.pinned.host,
        knownHostsPath: query.pinned.knownHostsPath,
        identityFile: query.identityFile,
        command,
      });
    const presence = await inspectRemote(ssh, recorded ?? skeletonRecord(query.pinned.host, query.sessionId));
    if (!presence.reachable) {
      const status: SessionStatus = recorded ? "unreachable" : "unreachable";
      const session = recorded ? { ...recorded, status } : undefined;
      if (session) await registry.put(session);
      return {
        session,
        blockers: presence.blockers,
        connection: "unreachable",
      };
    }
    const session: SessionRecord = {
      ...(recorded ?? skeletonRecord(query.pinned.host, query.sessionId)),
      bootId: presence.bootId ?? recorded?.bootId,
      status: classifyRemotePresence({
        registry: recorded,
        reachable: true,
        tmuxAlive: presence.tmuxAlive,
        bootId: presence.bootId,
        sessionDir: presence.sessionDir,
      }),
    };
    await registry.put(session);
    return { session, blockers: [], connection: "ok" };
  };

  const attach = async (request: AttachRequest): Promise<AttachResult> => {
    const inspected = await inspect(request);
    if (inspected.connection === "unreachable") {
      return { status: "unreachable", blockers: inspected.blockers, session: inspected.session };
    }
    if (inspected.blockers.length > 0) {
      return { status: "blocked", blockers: inspected.blockers, session: inspected.session };
    }
    const session = inspected.session;
    if (!session) return { status: "unknown", blockers: [blocker("unknown-status", "remote session state is unknown")] };
    if (session.status === "stale") {
      return { status: "blocked", blockers: [blocker("stale-session", "registry session does not exist on the host")], session };
    }
    if (session.status === "rebooted") {
      return { status: "rebooted", blockers: [], session };
    }
    if (session.status === "exited") {
      return { status: "exited", blockers: [], session };
    }
    if (session.status !== "running" && session.status !== "detached") {
      return { status: "unknown", blockers: [blocker("unknown-status", "remote session state is unknown")], session };
    }
    const argv = buildSshArgv({
      host: request.pinned.host,
      knownHostsPath: request.pinned.knownHostsPath,
      identityFile: request.identityFile,
      tty: true,
      command: ["tmux", "attach-session", "-t", session.tmuxSession],
    });
    if (!sshArgvIsSecure(argv) || remoteArgv(argv).includes("send-keys")) {
      return { status: "blocked", blockers: [blocker("ssh-failure", "refusing insecure or prompt-replaying attach argv")] };
    }
    const attached = await attachRun(argv);
    const after = await inspect(request);
    if (after.connection === "unreachable") {
      return { status: "unreachable", blockers: after.blockers, session: after.session };
    }
    if (attached.code === 255 || /HOST KEY VERIFICATION FAILED/i.test(attached.stderr)) {
      const failure = classifySshFailure({ code: attached.code, stdout: "", stderr: attached.stderr });
      return {
        status: failure.code === "unreachable" ? "unreachable" : "blocked",
        blockers: [failure],
        session: after.session,
      };
    }
    const status = after.session?.status;
    if (status === "running" || status === "detached") {
      const detached = { ...after.session!, status: "detached" as const };
      await registry.put(detached);
      return { status: "detached", blockers: [], session: detached };
    }
    if (status === "rebooted") return { status: "rebooted", blockers: [], session: after.session };
    if (status === "exited") return { status: "exited", blockers: [], session: after.session };
    return { status: "unknown", blockers: after.blockers, session: after.session };
  };

  return { pinHostKey, selectRepo, start, attach, inspect };
}

export async function selectRepoAndBase(input: RepoSelectionInput, run: CommandRunner): Promise<RepoSelection> {
  if (!isSafeSessionId(input.sessionId)) {
    return { ok: false, blockers: [blocker("invalid-session", "session id is not a safe token")] };
  }
  const workingBranch = workingBranchFor(input.sessionId);
  if (input.repo) {
    if (!isSafeRepo(input.repo)) {
      return { ok: false, blockers: [blocker("invalid-repo", "repo is not a safe owner/repo or git URL")] };
    }
    const repo = normalizeRepo(input.repo);
    if (input.branch) {
      if (!isSafeBranch(input.branch)) {
        return { ok: false, blockers: [blocker("invalid-branch", "base branch is not a safe git ref")] };
      }
      return { ok: true, repo, baseBranch: input.branch, workingBranch, inferred: false };
    }
    const localBase = await localBranchIfSameRepo(input.cwd, repo, run);
    if (localBase) {
      if (!isSafeBranch(localBase)) {
        return { ok: false, blockers: [blocker("invalid-branch", "base branch is not a safe git ref")] };
      }
      return { ok: true, repo, baseBranch: localBase, workingBranch, inferred: false };
    }
    const remoteHead = await discoverRemoteHead(repo, run);
    if (remoteHead) {
      if (!isSafeBranch(remoteHead)) {
        return { ok: false, blockers: [blocker("invalid-branch", "remote HEAD is not a safe git ref")] };
      }
      return { ok: true, repo, baseBranch: remoteHead, workingBranch, inferred: false };
    }
    return {
      ok: false,
      blockers: [
        blocker(
          "missing-base-branch",
          "could not use the current local branch or discover remote HEAD; pass --branch",
        ),
      ],
    };
  }
  if (!input.cwd) {
    return {
      ok: false,
      blockers: [blocker("missing-origin", "no --repo given and no local workspace to infer origin from")],
    };
  }
  const origin = await run(["git", "-C", input.cwd, "remote", "get-url", "origin"]);
  if (origin.code !== 0 || !origin.stdout.trim()) {
    return {
      ok: false,
      blockers: [blocker("missing-origin", "local workspace has no usable git origin; pass --repo or add a remote")],
    };
  }
  const repo = origin.stdout.trim();
  if (!isSafeRepo(repo)) {
    return { ok: false, blockers: [blocker("invalid-repo", "inferred origin is not a safe git URL")] };
  }
  const dirty = await run(["git", "-C", input.cwd, "status", "--porcelain"]);
  if (dirty.code === 0 && dirty.stdout.trim()) {
    return {
      ok: false,
      blockers: [
        blocker(
          "dirty-worktree",
          "Local uncommitted changes are not on the VM; commit/push or choose another repo",
        ),
      ],
    };
  }
  const upstream = await run([
    "git",
    "-C",
    input.cwd,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstream.code !== 0) {
    return {
      ok: false,
      blockers: [blocker("unpushed-branch", "local branch has no pushed upstream; commit/push or pass --repo")],
    };
  }
  const ahead = await run(["git", "-C", input.cwd, "rev-list", "--count", "@{upstream}..HEAD"]);
  if (ahead.code === 0 && Number(ahead.stdout.trim()) > 0) {
    return {
      ok: false,
      blockers: [blocker("unpushed-branch", "local commits are not on the VM; push or choose another repo")],
    };
  }
  const current =
    input.branch ??
    (await run(["git", "-C", input.cwd, "branch", "--show-current"])).stdout.trim() ??
    "";
  if (!current) {
    return { ok: false, blockers: [blocker("missing-base-branch", "could not infer a base branch; pass --branch")] };
  }
  if (!isSafeBranch(current)) {
    return { ok: false, blockers: [blocker("invalid-branch", "base branch is not a safe git ref")] };
  }
  return { ok: true, repo: normalizeRepo(repo), baseBranch: current, workingBranch, inferred: true };
}

function looksLikeInjection(value: string): boolean {
  return /[;|&$`<>\\\n\r\t*(){}[\]!]/.test(value) || value.includes("$(");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function blocker(code: RemoteBlockerCode, message: string): RemoteBlocker {
  return { code, message };
}

function validateHost(host: RemoteHost): RemoteBlocker | undefined {
  if (!isSafeSessionId(host.id)) return blocker("invalid-host", "host id is not a safe token");
  if (!isSafeHostAddress(host.address)) return blocker("invalid-host", "host address is not a safe token");
  if (!isSafeUser(host.user)) return blocker("invalid-host", "host user is not a safe token");
  return undefined;
}

function validateIdentity(identityFile?: string): RemoteBlocker | undefined {
  if (!identityFile) return undefined;
  if (identityFile.includes("\n") || identityFile.includes("\0") || looksLikeInjection(identityFile)) {
    return blocker("invalid-host", "identity file path is not a safe token");
  }
  return undefined;
}

function requirePinned(pins: Map<string, PinnedHost>, pinned: PinnedHost): RemoteBlocker | undefined {
  const hostError = validateHost(pinned.host);
  if (hostError) return hostError;
  const known = pins.get(pinned.host.id);
  if (!known || known.knownHostsPath !== pinned.knownHostsPath) {
    return blocker("unpinned-host", "pin the guest sshd host key from cloud-init console-history before SSH");
  }
  if (known.source !== REQUIRED_HOST_KEY_SOURCE) {
    return blocker("untrusted-host-key-source", "pinned host key source is not cloud-init console-history");
  }
  return undefined;
}

function defaultRandomId(): string {
  return randomBytes(6).toString("hex");
}

function isArm64(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === "aarch64" || value === "arm64";
}

function remotePaths(host: RemoteHost, sessionId: string) {
  const session = `/home/${host.user}/${REMOTE_ROOT_SEGMENT}/sessions/${sessionId}`;
  return {
    session,
    work: `${session}/work`,
    lock: `${session}/.startlock`,
    boot: `${session}/boot_id`,
  };
}

function sessionDirFrom(record: SessionRecord): string {
  return record.remotePath.endsWith("/work") ? record.remotePath.slice(0, -"/work".length) : record.remotePath;
}

function skeletonRecord(host: RemoteHost, sessionId: string): SessionRecord {
  return {
    id: sessionId,
    hostId: host.id,
    repo: "",
    baseBranch: "",
    workingBranch: workingBranchFor(sessionId),
    tmuxSession: tmuxSessionFor(sessionId),
    remotePath: remotePaths(host, sessionId).work,
    piSession: sessionId,
    status: "unknown",
    worktreesOwnedBy: WORKTREES_OWNED_BY,
  };
}

async function runSecureSsh(
  run: CommandRunner,
  input: {
    host: RemoteHost;
    knownHostsPath: string;
    identityFile?: string;
    command: readonly string[];
  },
): Promise<CommandResult> {
  const argv = buildSshArgv({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    identityFile: input.identityFile,
    command: input.command,
  });
  if (!sshArgvIsSecure(argv) || looksLikeSecretTransfer(argv)) {
    return { code: 1, stdout: "", stderr: "refusing insecure SSH argv" };
  }
  return await run(argv);
}

async function ensureRemoteRepo(
  ssh: (command: readonly string[]) => Promise<CommandResult>,
  record: SessionRecord,
): Promise<{ ok: true } | { ok: false; blockers: RemoteBlocker[] }> {
  const existing = await ssh(["git", "-C", record.remotePath, "rev-parse", "--is-inside-work-tree"]);
  if (existing.code !== 0) {
    const cloned = await ssh(["git", "clone", "--branch", record.baseBranch, record.repo, record.remotePath]);
    if (cloned.code !== 0) {
      return {
        ok: false,
        blockers: [
          blocker(
            "missing-base-branch",
            cloned.stderr.trim() || `missing or unpushed base branch ${record.baseBranch}`,
          ),
        ],
      };
    }
  }
  const existingBranch = await ssh([
    "git",
    "-C",
    record.remotePath,
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${record.workingBranch}`,
  ]);
  const switched =
    existingBranch.code === 0
      ? await ssh(["git", "-C", record.remotePath, "checkout", record.workingBranch])
      : await ssh(["git", "-C", record.remotePath, "checkout", "-b", record.workingBranch]);
  if (switched.code !== 0) {
    return {
      ok: false,
      blockers: [blocker("invalid-branch", switched.stderr.trim() || "could not create isolated session branch")],
    };
  }
  return { ok: true };
}

async function ensureRemoteTools(
  ssh: (command: readonly string[]) => Promise<CommandResult>,
): Promise<{ ok: true } | { ok: false; blockers: RemoteBlocker[] }> {
  const node = await ssh(["node", "-p", "process.versions.node"]);
  if (node.code !== 0 || !node.stdout.trim()) {
    return {
      ok: false,
      blockers: [blocker("missing-tool", "remote node is missing; install Node.js >= 22.19 on the VM")],
    };
  }
  if (!nodeVersionAtLeast(node.stdout, MIN_REMOTE_NODE)) {
    return {
      ok: false,
      blockers: [
        blocker(
          "missing-tool",
          `remote node is ${node.stdout.trim()}; Node.js >= ${MIN_REMOTE_NODE} is required`,
        ),
      ],
    };
  }
  const git = await ssh(["git", "--version"]);
  if (git.code !== 0) {
    return { ok: false, blockers: [blocker("missing-tool", "remote git is missing; install git on the VM")] };
  }
  const tmux = await ssh(["tmux", "-V"]);
  if (tmux.code !== 0) {
    return { ok: false, blockers: [blocker("missing-tool", "remote tmux is missing; install tmux on the VM")] };
  }
  const pi = await ssh(["pi", "--version"]);
  if (pi.code !== 0) {
    return { ok: false, blockers: [blocker("missing-tool", "remote pi is missing; install Pi on the VM")] };
  }
  return { ok: true };
}

async function localBranchIfSameRepo(
  cwd: string | undefined,
  repo: string,
  run: CommandRunner,
): Promise<string | undefined> {
  if (!cwd) return undefined;
  const origin = await run(["git", "-C", cwd, "remote", "get-url", "origin"]);
  if (origin.code !== 0 || !origin.stdout.trim() || !sameRepo(origin.stdout.trim(), repo)) return undefined;
  const current = (await run(["git", "-C", cwd, "branch", "--show-current"])).stdout.trim();
  return current || undefined;
}

async function discoverRemoteHead(repo: string, run: CommandRunner): Promise<string | undefined> {
  const listed = await run(["git", "ls-remote", "--symref", repo, "HEAD"]);
  if (listed.code !== 0) return undefined;
  const match = /^ref:\s+refs\/heads\/(\S+)/m.exec(listed.stdout);
  return match?.[1];
}

async function inspectRemote(
  ssh: (command: readonly string[]) => Promise<CommandResult>,
  record: SessionRecord,
): Promise<{
  reachable: boolean;
  tmuxAlive?: boolean;
  bootId?: string;
  sessionDir?: boolean;
  status: SessionStatus;
  blockers: RemoteBlocker[];
}> {
  const boot = await ssh(["cat", "/proc/sys/kernel/random/boot_id"]);
  if (boot.code !== 0) {
    return {
      reachable: false,
      status: "unreachable",
      blockers: [classifySshFailure(boot)],
    };
  }
  const tmux = await ssh(["tmux", "has-session", "-t", record.tmuxSession]);
  const dir = await ssh(["test", "-d", sessionDirFrom(record)]);
  const sessionDir = dir.code === 0;
  const tmuxAlive = tmux.code === 0;
  const bootId = boot.stdout.trim();
  return {
    reachable: true,
    tmuxAlive,
    bootId,
    sessionDir,
    status: classifyRemotePresence({
      registry: record,
      reachable: true,
      tmuxAlive,
      bootId,
      sessionDir,
    }),
    blockers: [],
  };
}

function sshBlocked(result: CommandResult, session: SessionRecord): StartResult {
  return { status: "blocked", blockers: [classifySshFailure(result)], session };
}

async function spawnInteractive(argv: readonly string[]): Promise<{ code: number; stderr: string }> {
  if (argv.length === 0) return { code: 1, stderr: "empty argv" };
  const [command, ...args] = argv;
  return await new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: "inherit" });
    child.on("error", (error: Error) => {
      resolve({ code: 255, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 255, stderr: "" });
    });
  });
}
