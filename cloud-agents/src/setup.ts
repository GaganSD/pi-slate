import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  A1_MEMORY_GB,
  A1_OCPUS,
  A1_SHAPE,
  ALWAYS_FREE_STORAGE_GB,
  cliValue,
  createOciProvider,
  DEFAULT_DISPLAY_NAME,
  isOperatorSshCidr,
  OCI_AUTH,
  OCI_PROFILE,
  spawnCommand,
  type AccountSnapshot,
  type CommandResult,
  type CommandRunner,
  type CreateResult,
  type InstanceSummary,
  type OciProvider,
} from "./oci.ts";
import { enrollGuestSshHostKey } from "./host-key.ts";
import {
  createRemoteTransport,
  looksLikeSecretTransfer,
  MIN_REMOTE_NODE,
  type AttachResult,
  type PinnedHost,
  type RemoteBlocker,
  type RemoteTransport,
  type SessionRecord,
  type SessionRegistry,
} from "./remote.ts";
import {
  createFileRegistry,
  DEFAULT_STATE_DIR,
  identityPath,
  loadState,
  setupLockPath,
  StateLoadError,
  StateLockError,
  updateState,
  withExclusiveLock,
  type PersistedHost,
  type PersistedState,
} from "./state.ts";
import { asString, compactText, guestUserForOs, hostIdFromOcid, ociItems, unwrapData } from "./util.ts";

export type CloudUi = {
  confirm(title: string, message: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

export type CloudRuntime = {
  run?: CommandRunner;
  interactive?: (argv: readonly string[]) => Promise<CommandResult>;
  oci?: OciProvider;
  remote?: RemoteTransport;
  registry?: SessionRegistry;
  stateDir?: string;
  knownHostsDir?: string;
};

export type StartupRequest = {
  cwd: string;
  repo?: string;
  branch?: string;
  ui: CloudUi;
  runtime?: CloudRuntime;
};

export type PreparedAttach = {
  pinned: PinnedHost;
  session: SessionRecord;
  identityFile?: string;
  attach: () => Promise<AttachResult>;
};

export type StartupOutcome =
  | { status: "ready"; prepared: PreparedAttach }
  | { status: "cancelled"; message: string }
  | { status: "blocked"; blockers: Array<{ code: string; message: string }>; next?: string };

const NEW_SESSION = "New session";

export function resolveCloudRun(runtime?: CloudRuntime): CommandRunner {
  return runtime?.run ?? spawnCommand;
}

export async function runCloudStartup(request: StartupRequest): Promise<StartupOutcome> {
  const stateDir = request.runtime?.stateDir ?? DEFAULT_STATE_DIR;
  const run = resolveCloudRun(request.runtime);
  const registry = request.runtime?.registry ?? createFileRegistry(stateDir);
  const oci = request.runtime?.oci ?? createOciProvider({ run });
  const remote =
    request.runtime?.remote ??
    createRemoteTransport({
      run,
      knownHostsDir: request.runtime?.knownHostsDir,
      registry,
    });
  const ctx = { request, stateDir, run, registry, oci, remote };

  let state: PersistedState;
  try {
    state = await loadState(stateDir);
  } catch (error) {
    return stateFailure(error);
  }
  const identity = await ensureIdentity(ctx, state);
  if (identity.status !== "ok") return identity;
  state = identity.state;

  const account = await ensureAuthenticated(ctx, state);
  if (account.status !== "ok") return account;
  state = account.state;

  let host: { status: "ok"; state: PersistedState } | StartupOutcome;
  try {
    host = await withExclusiveLock(setupLockPath(stateDir), async () => {
      const latest = await loadState(stateDir);
      return await ensureHost(ctx, latest, account.account);
    });
  } catch (error) {
    return stateFailure(error);
  }
  if (host.status !== "ok") return host;
  state = host.state;

  const pinned = await ensurePinned(ctx, state);
  if (pinned.status !== "ok") return pinned;
  state = pinned.state;

  return await ensureSession(ctx, state, pinned.pinned);
}

export function formatStartupFailure(outcome: Exclude<StartupOutcome, { status: "ready" }>): string {
  if (outcome.status === "cancelled") return outcome.message;
  const lines = outcome.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`);
  if (outcome.next) lines.push(`next: ${outcome.next}`);
  return lines.join("\n");
}

async function ensureIdentity(
  ctx: RuntimeCtx,
  state: PersistedState,
): Promise<{ status: "ok"; state: PersistedState } | StartupOutcome> {
  const keyFile = state.identityFile ?? identityPath(ctx.stateDir);
  const pubFile = `${keyFile}.pub`;
  const existing = await readOptional(pubFile);
  if (existing) {
    const next = await updateState(ctx.stateDir, (current) => ({
      ...current,
      identityFile: keyFile,
      sshPublicKey: existing.trim(),
    }));
    return { status: "ok", state: next };
  }
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  const generated = await ctx.run([
    "ssh-keygen",
    "-t",
    "ed25519",
    "-f",
    keyFile,
    "-N",
    "",
    "-C",
    "pi-cloud",
    "-q",
  ]);
  if (generated.code !== 0) {
    return blocked(
      "permissions",
      compactText(generated.stderr || "ssh-keygen failed"),
      `create ${keyFile} locally and re-run pi --cloud`,
    );
  }
  await writeFile(keyFile, await readFile(keyFile), { mode: 0o600 }).catch(() => undefined);
  const pub = (await readOptional(pubFile))?.trim();
  if (!pub) return blocked("permissions", "ssh-keygen did not write a public key");
  const next = await updateState(ctx.stateDir, (current) => ({
    ...current,
    identityFile: keyFile,
    sshPublicKey: pub,
  }));
  return { status: "ok", state: next };
}

async function ensureAuthenticated(
  ctx: RuntimeCtx,
  state: PersistedState,
): Promise<{ status: "ok"; account: AccountSnapshot; state: PersistedState } | StartupOutcome> {
  const first = await ctx.oci.preflight();
  if (first.authenticated && first.tenancyId && first.homeRegion) {
    const next = await updateState(ctx.stateDir, (current) => ({
      ...current,
      setupStep: current.setupStep === "auth" ? "discover" : current.setupStep,
    }));
    return { status: "ok", account: first, state: next };
  }

  const proceed = await ctx.request.ui.confirm(
    "OCI authentication required",
    [
      `Pi Cloud uses the browser session profile ${OCI_PROFILE} (security_token).`,
      "The CLI stores that token; this package does not read ~/.oci secrets.",
      first.evidence ? `Current session: ${first.evidence}` : "No authenticated PI_CLOUD session.",
      "Authenticate in a browser now?",
    ].join("\n"),
  );
  if (!proceed) return cancelled("OCI authentication declined. Re-run pi --cloud when ready.");

  const region =
    (await ctx.request.ui.input("Tenancy home region", "eu-frankfurt-1"))?.trim() ?? "";
  if (!region) return cancelled("Home region is required for oci session authenticate.");
  const tenancyName = (await ctx.request.ui.input("Tenancy name (optional)", ""))?.trim();

  const argv = ["oci", "session", "authenticate", "--region", region, "--profile-name", OCI_PROFILE];
  if (tenancyName) argv.push("--tenancy-name", tenancyName);

  if (!ctx.request.runtime?.interactive) {
    return blocked(
      "permissions",
      `no authenticated ${OCI_PROFILE} session`,
      `run: ${argv.join(" ")}  then re-run pi --cloud`,
    );
  }
  const authenticated = await ctx.request.runtime.interactive(argv);
  const account = await ctx.oci.preflight();
  if (!account.authenticated || !account.tenancyId || !account.homeRegion) {
    return blocked(
      "permissions",
      account.evidence || compactText(authenticated.stderr || "PI_CLOUD session is still unauthenticated"),
      `run: ${argv.join(" ")}  then re-run pi --cloud`,
    );
  }
  const next = await updateState(ctx.stateDir, (current) => ({
    ...current,
    setupStep: current.setupStep === "auth" ? "discover" : current.setupStep,
  }));
  return { status: "ok", account, state: next };
}

async function ensureHost(
  ctx: RuntimeCtx,
  state: PersistedState,
  account: AccountSnapshot,
): Promise<{ status: "ok"; state: PersistedState } | StartupOutcome> {
  if (state.host?.ocid) {
    const discovered = await ctx.oci.discover({ instanceId: state.host.ocid });
    if (!discovered.adopted) {
      return blocked(
        "ownership",
        `saved host ${state.host.ocid} was not found as a live instance`,
        "Inspect the tenancy. Do not create another VM automatically. Remove ~/.pi/cloud-agents/state.json only if you intend to start over.",
      );
    }
    const address = state.host.address || (await resolvePublicIp(ctx, discovered.adopted, account)) || "";
    if (!address) {
      return blocked(
        "unreachable",
        `saved host ${state.host.ocid} has no public IP yet`,
        "Wait for the VNIC address, then re-run pi --cloud. Another VM will not be created.",
      );
    }
    const adopted = discovered.adopted;
    const next = await updateState(ctx.stateDir, (current) => {
      const previous = current.host ?? state.host;
      if (!previous) {
        throw new StateLoadError("saved host disappeared while the setup lock was held");
      }
      return {
        ...current,
        setupStep: current.setupStep === "auth" ? "enroll" : current.setupStep,
        host: {
          ...previous,
          address,
          ocid: adopted.id,
          displayName: adopted.displayName,
        },
      };
    });
    return { status: "ok", state: next };
  }

  const discovered = await ctx.oci.discover({ displayName: DEFAULT_DISPLAY_NAME });
  if (discovered.blockers.some((blocker) => blocker.code === "permissions" && !discovered.account.authenticated)) {
    return blockedList(discovered.blockers, "Authenticate the PI_CLOUD profile and re-run pi --cloud.");
  }
  if (discovered.adopted) {
    const accepted = await ctx.request.ui.confirm(
      "Adopt existing A1 host",
      [
        `Found ${discovered.adopted.displayName} (${discovered.adopted.id}).`,
        `${discovered.adopted.shape} ${discovered.adopted.ocpus} OCPU / ${discovered.adopted.memoryGb} GB in ${discovered.account.homeRegion ?? "unknown region"}.`,
        "Adoption first: reuse this host instead of creating another VM?",
      ].join("\n"),
    );
    if (!accepted) return cancelled("Existing host was not adopted. Re-run pi --cloud to choose again.");
    return await persistHost(ctx, state, discovered.adopted, account);
  }
  if (discovered.blockers.some((blocker) => blocker.code === "ambiguous-instance")) {
    const ocid = (await ctx.request.ui.input("Exact instance OCID", "ocid1.instance.oc1..."))?.trim();
    if (!ocid) return cancelled("Exact OCID required when multiple instances match.");
    const exact = await ctx.oci.discover({ instanceId: ocid });
    if (!exact.adopted) {
      return blockedList(exact.blockers.length > 0 ? exact.blockers : [{ code: "ambiguous-instance", message: "that OCID is not a live instance" }]);
    }
    return await persistHost(ctx, state, exact.adopted, account);
  }

  const cidr = await askSshCidr(ctx);
  if (typeof cidr !== "string") return cidr;
  if (!state.sshPublicKey) return blocked("permissions", "missing local SSH public key");

  const report = await ctx.oci.evaluateCreate({
    publicSshCidr: cidr,
    sshPublicKey: state.sshPublicKey,
  });
  if (report.adopted) {
    return await persistHost(ctx, state, report.adopted, account);
  }
  if (!report.eligible) {
    return blockedList(
      report.blockers,
      "Creation stayed blocked. There is no paid fallback. Inspect any partial resources listed by OCI before retrying.",
    );
  }

  const created = await ctx.oci.create({
    publicSshCidr: cidr,
    sshPublicKey: state.sshPublicKey,
    confirm: async (_action, details) =>
      ctx.request.ui.confirm("Create eligible A1 VM?", formatCreateConfirmation(report.account, details)),
  });
  return await persistCreated(ctx, state, created, account);
}

async function persistCreated(
  ctx: RuntimeCtx,
  state: PersistedState,
  created: CreateResult,
  account: AccountSnapshot,
): Promise<{ status: "ok"; state: PersistedState } | StartupOutcome> {
  if (created.status === "adopted" && created.instance) {
    return await persistHost(ctx, state, created.instance, account);
  }
  if (created.status === "unconfirmed") {
    return blockedList(created.blockers, "No API writes were made.");
  }
  if (created.status !== "created" || !created.instance) {
    const partial = created.partial.map((item) => `${item.kind} ${item.id ?? ""} ${item.note}`.trim());
    return blockedList(
      created.blockers,
      partial.length > 0
        ? `Partial resources (not auto-destroyed): ${partial.join("; ")}`
        : "No paid fallback. Inspect the tenancy before retrying.",
    );
  }
  return await persistHost(ctx, state, created.instance, account);
}

async function persistHost(
  ctx: RuntimeCtx,
  state: PersistedState,
  instance: InstanceSummary,
  account: AccountSnapshot,
): Promise<{ status: "ok"; state: PersistedState } | StartupOutcome> {
  const address = (state.host?.address || (await resolvePublicIp(ctx, instance, account))) ?? "";
  const operatingSystem = state.host?.operatingSystem ?? (await resolveOperatingSystem(ctx, instance, account));
  const host: PersistedHost = {
    id: hostIdFromOcid(instance.id),
    ocid: instance.id,
    address,
    user: guestUserForOs(operatingSystem),
    expectedHostKey: state.host?.expectedHostKey ?? "",
    displayName: instance.displayName || DEFAULT_DISPLAY_NAME,
    compartmentId: instance.compartmentId,
    region: account.homeRegion,
    operatingSystem,
  };
  const next = await updateState(ctx.stateDir, (current) => ({
    ...current,
    setupStep: "enroll",
    host: { ...host, expectedHostKey: current.host?.expectedHostKey || host.expectedHostKey },
  }));
  if (!address) {
    return blocked(
      "unreachable",
      `instance ${instance.id} has no public IP yet`,
      "Wait for the VNIC to assign an address, then re-run pi --cloud. The saved setup step will resume instead of creating another VM.",
    );
  }
  return { status: "ok", state: next };
}

async function ensurePinned(
  ctx: RuntimeCtx,
  state: PersistedState,
): Promise<{ status: "ok"; pinned: PinnedHost; state: PersistedState } | StartupOutcome> {
  const host = state.host;
  if (!host) return blocked("unpinned-host", "no host is saved to enroll");

  const enrolled = await enrollGuestSshHostKey({
    run: ctx.run,
    remote: ctx.remote,
    instanceId: host.ocid,
    compartmentId: host.compartmentId ?? host.ocid,
    region: host.region,
    host: {
      id: host.id,
      address: host.address,
      user: host.user,
      expectedHostKey: host.expectedHostKey || undefined,
    },
    confirmCapture: () =>
      ctx.request.ui.confirm(
        "Capture console history",
        "Pin the guest Ubuntu sshd host key from independently authenticated cloud-init console-history before any SSH. Capture now? Serial-console service keys will not be enrolled. Decline to stay blocked.",
      ),
  });
  if (!enrolled.ok) {
    return blockedList(
      enrolled.blockers,
      "SSH is blocked until the guest sshd key can be pinned from cloud-init console-history. accept-new is never used.",
    );
  }
  const next = await updateState(ctx.stateDir, (current) => ({
    ...current,
    setupStep: "ready",
    host: { ...(current.host ?? host), expectedHostKey: enrolled.pinned.host.expectedHostKey },
  }));
  return { status: "ok", pinned: enrolled.pinned, state: next };
}

async function ensureSession(
  ctx: RuntimeCtx,
  state: PersistedState,
  pinned: PinnedHost,
): Promise<StartupOutcome> {
  const preview = await ctx.remote.selectRepo({
    cwd: ctx.request.cwd,
    repo: ctx.request.repo,
    branch: ctx.request.branch,
    sessionId: "preview0",
  });
  if (!preview.ok) {
    if (preview.blockers.some((blocker) => blocker.code === "missing-origin")) {
      return blockedList(
        preview.blockers,
        "Blank remote workspaces are not created automatically. Pass --repo OWNER/REPO or add a git origin. Local files are never copied.",
      );
    }
    return blockedList(preview.blockers);
  }

  const matches = (await ctx.registry.list({
    hostId: pinned.host.id,
    repo: preview.repo,
    baseBranch: preview.baseBranch,
  })).filter((session) => session.id !== "preview0");

  let sessionId: string | undefined;
  if (matches.length === 1) {
    sessionId = matches[0].id;
  } else if (matches.length > 1) {
    const labels = [...matches.map(sessionLabel), NEW_SESSION];
    const chosen = await ctx.request.ui.select("Attach to a Pi Cloud session", labels);
    if (!chosen) return cancelled("No session selected.");
    if (chosen !== NEW_SESSION) {
      sessionId = matches[labels.indexOf(chosen)]?.id;
      if (!sessionId) return cancelled("No session selected.");
    }
  }

  if (sessionId) {
    const inspected = await ctx.remote.inspect({
      pinned,
      sessionId,
      identityFile: state.identityFile,
    });
    if (inspected.connection === "unreachable") {
      return blockedList(inspected.blockers, "Reattachment refused; local tools are not used as a fallback.");
    }
    const session = inspected.session;
    if (!session) return blocked("unknown-status", "remote session state is unknown");
    if (session.status === "running" || session.status === "detached") {
      return ready(pinned, session, state.identityFile, ctx.remote);
    }
    return blocked(
      session.status === "rebooted" ? "stale-session" : session.status === "stale" ? "stale-session" : "unknown-status",
      `remote session is ${session.status}`,
      "In-flight work is not promised across OCI stop/reboot. Start a new session only after you inspect the VM.",
    );
  }

  const started = await ctx.remote.start({
    pinned,
    cwd: ctx.request.cwd,
    repo: ctx.request.repo,
    branch: ctx.request.branch,
    identityFile: state.identityFile,
  });
  if (started.status !== "started") {
    const missingTools = started.blockers.some((blocker) => /pi|tmux|git|not found|command not found/i.test(blocker.message));
    return blockedList(
      started.blockers,
      missingTools
        ? [
            "The guest sshd key is pinned, but required remote tools are missing.",
            `Install Node.js >= ${MIN_REMOTE_NODE} for linux-arm64 from a source you trust, then:`,
            "  sudo apt-get update && sudo apt-get install -y git tmux",
            "  npm install -g @earendil-works/pi-coding-agent",
            "Sign in to the model provider on the VM. Local laptop credentials are not copied.",
            "Re-run: pi --cloud",
          ].join("\n")
        : "Remote start stayed blocked. Local tools are not used as a fallback.",
    );
  }
  return ready(pinned, started.session, state.identityFile, ctx.remote);
}

function ready(
  pinned: PinnedHost,
  session: SessionRecord,
  identityFile: string | undefined,
  remote: RemoteTransport,
): StartupOutcome {
  return {
    status: "ready",
    prepared: {
      pinned,
      session,
      identityFile,
      attach: () => remote.attach({ pinned, sessionId: session.id, identityFile }),
    },
  };
}

async function askSshCidr(ctx: RuntimeCtx): Promise<string | StartupOutcome> {
  const entered = (
    await ctx.request.ui.input(
      "Operator SSH source /32",
      "203.0.113.10/32",
    )
  )?.trim();
  if (!entered) return cancelled("SSH source /32 is required to evaluate create.");
  if (!isOperatorSshCidr(entered)) {
    return blocked(
      "open-ssh",
      "SSH source must be the operator IPv4 /32; 0.0.0.0/0 and other open ranges are refused",
    );
  }
  return entered;
}

async function resolvePublicIp(
  ctx: RuntimeCtx,
  instance: InstanceSummary,
  account: AccountSnapshot,
): Promise<string | undefined> {
  if (!ctx.run || !account.homeRegion) return undefined;
  const result = await ctx.run(
    ociArgv(
      ["compute", "instance", "list-vnics", "--instance-id", instance.id, "--all"],
      account.homeRegion,
    ),
  );
  if (result.code !== 0) return undefined;
  try {
    const items = ociItems(JSON.parse(result.stdout) as unknown);
    const primary = items.find((item) => cliValue(item, "is_primary") === true) ?? items[0];
    return asString(cliValue(primary ?? {}, "public_ip"));
  } catch {
    return undefined;
  }
}

async function resolveOperatingSystem(
  ctx: RuntimeCtx,
  instance: InstanceSummary,
  account: AccountSnapshot,
): Promise<string | undefined> {
  if (!ctx.run || !account.homeRegion) return undefined;
  const got = await ctx.run(ociArgv(["compute", "instance", "get", "--instance-id", instance.id], account.homeRegion));
  if (got.code !== 0) return undefined;
  try {
    const raw = unwrapData(JSON.parse(got.stdout) as unknown);
    const imageId = asString(cliValue(asRecord(raw) ?? {}, "image_id"));
    if (!imageId) return undefined;
    const image = await ctx.run(ociArgv(["compute", "image", "get", "--image-id", imageId], account.homeRegion));
    if (image.code !== 0) return undefined;
    const imageRaw = unwrapData(JSON.parse(image.stdout) as unknown);
    return asString(cliValue(asRecord(imageRaw) ?? {}, "operating_system"));
  } catch {
    return undefined;
  }
}

export function formatCreateConfirmation(account: AccountSnapshot, details: unknown): string {
  const record = asRecord(details) ?? {};
  const intended = asRecord(record.intended) ?? {};
  const image = asRecord(record.image) ?? {};
  const imageId = asString(image.id) ?? asString(intended.imageId) ?? "unknown";
  const imageName = asString(image.displayName) ?? asString(intended.imageName) ?? "unknown";
  const planned = Array.isArray(record.plannedWrites)
    ? record.plannedWrites.filter((item): item is string => typeof item === "string")
    : [];
  return [
    `Account plan: ${account.billingPlan} (${account.evidence})`,
    "FREE_TIER includes trial accounts; it is not a blanket Always Free proof.",
    "Eligibility is independently bounded by home-region A1 headroom, a verified AVAILABLE platform image, storage, and operator /32 SSH.",
    `Home region: ${account.homeRegion ?? "unknown"}`,
    `Shape: ${asString(intended.shape) ?? A1_SHAPE} ${asString(String(intended.ocpus ?? A1_OCPUS))} OCPU / ${asString(String(intended.memoryGb ?? A1_MEMORY_GB))} GB`,
    `Platform image: ${imageName} (${imageId})`,
    `Boot volume: ${asString(String(intended.bootVolumeGb ?? "")) || "default"} GB of ${ALWAYS_FREE_STORAGE_GB} GB Always Free compute/boot/block target`,
    `Temporary SSH source: ${asString(intended.sshCidr) ?? "missing"}`,
    "Planned writes:",
    ...planned.map((item) => `- ${item}`),
    "No paid fallback if A1 capacity is unavailable.",
    "Confirm only if you accept these writes.",
  ].join("\n");
}

export function assertNoSecretTransfer(argv: readonly string[]): boolean {
  return !looksLikeSecretTransfer(argv);
}

function ociArgv(parts: readonly string[], region?: string): string[] {
  const argv = ["oci", "--profile", OCI_PROFILE, "--auth", OCI_AUTH, "--output", "json"];
  if (region) argv.push("--region", region);
  argv.push(...parts);
  return argv;
}

function sessionLabel(session: SessionRecord): string {
  return `${session.id}  ${session.workingBranch}  ${session.status}`;
}

function cancelled(message: string): StartupOutcome {
  return { status: "cancelled", message };
}

function blocked(code: string, message: string, next?: string): StartupOutcome {
  return { status: "blocked", blockers: [{ code, message }], next };
}

function blockedList(blockers: Array<{ code: string; message: string }>, next?: string): StartupOutcome {
  return { status: "blocked", blockers, next };
}

function stateFailure(error: unknown): StartupOutcome {
  if (error instanceof StateLockError) {
    return blocked(error.code, error.message, "Do not start another create. Inspect the lock directory first.");
  }
  if (error instanceof StateLoadError) {
    return blocked(
      error.code,
      error.message,
      "Inspect state.json. Do not delete it to force another create unless you have confirmed no VM exists.",
    );
  }
  return blocked(
    "corrupt-state",
    error instanceof Error ? error.message : "Pi Cloud state could not be loaded",
    "Setup failed closed. Local tools are not used as a fallback.",
  );
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type RuntimeCtx = {
  request: StartupRequest;
  stateDir: string;
  run: CommandRunner;
  registry: SessionRegistry;
  oci: OciProvider;
  remote: RemoteTransport;
};

export type { RemoteBlocker };
