import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GUEST_SSH_HOST_FINGERPRINT_SOURCE,
  type CommandResult,
  type CommandRunner,
} from "../src/oci.ts";
import {
  buildSshArgv,
  createMemoryRegistry,
  createRemoteTransport,
  looksLikeSecretTransfer,
  posixQuote,
  remoteArgv,
  sshArgvIsSecure,
  tmuxSessionFor,
  workingBranchFor,
  type RemoteHost,
  type SessionRecord,
} from "../src/remote.ts";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPiCloudGuestSshdKeyFixture000001 ubuntu@instance";
const CLOUD_INIT_SOURCE = "authenticated OCI cloud-init console-history";
const SERIAL_SOURCE = "oci instance-console-connection serial-console";
const PUBLIC_IP = "203.0.113.10";
const TAILNET = "pi-cloud.tailnet.ts.net";
const REPO = "https://github.com/acme/proj.git";

function host(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: "vm-1",
    address: PUBLIC_IP,
    user: "ubuntu",
    expectedHostKey: HOST_KEY,
    ...overrides,
  };
}

function ok(stdout = "", stderr = ""): CommandResult {
  return { code: 0, stdout, stderr };
}

function fail(stderr: string, code = 1): CommandResult {
  return { code, stdout: "", stderr };
}

type RemoteState = {
  arch: string;
  bootId: string;
  tmux: Set<string>;
  dirs: Set<string>;
  locks: Set<string>;
  repos: Set<string>;
  branches: Map<string, string>;
  sshError?: CommandResult;
};

function createRemoteState(overrides: Partial<RemoteState> = {}): RemoteState {
  return {
    arch: "aarch64",
    bootId: "boot-aaa",
    tmux: new Set(),
    dirs: new Set(),
    locks: new Set(),
    repos: new Set(),
    branches: new Map(),
    ...overrides,
  };
}

function hasDir(state: RemoteState, path: string): boolean {
  return state.dirs.has(path) || [...state.dirs].some((entry) => entry.startsWith(`${path}/`));
}

function handleRemote(state: RemoteState, command: readonly string[]): CommandResult {
  if (command[0] === "uname" && command[1] === "-m") return ok(`${state.arch}\n`);
  if (command[0] === "cat" && command[1] === "/proc/sys/kernel/random/boot_id") return ok(`${state.bootId}\n`);
  if (command[0] === "cp") {
    if (command[2]) state.dirs.add(command[2]);
    return ok();
  }
  if (command[0] === "mkdir" && command[1] === "-p" && command[2]) {
    state.dirs.add(command[2]);
    return ok();
  }
  if (command[0] === "mkdir" && command[1]) {
    if (state.locks.has(command[1]) || hasDir(state, command[1])) return fail("File exists");
    state.locks.add(command[1]);
    state.dirs.add(command[1]);
    return ok();
  }
  if (command[0] === "rmdir" && command[1]) {
    state.locks.delete(command[1]);
    state.dirs.delete(command[1]);
    return ok();
  }
  if (command[0] === "test" && command[1] === "-d") return hasDir(state, command[2] ?? "") ? ok() : fail("missing");
  if (command[0] === "tmux" && command[1] === "has-session") {
    return state.tmux.has(command[3] ?? "") ? ok() : fail("no session");
  }
  if (command[0] === "tmux" && command[1] === "new-session") {
    const nameIndex = command.indexOf("-s");
    const name = nameIndex >= 0 ? command[nameIndex + 1] : "";
    if (!name) return fail("missing session name");
    if (state.tmux.has(name)) return fail("duplicate session");
    state.tmux.add(name);
    return ok();
  }
  if (command[0] === "tmux" && command[1] === "attach-session") {
    return state.tmux.has(command[3] ?? "") ? ok() : fail("no session");
  }
  if (command[0] === "git" && command[1] === "clone") {
    const dest = command[5];
    if (!dest) return fail("missing dest");
    state.repos.add(dest);
    state.dirs.add(dest);
    state.branches.set(dest, command[3] ?? "");
    return ok();
  }
  if (command[0] === "git" && command[1] === "-C" && command[3] === "rev-parse") {
    return state.repos.has(command[2] ?? "") ? ok("true\n") : fail("not a git repo");
  }
  if (command[0] === "git" && command[1] === "-C" && command[3] === "checkout") {
    if (!state.repos.has(command[2] ?? "")) return fail("not a git repo");
    state.branches.set(command[2] ?? "", command[5] ?? "");
    return ok();
  }
  return fail(`unexpected remote: ${command.join(" ")}`);
}

type LocalGit = {
  origin?: string;
  branch?: string;
  dirty?: string;
  upstream?: string;
  ahead?: string;
};

function handleLocalGit(cwd: string, git: LocalGit, argv: readonly string[]): CommandResult | undefined {
  if (argv[0] !== "git" || argv[1] !== "-C" || argv[2] !== cwd) return undefined;
  const rest = argv.slice(3);
  if (rest[0] === "remote" && rest[1] === "get-url") {
    return git.origin ? ok(`${git.origin}\n`) : fail("no origin");
  }
  if (rest.join(" ") === "status --porcelain") return ok(git.dirty ?? "");
  if (rest.join(" ") === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
    return git.upstream ? ok(`${git.upstream}\n`) : fail("no upstream", 128);
  }
  if (rest.join(" ") === "rev-list --count @{upstream}..HEAD") return ok(`${git.ahead ?? "0"}\n`);
  if (rest.join(" ") === "branch --show-current") return git.branch ? ok(`${git.branch}\n`) : fail("detached");
  return fail(`unexpected git: ${rest.join(" ")}`);
}

async function setup(options: {
  state?: RemoteState;
  git?: LocalGit;
  cwd?: string;
  registry?: ReturnType<typeof createMemoryRegistry>;
  beforeRemote?: (command: readonly string[], argv: readonly string[]) => Promise<void> | void;
} = {}) {
  const knownHostsDir = await mkdtemp(join(tmpdir(), "pi-remote-"));
  const state = options.state ?? createRemoteState();
  const log: string[][] = [];
  const run: CommandRunner = async (argv) => {
    log.push([...argv]);
    if (options.cwd && options.git) {
      const local = handleLocalGit(options.cwd, options.git, argv);
      if (local) return local;
    }
    assert.equal(argv[0], "ssh", `local fallback forbidden: ${argv.join(" ")}`);
    assert.equal(sshArgvIsSecure(argv), true, argv.join(" "));
    assert.equal(looksLikeSecretTransfer(argv), false, argv.join(" "));
    assert.equal(argv.includes("accept-new"), false);
    const command = remoteArgv(argv);
    if (options.beforeRemote) await options.beforeRemote(command, argv);
    if (state.sshError) return state.sshError;
    return handleRemote(state, command);
  };
  const transport = createRemoteTransport({
    run,
    attach: async (argv) => {
      log.push([...argv]);
      assert.equal(sshArgvIsSecure(argv), true);
      assert.equal(argv.includes("send-keys"), false);
      const command = remoteArgv(argv);
      if (state.sshError) return { code: state.sshError.code, stderr: state.sshError.stderr };
      const result = handleRemote(state, command);
      return { code: result.code, stderr: result.stderr };
    },
    knownHostsDir,
    registry: options.registry,
  });
  return { transport, state, log, knownHostsDir };
}

async function pinOk(
  transport: ReturnType<typeof createRemoteTransport>,
  overrides: Partial<RemoteHost> = {},
  aliases: string[] = [TAILNET],
) {
  const result = await transport.pinHostKey({
    host: host(overrides),
    source: CLOUD_INIT_SOURCE,
    aliases,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("pin failed");
  return result.pinned;
}

test("pins guest sshd key from cloud-init console-history onto public IP and tailnet aliases", async () => {
  const { transport, log, knownHostsDir } = await setup();
  const pinned = await pinOk(transport);
  assert.equal(pinned.source, GUEST_SSH_HOST_FINGERPRINT_SOURCE);
  const body = await readFile(join(knownHostsDir, "vm-1.known_hosts"), "utf8");
  assert.match(body, new RegExp(PUBLIC_IP));
  assert.match(body, new RegExp(TAILNET.replaceAll(".", "\\.")));
  assert.match(body, /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPiCloudGuestSshdKeyFixture000001/);
  assert.equal(log.length, 0);
});

test("refuses serial-console service keys and never SSHes", async () => {
  const { transport, log } = await setup();
  const refused = await transport.pinHostKey({
    host: host(),
    source: SERIAL_SOURCE,
    aliases: [TAILNET],
  });
  assert.equal(refused.ok, false);
  if (refused.ok) throw new Error("expected refusal");
  assert.equal(refused.blockers[0]?.code, "untrusted-host-key-source");
  const started = await transport.start({
    pinned: {
      host: host(),
      knownHostsPath: "/tmp/forged.known_hosts",
      aliases: [PUBLIC_IP],
      source: GUEST_SSH_HOST_FINGERPRINT_SOURCE,
    },
    repo: "acme/proj",
    branch: "main",
    sessionId: "s1",
  });
  assert.equal(started.status, "blocked");
  assert.equal(started.status === "blocked" && started.blockers[0]?.code, "unpinned-host");
  assert.equal(log.length, 0);
});

test("rejects injection in host, repo, and branch and keeps SSH on argv", async () => {
  const { transport, log } = await setup();
  const injectedHost = await transport.pinHostKey({
    host: host({ address: "203.0.113.10;cat /etc/passwd" }),
    source: CLOUD_INIT_SOURCE,
  });
  assert.equal(injectedHost.ok, false);
  if (!injectedHost.ok) assert.equal(injectedHost.blockers[0]?.code, "invalid-host");

  const pinned = await pinOk(transport);
  const injectedRepo = await transport.start({
    pinned,
    repo: "acme/proj;curl evil.example",
    branch: "main",
    sessionId: "s1",
  });
  assert.equal(injectedRepo.status, "blocked");
  assert.equal(injectedRepo.status === "blocked" && injectedRepo.blockers[0]?.code, "invalid-repo");

  const injectedBranch = await transport.start({
    pinned,
    repo: "acme/proj",
    branch: "main;reboot",
    sessionId: "s1",
  });
  assert.equal(injectedBranch.status, "blocked");
  assert.equal(injectedBranch.status === "blocked" && injectedBranch.blockers[0]?.code, "invalid-branch");

  const started = await transport.start({
    pinned,
    repo: "acme/proj",
    branch: "main",
    sessionId: "sess01",
  });
  assert.equal(started.status, "started");
  assert.equal(log.some((argv) => argv[0] === "sh" || argv[0] === "bash" || argv.includes("-c") && argv[0] !== "ssh"), false);
  assert.equal(
    log.every((argv) => argv[0] !== "ssh" || sshArgvIsSecure(argv)),
    true,
  );
  assert.equal(
    posixQuote("it's; rm -rf /"),
    `'it'\\''s; rm -rf /'`,
  );
  const sample = buildSshArgv({
    host: host(),
    knownHostsPath: pinned.knownHostsPath,
    command: ["tmux", "has-session", "-t", "pi-sess01"],
  });
  assert.deepEqual(remoteArgv(sample), ["tmux", "has-session", "-t", "pi-sess01"]);
  assert.equal(sample.includes("accept-new"), false);
});

test("host key mismatch blocks and never retries with accept-new", async () => {
  const state = createRemoteState({
    sshError: fail("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED\nHost key verification failed.", 255),
  });
  const { transport, log } = await setup({ state });
  const pinned = await pinOk(transport);
  const started = await transport.start({
    pinned,
    repo: "acme/proj",
    branch: "main",
    sessionId: "s1",
  });
  assert.equal(started.status, "blocked");
  assert.equal(started.status === "blocked" && started.blockers[0]?.code, "host-key-mismatch");
  assert.equal(log.some((argv) => argv.some((part) => part.includes("accept-new"))), false);
  assert.equal(log.some((argv) => argv[0] === "pi" || argv[0] === "tmux"), false);
});

test("concurrent starts take the atomic lock instead of duplicating the parent", async () => {
  let unameCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { transport } = await setup({
    beforeRemote: async (command) => {
      if (command[0] === "uname") {
        unameCalls += 1;
        if (unameCalls === 1) await gate;
      }
    },
  });
  const pinned = await pinOk(transport);
  const first = transport.start({ pinned, repo: "acme/proj", branch: "main", sessionId: "same" });
  while (unameCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  const second = await transport.start({ pinned, repo: "acme/proj", branch: "main", sessionId: "same" });
  assert.equal(second.status, "blocked");
  assert.equal(second.status === "blocked" && second.blockers[0]?.code, "concurrent-start");
  release?.();
  const started = await first;
  assert.equal(started.status, "started");
  if (started.status === "started") {
    assert.equal(started.session.tmuxSession, tmuxSessionFor("same"));
    assert.equal(started.session.workingBranch, workingBranchFor("same"));
    assert.equal(started.session.worktreesOwnedBy, "subagents");
  }

  const leftover = createRemoteState();
  leftover.locks.add("/home/ubuntu/pi-cloud/sessions/locked/.startlock");
  leftover.dirs.add("/home/ubuntu/pi-cloud/sessions/locked");
  leftover.dirs.add("/home/ubuntu/pi-cloud/sessions/locked/.startlock");
  const again = await setup({ state: leftover });
  const pinnedAgain = await pinOk(again.transport);
  const locked = await again.transport.start({
    pinned: pinnedAgain,
    repo: "acme/proj",
    branch: "main",
    sessionId: "locked",
  });
  assert.equal(locked.status, "blocked");
  assert.equal(locked.status === "blocked" && locked.blockers[0]?.code, "concurrent-start");
});

test("stale registry and reboot/exit stay unknown rather than idle", async () => {
  const registry = createMemoryRegistry();
  const staleRecord: SessionRecord = {
    id: "stale1",
    hostId: "vm-1",
    repo: REPO,
    baseBranch: "main",
    workingBranch: workingBranchFor("stale1"),
    tmuxSession: tmuxSessionFor("stale1"),
    remotePath: "/home/ubuntu/pi-cloud/sessions/stale1/work",
    piSession: "stale1",
    bootId: "boot-old",
    status: "running",
    worktreesOwnedBy: "subagents",
  };
  await registry.put(staleRecord);
  const { transport } = await setup({ registry, state: createRemoteState({ bootId: "boot-old" }) });
  const pinned = await pinOk(transport);
  const stale = await transport.inspect({ pinned, sessionId: "stale1" });
  assert.equal(stale.session?.status, "stale");
  assert.equal(stale.connection, "ok");

  const live = createRemoteState({ bootId: "boot-new" });
  live.dirs.add("/home/ubuntu/pi-cloud/sessions/stale1");
  const rebootedSetup = await setup({
    state: live,
    registry: createMemoryRegistry([staleRecord]),
  });
  const rebootedPin = await pinOk(rebootedSetup.transport);
  const rebooted = await rebootedSetup.transport.inspect({ pinned: rebootedPin, sessionId: "stale1" });
  assert.equal(rebooted.session?.status, "rebooted");

  const exitedState = createRemoteState({ bootId: "boot-old" });
  exitedState.dirs.add("/home/ubuntu/pi-cloud/sessions/stale1");
  const exitedSetup = await setup({
    state: exitedState,
    registry: createMemoryRegistry([staleRecord]),
  });
  const exitedPin = await pinOk(exitedSetup.transport);
  const exited = await exitedSetup.transport.inspect({ pinned: exitedPin, sessionId: "stale1" });
  assert.equal(exited.session?.status, "exited");
});

test("SSH failure is unreachable and does not fall back to local tools", async () => {
  const state = createRemoteState({
    sshError: fail("ssh: connect to host 203.0.113.10 port 22: Connection refused", 255),
  });
  const { transport, log } = await setup({ state });
  const pinned = await pinOk(transport);
  const started = await transport.start({
    pinned,
    repo: "acme/proj",
    branch: "main",
    sessionId: "s1",
  });
  assert.equal(started.status, "blocked");
  assert.equal(started.status === "blocked" && started.blockers[0]?.code, "unreachable");
  assert.equal(log.some((argv) => argv[0] === "pi" || argv[0] === "tmux" || argv[0] === "scp"), false);
  assert.equal(log.every((argv) => argv[0] === "ssh"), true);
});

test("repo and branch selection infers origin, rejects dirty/unpushed, and isolates session branch", async () => {
  const cwd = "/tmp/local-proj";
  const dirty = await setup({
    cwd,
    git: { origin: REPO, branch: "main", dirty: " M README.md", upstream: "origin/main", ahead: "0" },
  });
  const dirtyPick = await dirty.transport.selectRepo({ cwd, sessionId: "s1" });
  assert.equal(dirtyPick.ok, false);
  if (!dirtyPick.ok) assert.equal(dirtyPick.blockers[0]?.code, "dirty-worktree");

  const unpushed = await setup({
    cwd,
    git: { origin: REPO, branch: "main", upstream: "origin/main", ahead: "2" },
  });
  const unpushedPick = await unpushed.transport.selectRepo({ cwd, sessionId: "s1" });
  assert.equal(unpushedPick.ok, false);
  if (!unpushedPick.ok) assert.equal(unpushedPick.blockers[0]?.code, "unpushed-branch");

  const clean = await setup({
    cwd,
    git: { origin: REPO, branch: "topic", upstream: "origin/topic", ahead: "0" },
  });
  const inferred = await clean.transport.selectRepo({ cwd, sessionId: "sess01" });
  assert.equal(inferred.ok, true);
  if (inferred.ok) {
    assert.equal(inferred.repo, REPO);
    assert.equal(inferred.baseBranch, "topic");
    assert.equal(inferred.workingBranch, "pi/sess01");
    assert.equal(inferred.inferred, true);
  }

  const explicit = await setup({
    cwd,
    git: { origin: REPO, branch: "topic", dirty: " M local-only", upstream: "origin/topic", ahead: "9" },
  });
  const overridden = await explicit.transport.selectRepo({
    cwd,
    repo: "acme/other",
    branch: "release",
    sessionId: "sess01",
  });
  assert.equal(overridden.ok, true);
  if (overridden.ok) {
    assert.equal(overridden.repo, "https://github.com/acme/other.git");
    assert.equal(overridden.baseBranch, "release");
    assert.equal(overridden.workingBranch, "pi/sess01");
    assert.equal(overridden.inferred, false);
  }

  const { transport, state } = await setup();
  const pinned = await pinOk(transport);
  const started = await transport.start({
    pinned,
    repo: "acme/proj",
    branch: "main",
    sessionId: "sess01",
  });
  assert.equal(started.status, "started");
  if (started.status === "started") {
    assert.equal(started.session.baseBranch, "main");
    assert.equal(started.session.workingBranch, "pi/sess01");
    assert.notEqual(started.session.workingBranch, started.session.baseBranch);
    assert.equal(state.branches.get(started.session.remotePath), "pi/sess01");
    assert.equal(started.session.piSession, "sess01");
  }
});

test("attach uses interactive tmux attach, treats detach as still-running, and does not replay prompts", async () => {
  const { transport, state, log } = await setup();
  const pinned = await pinOk(transport);
  const started = await transport.start({
    pinned,
    repo: "acme/proj",
    branch: "main",
    sessionId: "sess01",
  });
  assert.equal(started.status, "started");
  const attached = await transport.attach({ pinned, sessionId: "sess01" });
  assert.equal(attached.status, "detached");
  assert.equal(attached.session?.status, "detached");
  assert.equal(
    log.some((argv) => argv[0] === "ssh" && remoteArgv(argv)[0] === "tmux" && remoteArgv(argv)[1] === "attach-session"),
    true,
  );
  assert.equal(log.some((argv) => argv.includes("send-keys")), false);

  state.tmux.delete(tmuxSessionFor("sess01"));
  const afterExit = await transport.attach({ pinned, sessionId: "sess01" });
  assert.equal(afterExit.status, "exited");
});
