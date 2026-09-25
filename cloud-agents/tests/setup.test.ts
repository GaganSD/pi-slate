import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  A1_MEMORY_GB,
  A1_OCPUS,
  A1_SHAPE,
  createOciProvider,
  DEFAULT_DISPLAY_NAME,
  isMutatingArgv,
  MANAGED_BY,
  OCI_AUTH,
  OCI_PROFILE,
  spawnCommand,
  type CommandResult,
  type CommandRunner,
} from "../src/oci.ts";
import {
  createMemoryRegistry,
  createRemoteTransport,
  looksLikeSecretTransfer,
  remoteArgv,
  sshArgvIsSecure,
} from "../src/remote.ts";
import { identityPath, loadState, saveState, setupLockPath, acquireExclusiveLock } from "../src/state.ts";
import { formatCreateConfirmation, formatStartupFailure, resolveCloudRun, runCloudStartup, type CloudUi } from "../src/setup.ts";
import { CLOUD_INIT_CONSOLE } from "./fixtures.ts";

const TENANCY = "ocid1.tenancy.oc1..aaaa";
const OCI_CONFIG = join(mkdtempSync(join(tmpdir(), "pi-cloud-setup-oci-")), "config");
writeFileSync(
  OCI_CONFIG,
  `[PI_CLOUD]\ntenancy=${TENANCY}\nregion=eu-frankfurt-1\nsecurity_token_file=/tmp/not-read\n`,
);

function mockedOciProvider(options: { run: CommandRunner }) {
  return createOciProvider({ configFile: OCI_CONFIG, run: options.run });
}

const HOME = "eu-frankfurt-1";
const AD = "eu-frankfurt-1-ad-1";
const IMAGE = "ocid1.image.oc1..ubuntu";
const SSH_CIDR = "203.0.113.10/32";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPiCloudGuestSshdKeyFixture000001";
const PUBLIC_IP = "203.0.113.10";
const INSTANCE_ID = "ocid1.instance.oc1..adoptme";

type Parsed = { tokens: string[]; flags: Record<string, string[]> };
type Handlers = Record<string, (parsed: Parsed) => CommandResult | Promise<CommandResult>>;

function parseArgv(argv: readonly string[]): Parsed {
  const tokens: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (i === 0) continue;
    if (part.startsWith("--")) {
      const key = part.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      flags[key] = [...(flags[key] ?? []), value];
      continue;
    }
    tokens.push(part);
  }
  return { tokens, flags };
}

function ok(data: unknown): CommandResult {
  return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
}

function fail(message: string): CommandResult {
  return { code: 1, stdout: "", stderr: message };
}

function regionSubscriptions(): CommandResult {
  return ok([{ "is-home-region": true, "region-name": HOME }]);
}

function liveManaged(): Record<string, unknown> {
  return {
    id: INSTANCE_ID,
    "display-name": DEFAULT_DISPLAY_NAME,
    shape: A1_SHAPE,
    "shape-config": { ocpus: A1_OCPUS, "memory-in-gbs": A1_MEMORY_GB },
    "lifecycle-state": "RUNNING",
    "availability-domain": AD,
    "compartment-id": TENANCY,
    "freeform-tags": { "managed-by": MANAGED_BY },
  };
}

function baseOciHandlers(overrides: Handlers = {}): Handlers {
  return {
    "iam region-subscription list": () => regionSubscriptions(),
    "osp-gateway subscription-service subscription list": () => ok({ items: [{ id: "sub-1", "plan-type": "FREE_TIER" }] }),
    "iam compartment list": () =>
      ok([
        {
          id: TENANCY,
          name: "root",
          "lifecycle-state": "ACTIVE",
          "compartment-id": null,
        },
      ]),
    "iam availability-domain list": () => ok([{ name: AD }]),
    "compute instance list": () => ok([]),
    "bv boot-volume list": () => ok([]),
    "bv volume list": () => ok([]),
    "compute boot-volume-attachment list": () => ok([]),
    "compute image list": () =>
      ok([
        {
          id: IMAGE,
          "operating-system": "Canonical Ubuntu",
          "display-name": "Canonical-Ubuntu-22.04",
          "compartment-id": null,
          "lifecycle-state": "AVAILABLE",
        },
      ]),
    "network vcn list": () => ok([]),
    "network internet-gateway list": () => ok([]),
    "network security-list list": () => ok([]),
    "network nsg list": () => ok([]),
    "network nsg rules list": () => ok([]),
    "network subnet list": () => ok([]),
    "network vcn get": () => ok({ id: "ocid1.vcn.oc1..vcn", "default-route-table-id": "ocid1.routetable.oc1..rt" }),
    "network vcn create": () => ok({ id: "ocid1.vcn.oc1..vcn" }),
    "network internet-gateway create": () => ok({ id: "ocid1.internetgateway.oc1..igw" }),
    "network route-table update": () => ok({ id: "ocid1.routetable.oc1..rt" }),
    "network security-list create": () => ok({ id: "ocid1.securitylist.oc1..sl" }),
    "network nsg create": () => ok({ id: "ocid1.networksecuritygroup.oc1..nsg" }),
    "network nsg rules add": () => ok([]),
    "network subnet create": () => ok({ id: "ocid1.subnet.oc1..subnet" }),
    "compute instance launch": () =>
      ok({
        id: "ocid1.instance.oc1..created",
        "display-name": DEFAULT_DISPLAY_NAME,
        shape: A1_SHAPE,
        "shape-config": { ocpus: A1_OCPUS, "memory-in-gbs": A1_MEMORY_GB },
        "lifecycle-state": "RUNNING",
        "availability-domain": AD,
        "compartment-id": TENANCY,
        "freeform-tags": { "managed-by": MANAGED_BY },
      }),
    "compute instance list-vnics": () => ok([{ "public-ip": PUBLIC_IP, "is-primary": true }]),
    "compute instance get": () => ok({ id: INSTANCE_ID, "image-id": IMAGE }),
    "compute image get": () => ok({ id: IMAGE, "operating-system": "Canonical Ubuntu" }),
    "compute console-history list": () =>
      ok([{ id: "ocid1.consolehistory.oc1..ch", "lifecycle-state": "SUCCEEDED" }]),
    "compute console-history get-content": async (parsed) => {
      const file = parsed.flags.file?.[0];
      if (!file) return fail("missing --file");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, CLOUD_INIT_CONSOLE);
      return { code: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  };
}

type RemoteState = {
  arch: string;
  bootId: string;
  nodeVersion: string;
  tmux: Set<string>;
  dirs: Set<string>;
  locks: Set<string>;
  repos: Set<string>;
  branches: Map<string, string>;
  branchNames: Map<string, Set<string>>;
};

function handleRemote(state: RemoteState, command: readonly string[]): CommandResult {
  if (command[0] === "uname" && command[1] === "-m") return { code: 0, stdout: `${state.arch}\n`, stderr: "" };
  if (command[0] === "node" && command[1] === "-p") {
    return { code: 0, stdout: `${state.nodeVersion}\n`, stderr: "" };
  }
  if (command[0] === "git" && command[1] === "--version") return { code: 0, stdout: "git version 2.43.0\n", stderr: "" };
  if (command[0] === "tmux" && command[1] === "-V") return { code: 0, stdout: "tmux 3.4\n", stderr: "" };
  if (command[0] === "pi" && command[1] === "--version") return { code: 0, stdout: "0.85.1\n", stderr: "" };
  if (command[0] === "cat" && command[1] === "/proc/sys/kernel/random/boot_id") {
    return { code: 0, stdout: `${state.bootId}\n`, stderr: "" };
  }
  if (command[0] === "cp") return { code: 0, stdout: "", stderr: "" };
  if (command[0] === "mkdir" && command[1] === "-p" && command[2]) {
    state.dirs.add(command[2]);
    return { code: 0, stdout: "", stderr: "" };
  }
  if (command[0] === "mkdir" && command[1]) {
    if (state.locks.has(command[1])) return fail("File exists");
    state.locks.add(command[1]);
    return { code: 0, stdout: "", stderr: "" };
  }
  if (command[0] === "rmdir" && command[1]) {
    state.locks.delete(command[1]);
    return { code: 0, stdout: "", stderr: "" };
  }
  if (command[0] === "test" && command[1] === "-d") {
    return state.dirs.has(command[2] ?? "") ? { code: 0, stdout: "", stderr: "" } : fail("missing");
  }
  if (command[0] === "tmux" && command[1] === "has-session") {
    return state.tmux.has(command[3] ?? "") ? { code: 0, stdout: "", stderr: "" } : fail("no session");
  }
  if (command[0] === "tmux" && command[1] === "new-session") {
    const name = command[command.indexOf("-s") + 1];
    state.tmux.add(name);
    return { code: 0, stdout: "", stderr: "" };
  }
  if (command[0] === "git" && command[1] === "clone") {
    const dest = command[5];
    if (dest) {
      state.repos.add(dest);
      state.dirs.add(dest);
      state.branchNames.set(dest, new Set([command[3] ?? ""]));
      state.branches.set(dest, command[3] ?? "");
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  if (command[0] === "git" && command[3] === "rev-parse") {
    return state.repos.has(command[2] ?? "") ? { code: 0, stdout: "true\n", stderr: "" } : fail("not a git repo");
  }
  if (command[0] === "git" && command[3] === "show-ref") {
    const path = command[2] ?? "";
    const ref = command.at(-1) ?? "";
    const name = ref.replace(/^refs\/heads\//, "");
    return state.branchNames.get(path)?.has(name) ? { code: 0, stdout: "", stderr: "" } : fail("missing ref");
  }
  if (command[0] === "git" && command[3] === "checkout") {
    const path = command[2] ?? "";
    if (command[4] === "-B") return fail("refusing force-move checkout -B");
    if (command[4] === "-b") {
      const name = command[5] ?? "";
      const names = state.branchNames.get(path) ?? new Set<string>();
      names.add(name);
      state.branchNames.set(path, names);
      state.branches.set(path, name);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  return fail(`unexpected remote: ${command.join(" ")}`);
}

function emptyRemoteState(): RemoteState {
  return {
    arch: "aarch64",
    bootId: "boot-aaa",
    nodeVersion: "22.19.0",
    tmux: new Set(),
    dirs: new Set(),
    locks: new Set(),
    repos: new Set(),
    branches: new Map(),
    branchNames: new Map(),
  };
}

function mockUi(answers: { confirm?: boolean | boolean[]; input?: string[]; select?: string[] } = {}): CloudUi {
  const confirms = Array.isArray(answers.confirm) ? [...answers.confirm] : undefined;
  const inputs = [...(answers.input ?? [])];
  const selects = [...(answers.select ?? [])];
  return {
    async confirm() {
      if (confirms) return confirms.shift() ?? false;
      return answers.confirm === true;
    },
    async input() {
      return inputs.shift();
    },
    async select() {
      return selects.shift();
    },
    notify() {},
  };
}

async function seedIdentity(stateDir: string): Promise<void> {
  const key = identityPath(stateDir);
  await mkdir(dirname(key), { recursive: true });
  await writeFile(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n", { mode: 0o600 });
  await writeFile(`${key}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIlocalfixture pi-cloud\n");
}

async function harness(options: {
  oci?: Handlers;
  ui?: CloudUi;
  repo?: string;
  branch?: string;
  cwd?: string;
  stateDir?: string;
  hostKey?: string;
} = {}) {
  const stateDir = options.stateDir ?? (await mkdtemp(join(tmpdir(), "pi-cloud-state-")));
  const knownHostsDir = await mkdtemp(join(tmpdir(), "pi-cloud-kh-"));
  await seedIdentity(stateDir);
  const remoteState = emptyRemoteState();
  const log: string[][] = [];
  const ociHandlers = baseOciHandlers(options.oci);
  const run: CommandRunner = async (argv) => {
    log.push([...argv]);
    assert.equal(argv.includes("accept-new"), false, argv.join(" "));
    assert.equal(looksLikeSecretTransfer(argv), false, argv.join(" "));
    if (argv[0] === "ssh") {
      assert.equal(sshArgvIsSecure(argv), true, argv.join(" "));
      return handleRemote(remoteState, remoteArgv(argv));
    }
    assert.equal(argv[0], "oci");
    assert.equal(argv.includes(OCI_PROFILE), true);
    assert.equal(argv.includes(OCI_AUTH), true);
    const parsed = parseArgv(argv);
    const key = parsed.tokens.join(" ");
    const handler = ociHandlers[key];
    if (!handler) return fail(`unexpected command: ${key}`);
    return await handler(parsed);
  };
  const oci = mockedOciProvider({ run });
  const remote = createRemoteTransport({
    run,
    knownHostsDir,
    randomId: () => "sess01",
  });
  const outcome = await runCloudStartup({
    cwd: options.cwd ?? stateDir,
    repo: options.repo ?? "acme/proj",
    branch: options.branch ?? "main",
    ui: options.ui ?? mockUi({ confirm: true, input: [SSH_CIDR] }),
    runtime: { run, oci, remote, stateDir, knownHostsDir },
  });
  return { outcome, log, stateDir, remoteState };
}

test("unauthenticated account blocks without writes or SSH", async () => {
  const { outcome, log } = await harness({
    oci: {
      "iam region-subscription list": () => fail("NotAuthenticated"),
    },
    ui: mockUi({ confirm: false }),
  });
  assert.equal(outcome.status === "cancelled" || outcome.status === "blocked", true);
  assert.equal(log.some((argv) => argv[0] === "ssh"), false);
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
});

test("adopts an exact managed host, pins cloud-init key, then starts without create writes", async () => {
  const { outcome, log, stateDir } = await harness({
    oci: {
      "compute instance list": () => ok([liveManaged()]),
    },
    ui: mockUi({ confirm: true }),
  });
  assert.equal(outcome.status, "ready");
  if (outcome.status === "ready") {
    assert.equal(outcome.prepared.session.id, "sess01");
    assert.equal(outcome.prepared.session.workingBranch, "pi/sess01");
    assert.equal(outcome.prepared.pinned.host.expectedHostKey.startsWith(HOST_KEY), true);
  }
  assert.equal(log.some((argv) => argv.includes("instance") && argv.includes("launch")), false);
  assert.equal(log.some((argv) => argv[0] === "ssh"), true);
  const sshIndex = log.findIndex((argv) => argv[0] === "ssh");
  assert.equal(log.some((argv) => argv.includes("console-history")), true);
  assert.equal((await loadState(stateDir)).host?.expectedHostKey.startsWith(HOST_KEY), true);
  assert.equal(sshIndex > 0, true);
  assert.equal(
    log.slice(0, sshIndex).some((argv) => argv[0] === "ssh"),
    false,
  );
});

test("create stays unconfirmed and issues no writes", async () => {
  const { outcome, log } = await harness({
    ui: mockUi({ confirm: false, input: [SSH_CIDR] }),
  });
  assert.equal(outcome.status, "blocked");
  if (outcome.status === "blocked") {
    assert.equal(outcome.blockers.some((blocker) => blocker.code === "unconfirmed-write"), true);
  }
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
  assert.equal(log.some((argv) => argv[0] === "ssh"), false);
});

test("create with explicit confirmation uses provider guards and then pins before SSH", async () => {
  const { outcome, log } = await harness({
    ui: mockUi({ confirm: true, input: [SSH_CIDR] }),
    oci: {
      "compute instance list-vnics": () =>
        ok([{ "public-ip": PUBLIC_IP, "is-primary": true }]),
    },
  });
  assert.equal(outcome.status, "ready");
  assert.equal(log.some((argv) => argv.includes("instance") && argv.includes("launch")), true);
  const firstSsh = log.findIndex((argv) => argv[0] === "ssh");
  assert.equal(firstSsh > 0, true);
  assert.equal(
    log.slice(0, firstSsh).every((argv) => argv[0] !== "ssh"),
    true,
  );
  assert.equal(log.some((argv) => argv.includes("0.0.0.0/0") && argv.includes("nsg")), false);
});

test("open SSH CIDR never reaches create writes", async () => {
  const { outcome, log } = await harness({
    ui: mockUi({ confirm: true, input: ["0.0.0.0/0"] }),
  });
  assert.equal(outcome.status, "blocked");
  if (outcome.status === "blocked") {
    assert.equal(outcome.blockers.some((blocker) => blocker.code === "open-ssh"), true);
  }
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
});

test("missing guest host key blocks and never SSHes", async () => {
  const { outcome, log } = await harness({
    oci: {
      "compute instance list": () => ok([liveManaged()]),
      "compute console-history list": () => ok([]),
    },
    ui: mockUi({ confirm: [true, false] }),
  });
  assert.equal(outcome.status, "blocked");
  if (outcome.status === "blocked") {
    assert.equal(outcome.blockers.some((blocker) => blocker.code === "missing-host-key"), true);
  }
  assert.equal(log.some((argv) => argv[0] === "ssh"), false);
});

test("create without a public IP saves the host and does not launch twice", async () => {
  const { outcome, stateDir, log } = await harness({
    ui: mockUi({ confirm: true, input: [SSH_CIDR] }),
    oci: {
      "compute instance list-vnics": () => ok([]),
    },
  });
  assert.equal(outcome.status, "blocked");
  const saved = await loadState(stateDir);
  assert.equal(saved.host?.ocid, "ocid1.instance.oc1..created");
  assert.equal(log.filter((argv) => argv.includes("launch")).length, 1);

  const knownHostsDir = await mkdtemp(join(tmpdir(), "pi-cloud-kh-"));
  const secondLog: string[][] = [];
  const ociHandlers = baseOciHandlers({
    "compute instance list": () =>
      ok([
        {
          id: "ocid1.instance.oc1..created",
          "display-name": DEFAULT_DISPLAY_NAME,
          shape: A1_SHAPE,
          "shape-config": { ocpus: A1_OCPUS, "memory-in-gbs": A1_MEMORY_GB },
          "lifecycle-state": "RUNNING",
          "availability-domain": AD,
          "compartment-id": TENANCY,
          "freeform-tags": { "managed-by": MANAGED_BY },
        },
      ]),
    "compute instance launch": () => fail("should not launch again"),
    "compute instance list-vnics": () => ok([]),
  });
  const run: CommandRunner = async (argv) => {
    secondLog.push([...argv]);
    if (argv[0] === "ssh") return fail("no ssh without address");
    const parsed = parseArgv(argv);
    const handler = ociHandlers[parsed.tokens.join(" ")];
    return handler ? await handler(parsed) : fail(parsed.tokens.join(" "));
  };
  const retry = await runCloudStartup({
    cwd: stateDir,
    repo: "acme/proj",
    branch: "main",
    ui: mockUi({ confirm: true, input: [SSH_CIDR] }),
    runtime: {
      run,
      oci: mockedOciProvider({ run }),
      remote: createRemoteTransport({ run, knownHostsDir, randomId: () => "sess09" }),
      stateDir,
      knownHostsDir,
    },
  });
  assert.equal(retry.status, "blocked");
  assert.equal(secondLog.some((argv) => argv.includes("launch")), false);
});

test("saved host resumes without launching another instance", async () => {
  const first = await harness({
    oci: { "compute instance list": () => ok([liveManaged()]) },
    ui: mockUi({ confirm: true }),
  });
  assert.equal(first.outcome.status, "ready");
  const state = await loadState(first.stateDir);
  assert.equal(state.host?.ocid, INSTANCE_ID);

  const knownHostsDir = await mkdtemp(join(tmpdir(), "pi-cloud-kh-"));
  const remoteState = emptyRemoteState();
  const log: string[][] = [];
  const ociHandlers = baseOciHandlers({
    "compute instance list": () => ok([liveManaged()]),
    "compute instance launch": () => fail("should not launch"),
  });
  const run: CommandRunner = async (argv) => {
    log.push([...argv]);
    if (argv[0] === "ssh") return handleRemote(remoteState, remoteArgv(argv));
    const parsed = parseArgv(argv);
    const handler = ociHandlers[parsed.tokens.join(" ")];
    return handler ? await handler(parsed) : fail(parsed.tokens.join(" "));
  };
  const outcome = await runCloudStartup({
    cwd: first.stateDir,
    repo: "acme/proj",
    branch: "main",
    ui: mockUi({ confirm: false }),
    runtime: {
      run,
      oci: mockedOciProvider({ run }),
      remote: createRemoteTransport({ run, knownHostsDir, randomId: () => "sess02" }),
      stateDir: first.stateDir,
      knownHostsDir,
    },
  });
  assert.equal(outcome.status, "ready");
  assert.equal(log.some((argv) => argv.includes("launch")), false);
});

test("package runtime never copies secret paths", () => {
  assert.equal(looksLikeSecretTransfer(["scp", "file", "host:"]), true);
  assert.equal(looksLikeSecretTransfer(["ssh", "ubuntu@host", "'cat' '/home/ubuntu/.oci/config'"]), true);
  assert.equal(
    looksLikeSecretTransfer(["ssh", "ubuntu@host", "'git' 'clone' 'https://github.com/acme/proj.git'"]),
    false,
  );
});

test("default runtime wires spawnCommand", () => {
  assert.equal(resolveCloudRun(undefined), spawnCommand);
  assert.equal(resolveCloudRun({}), spawnCommand);
  const custom: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
  assert.equal(resolveCloudRun({ run: custom }), custom);
});

test("default startup without runtime.run adopts using injected seams, not a missing-run block", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  const knownHostsDir = await mkdtemp(join(tmpdir(), "pi-cloud-kh-"));
  await seedIdentity(stateDir);
  await saveState(stateDir, {
    version: 1,
    setupStep: "ready",
    identityFile: identityPath(stateDir),
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIlocalfixture pi-cloud",
    host: {
      id: "inst-adoptme0001",
      ocid: INSTANCE_ID,
      address: PUBLIC_IP,
      user: "ubuntu",
      expectedHostKey: HOST_KEY,
      displayName: DEFAULT_DISPLAY_NAME,
      compartmentId: TENANCY,
      region: HOME,
    },
    sessions: [],
  });
  const log: string[][] = [];
  const remoteState = emptyRemoteState();
  const ociHandlers = baseOciHandlers({
    "compute instance list": () => ok([liveManaged()]),
  });
  const injected: CommandRunner = async (argv) => {
    log.push([...argv]);
    throw new Error(`default startup must not call injected run; got ${argv.join(" ")}`);
  };
  const ociRun: CommandRunner = async (argv) => {
    const parsed = parseArgv(argv);
    const handler = ociHandlers[parsed.tokens.join(" ")];
    if (!handler) return fail(parsed.tokens.join(" "));
    return await handler(parsed);
  };
  const remoteRun: CommandRunner = async (argv) => {
    if (argv[0] === "ssh") return handleRemote(remoteState, remoteArgv(argv));
    return fail(argv.join(" "));
  };
  const outcome = await runCloudStartup({
    cwd: stateDir,
    repo: "acme/proj",
    branch: "main",
    ui: mockUi({ confirm: false }),
    runtime: {
      oci: mockedOciProvider({ run: ociRun }),
      remote: createRemoteTransport({ run: remoteRun, knownHostsDir, randomId: () => "sess01" }),
      stateDir,
      knownHostsDir,
    },
  });
  assert.equal(outcome.status, "ready", outcome.status === "blocked" ? outcome.blockers.map((b) => b.message).join("; ") : "");
  assert.equal(log.length, 0);
  void injected;
});

test("missing-tool start shows the exact remote install hint", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  const knownHostsDir = await mkdtemp(join(tmpdir(), "pi-cloud-kh-"));
  await seedIdentity(stateDir);
  await saveState(stateDir, {
    version: 1,
    setupStep: "ready",
    identityFile: identityPath(stateDir),
    sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIlocalfixture pi-cloud",
    host: {
      id: "inst-adoptme0001",
      ocid: INSTANCE_ID,
      address: PUBLIC_IP,
      user: "ubuntu",
      expectedHostKey: HOST_KEY,
      displayName: DEFAULT_DISPLAY_NAME,
      compartmentId: TENANCY,
      region: HOME,
    },
    sessions: [],
  });
  const ociHandlers = baseOciHandlers({
    "compute instance list": () => ok([liveManaged()]),
  });
  const ociRun: CommandRunner = async (argv) => {
    const parsed = parseArgv(argv);
    const handler = ociHandlers[parsed.tokens.join(" ")];
    return handler ? await handler(parsed) : fail(parsed.tokens.join(" "));
  };
  const remote = {
    async pinHostKey(enrollment: { host: { id: string; address: string; user: string; expectedHostKey?: string } }) {
      return {
        ok: true as const,
        pinned: {
          host: {
            id: enrollment.host.id,
            address: enrollment.host.address,
            user: enrollment.host.user,
            expectedHostKey: enrollment.host.expectedHostKey ?? HOST_KEY,
          },
          knownHostsPath: join(knownHostsDir, "vm.known_hosts"),
          aliases: [enrollment.host.address],
          source: "cloud-init-console-history" as const,
        },
      };
    },
    async selectRepo() {
      return {
        ok: true as const,
        repo: "https://github.com/acme/proj.git",
        baseBranch: "main",
        workingBranch: "pi/sess01",
        inferred: false,
      };
    },
    async start() {
      return {
        status: "blocked" as const,
        blockers: [
          {
            code: "missing-tool" as const,
            message: "remote node is missing; install Node.js >= 22.19 on the VM",
          },
        ],
      };
    },
    async attach() {
      return { status: "blocked" as const, blockers: [] };
    },
    async inspect() {
      return { blockers: [], connection: "ok" as const };
    },
  };
  const outcome = await runCloudStartup({
    cwd: stateDir,
    repo: "acme/proj",
    branch: "main",
    ui: mockUi({ confirm: false }),
    runtime: {
      oci: mockedOciProvider({ run: ociRun }),
      remote,
      stateDir,
      knownHostsDir,
      run: ociRun,
    },
  });
  assert.equal(outcome.status, "blocked");
  if (outcome.status === "blocked") {
    assert.equal(outcome.blockers.some((blocker) => blocker.code === "missing-tool"), true);
    assert.match(outcome.next ?? "", /Install Node\.js >= 22\.19/);
    assert.match(formatStartupFailure(outcome), /Install Node\.js >= 22\.19/);
    assert.match(formatStartupFailure(outcome), /npm install -g @earendil-works\/pi-coding-agent/);
  }
});

test("corrupt existing state fails closed and does not create", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  await writeFile(join(stateDir, "state.json"), "{not-json", { mode: 0o600 });
  let launches = 0;
  const { outcome, log } = await harness({
    stateDir,
    ui: mockUi({ confirm: true, input: [SSH_CIDR] }),
    oci: {
      "compute instance launch": () => {
        launches += 1;
        return fail("should not launch");
      },
    },
  });
  assert.equal(outcome.status, "blocked");
  if (outcome.status === "blocked") {
    assert.equal(outcome.blockers.some((blocker) => blocker.code === "corrupt-state"), true);
  }
  assert.equal(launches, 0);
  assert.equal(log.some((argv) => argv.includes("launch")), false);
});

test("concurrent first-run create takes the exclusive setup lock", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  const knownHostsDir = await mkdtemp(join(tmpdir(), "pi-cloud-kh-"));
  await seedIdentity(stateDir);
  let launches = 0;
  let releaseConfirm: ((value: boolean) => void) | undefined;
  let enteredConfirm: (() => void) | undefined;
  const sawConfirm = new Promise<void>((resolve) => {
    enteredConfirm = resolve;
  });
  const confirmGate = new Promise<boolean>((resolve) => {
    releaseConfirm = resolve;
  });
  const ui: CloudUi = {
    async confirm() {
      enteredConfirm?.();
      return await confirmGate;
    },
    async input() {
      return SSH_CIDR;
    },
    async select() {
      return undefined;
    },
    notify() {},
  };
  const ociHandlers = baseOciHandlers({
    "compute instance launch": () => {
      launches += 1;
      return ok({
        id: "ocid1.instance.oc1..created",
        "display-name": DEFAULT_DISPLAY_NAME,
        shape: A1_SHAPE,
        "shape-config": { ocpus: A1_OCPUS, "memory-in-gbs": A1_MEMORY_GB },
        "lifecycle-state": "RUNNING",
        "availability-domain": AD,
        "compartment-id": TENANCY,
        "freeform-tags": { "managed-by": MANAGED_BY },
      });
    },
  });
  const makeRuntime = (sessionId: string) => {
    const remoteState = emptyRemoteState();
    const run: CommandRunner = async (argv) => {
      if (argv[0] === "ssh") return handleRemote(remoteState, remoteArgv(argv));
      const parsed = parseArgv(argv);
      const handler = ociHandlers[parsed.tokens.join(" ")];
      return handler ? await handler(parsed) : fail(parsed.tokens.join(" "));
    };
    return {
      run,
      oci: mockedOciProvider({ run }),
      remote: createRemoteTransport({ run, knownHostsDir, randomId: () => sessionId, registry: createMemoryRegistry() }),
      stateDir,
      knownHostsDir,
    };
  };
  const first = runCloudStartup({
    cwd: stateDir,
    repo: "acme/proj",
    branch: "main",
    ui,
    runtime: makeRuntime("sessA"),
  });
  await sawConfirm;
  const second = await runCloudStartup({
    cwd: stateDir,
    repo: "acme/proj",
    branch: "main",
    ui: mockUi({ confirm: true, input: [SSH_CIDR] }),
    runtime: makeRuntime("sessB"),
  });
  assert.equal(second.status, "blocked");
  if (second.status === "blocked") {
    assert.equal(second.blockers.some((blocker) => blocker.code === "concurrent-start"), true);
  }
  assert.equal(launches, 0);
  releaseConfirm?.(true);
  const finished = await first;
  assert.equal(finished.status === "ready" || finished.status === "blocked", true);
  assert.equal(launches <= 1, true);
});

test("stale setup lock blocks and is not stolen", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  await seedIdentity(stateDir);
  await acquireExclusiveLock(setupLockPath(stateDir));
  const { outcome, log } = await harness({
    stateDir,
    ui: mockUi({ confirm: true, input: [SSH_CIDR] }),
  });
  assert.equal(outcome.status, "blocked");
  if (outcome.status === "blocked") {
    assert.equal(outcome.blockers.some((blocker) => blocker.code === "concurrent-start"), true);
  }
  assert.equal(log.some((argv) => argv.includes("launch")), false);
});

test("create confirmation names the verified platform image and trial caveat", () => {
  const text = formatCreateConfirmation(
    {
      authenticated: true,
      tenancyId: TENANCY,
      homeRegion: HOME,
      billingPlan: "free-tier",
      subscriptionAccess: "ok",
      subscriptions: [],
      evidence: "unambiguous OSP Gateway plan-type=FREE_TIER inventory",
    },
    {
      intended: { shape: A1_SHAPE, ocpus: A1_OCPUS, memoryGb: A1_MEMORY_GB, bootVolumeGb: 50, sshCidr: SSH_CIDR },
      image: { id: IMAGE, displayName: "Canonical-Ubuntu-22.04", operatingSystem: "Canonical Ubuntu" },
      plannedWrites: ["compute instance launch"],
    },
  );
  assert.match(text, /Canonical-Ubuntu-22\.04/);
  assert.match(text, new RegExp(IMAGE));
  assert.match(text, /FREE_TIER includes trial/);
  assert.match(text, /not a blanket Always Free proof/);
  assert.match(text, /independently bounded/);
});
