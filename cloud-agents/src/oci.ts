import { spawn } from "node:child_process";

/** Browser-session profile. The CLI holds the token; this module never reads ~/.oci secrets. */
export const OCI_PROFILE = "PI_CLOUD";
export const OCI_AUTH = "security_token";

/** Conservative Always Free A1 target from current Oracle Always Free docs. */
export const A1_SHAPE = "VM.Standard.A1.Flex";
export const A1_OCPUS = 2;
export const A1_MEMORY_GB = 12;
export const ALWAYS_FREE_STORAGE_GB = 200;
export const MIN_BOOT_VOLUME_GB = 47;
export const DEFAULT_BOOT_VOLUME_GB = 50;
export const MANAGED_BY = "pi-cloud";
export const DEFAULT_DISPLAY_NAME = "pi-cloud";
export const MAX_CAPACITY_ATTEMPTS = 3;

const MUTATING_TOKENS = new Set([
  "create",
  "launch",
  "update",
  "delete",
  "terminate",
  "add",
  "remove",
  "action",
  "attach",
  "detach",
  "put",
  "patch",
  "bulk-add",
  "bulk-delete",
  "change-compartment",
]);

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type CommandRunner = (argv: readonly string[]) => Promise<CommandResult>;

export type ConfirmFn = (action: string, details: unknown) => Promise<boolean>;

/** OSP Gateway planType. FREE_TIER includes trial; it is not an Always Free proof. */
export type BillingPlan = "free-tier" | "payg" | "unknown";

export type BlockerCode =
  | "wrong-home-region"
  | "payg-plan"
  | "unknown-plan"
  | "preexisting-a1-usage"
  | "preserved-volumes"
  | "failed-inventory"
  | "open-ssh"
  | "capacity"
  | "unconfirmed-write"
  | "image-ineligible"
  | "storage-exceeded"
  | "ownership"
  | "permissions"
  | "ambiguous-instance"
  | "boot-size";

export type Blocker = {
  code: BlockerCode;
  message: string;
};

export type AccountSnapshot = {
  authenticated: boolean;
  tenancyId?: string;
  homeRegion?: string;
  billingPlan: BillingPlan;
  /** OSP Gateway list access. Absent/ambiguous permissions deny create. */
  subscriptionAccess: "ok" | "denied" | "unknown";
  subscriptions: Array<{ id?: string; planType?: string; accountType?: string }>;
  evidence: string;
};

export type InstanceSummary = {
  id: string;
  displayName: string;
  shape: string;
  ocpus: number;
  memoryGb: number;
  lifecycleState: string;
  availabilityDomain: string;
  compartmentId: string;
  managedBy?: string;
};

export type VolumeSummary = {
  id: string;
  displayName: string;
  sizeGb: number;
  kind: "boot" | "block";
  lifecycleState: string;
  compartmentId: string;
  attachedInstanceId?: string;
};

export type PartialAllocation = {
  kind: string;
  id?: string;
  displayName?: string;
  note: string;
};

export type InventorySnapshot = {
  compartments: string[];
  availabilityDomains: string[];
  instances: InstanceSummary[];
  volumes: VolumeSummary[];
  a1Ocpus: number;
  a1MemoryGb: number;
  storageGb: number;
  failedQueries: string[];
  attachmentsKnown: boolean;
};

export type DiscoveryQuery = {
  instanceId?: string;
  displayName?: string;
};

export type DiscoveryResult = {
  account: AccountSnapshot;
  inventory: InventorySnapshot;
  candidates: InstanceSummary[];
  adopted?: InstanceSummary;
  blockers: Blocker[];
  partial: PartialAllocation[];
};

export type CreateRequest = {
  displayName?: string;
  region?: string;
  publicSshCidr: string;
  sshPublicKey: string;
  bootVolumeGb?: number;
  instanceId?: string;
  confirm?: ConfirmFn;
};

export type EligibilityReport = {
  eligible: boolean;
  blockers: Blocker[];
  account: AccountSnapshot;
  inventory: InventorySnapshot;
  adopted?: InstanceSummary;
  plannedWrites: string[];
  intended?: {
    region: string;
    shape: string;
    ocpus: number;
    memoryGb: number;
    bootVolumeGb: number;
    sshCidr: string;
    displayName: string;
  };
};

export type CreateResult = {
  status: "adopted" | "blocked" | "capacity" | "unconfirmed" | "created";
  instance?: InstanceSummary;
  blockers: Blocker[];
  partial: PartialAllocation[];
  attempts?: number;
  plannedWrites?: string[];
  account: AccountSnapshot;
  inventory: InventorySnapshot;
};

export type OciProviderOptions = {
  run?: CommandRunner;
  ociBin?: string;
  profile?: string;
  capacityRetryDelayMs?: number;
  wait?: (ms: number) => Promise<void>;
};

export type OciProvider = {
  preflight(): Promise<AccountSnapshot>;
  discover(query?: DiscoveryQuery): Promise<DiscoveryResult>;
  evaluateCreate(request: CreateRequest): Promise<EligibilityReport>;
  create(request: CreateRequest): Promise<CreateResult>;
};

export function isMutatingArgv(argv: readonly string[]): boolean {
  return argv.some((token) => MUTATING_TOKENS.has(token));
}

export function cliValue(obj: Record<string, unknown>, snake: string): unknown {
  const kebab = snake.replaceAll("_", "-");
  const camel = snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (Object.prototype.hasOwnProperty.call(obj, kebab)) return obj[kebab];
  if (Object.prototype.hasOwnProperty.call(obj, camel)) return obj[camel];
  if (Object.prototype.hasOwnProperty.call(obj, snake)) return obj[snake];
  return undefined;
}

/**
 * Billing plan comes only from OSP Gateway plan-type / planType.
 * account-type PERSONAL|CORPORATE is not a billing plan and is ignored.
 */
export function classifySubscriptions(items: Array<Record<string, unknown>>): {
  plan: BillingPlan;
  reason: string;
} {
  if (items.length === 0) {
    return { plan: "unknown", reason: "OSP Gateway returned no subscriptions" };
  }
  const types = items.map((item) => {
    const raw = cliValue(item, "plan_type");
    return typeof raw === "string" ? raw : "";
  });
  if (types.some((type) => type.length === 0)) {
    return { plan: "unknown", reason: "subscription inventory missing plan-type" };
  }
  const unique = new Set(types);
  if (unique.size === 1 && unique.has("FREE_TIER")) {
    return { plan: "free-tier", reason: "unambiguous OSP Gateway plan-type=FREE_TIER inventory" };
  }
  if (unique.has("PAYG") && !unique.has("FREE_TIER")) {
    return { plan: "payg", reason: "OSP Gateway plan-type=PAYG" };
  }
  if (unique.has("PAYG") && unique.has("FREE_TIER")) {
    return { plan: "unknown", reason: "mixed FREE_TIER and PAYG subscriptions" };
  }
  return { plan: "unknown", reason: `unrecognized plan-type values: ${[...unique].join(",")}` };
}

/** Authenticated Console history from cloud-init can carry guest sshd host fingerprints. */
export const GUEST_SSH_HOST_FINGERPRINT_SOURCE = "cloud-init-console-history";
/** OCI serial-console / instance-console-connection identity is a different SSH service. */
export const SERIAL_CONSOLE_FINGERPRINT_SOURCE = "serial-console-service";

export type SshHostFingerprintSource =
  | typeof GUEST_SSH_HOST_FINGERPRINT_SOURCE
  | typeof SERIAL_CONSOLE_FINGERPRINT_SOURCE
  | "unknown";

export function classifySshHostFingerprintSource(raw: string): SshHostFingerprintSource {
  const value = raw.trim().toLowerCase();
  if (
    value.includes("instance-console-connection") ||
    value.includes("serial-console") ||
    value.includes("serial console")
  ) {
    return SERIAL_CONSOLE_FINGERPRINT_SOURCE;
  }
  if (value.includes("cloud-init") && (value.includes("console-history") || value.includes("console history"))) {
    return GUEST_SSH_HOST_FINGERPRINT_SOURCE;
  }
  return "unknown";
}

/** Serial-console service fingerprints must never be enrolled as the Ubuntu sshd host key. */
export function isUsableGuestSshHostFingerprint(source: SshHostFingerprintSource | string): boolean {
  const classified =
    source === GUEST_SSH_HOST_FINGERPRINT_SOURCE ||
    source === SERIAL_CONSOLE_FINGERPRINT_SOURCE ||
    source === "unknown"
      ? source
      : classifySshHostFingerprintSource(source);
  return classified === GUEST_SSH_HOST_FINGERPRINT_SOURCE;
}

export function isForbiddenSshCidr(cidr: string): boolean {
  const trimmed = cidr.trim().toLowerCase();
  return trimmed === "0.0.0.0/0" || trimmed === "::/0";
}

export function isOperatorSshCidr(cidr: string): boolean {
  const trimmed = cidr.trim();
  if (isForbiddenSshCidr(trimmed)) return false;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/32$/.exec(trimmed);
  if (!match) return false;
  return match.slice(1).every((part) => Number(part) <= 255);
}

export function isAlwaysFreeEligibleA1Image(image: {
  operatingSystem?: string;
  displayName?: string;
}): boolean {
  const os = (image.operatingSystem ?? "").trim().toLowerCase();
  if (os === "ubuntu" || os === "canonical ubuntu") return true;
  if (os === "oracle linux" || os === "oracle linux cloud developer") return true;
  return false;
}

export function isLiveLifecycle(state: string): boolean {
  return !["TERMINATED", "TERMINATING", "DELETED", "DELETING"].includes(state.toUpperCase());
}

export async function spawnCommand(argv: readonly string[]): Promise<CommandResult> {
  if (argv.length === 0) return { stdout: "", stderr: "empty argv", code: 1 };
  const [command, ...args] = argv;
  return await new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error: Error) => {
      resolve({ stdout: "", stderr: error.message, code: 1 });
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
      });
    });
  });
}

export function createOciProvider(options: OciProviderOptions = {}): OciProvider {
  const run = options.run ?? spawnCommand;
  const ociBin = options.ociBin ?? "oci";
  const profile = options.profile ?? OCI_PROFILE;
  const wait = options.wait ?? defaultWait;
  const capacityRetryDelayMs = options.capacityRetryDelayMs ?? 0;

  const exec = async (parts: readonly string[], region?: string): Promise<CommandResult> => {
    return await run(buildArgv(ociBin, profile, parts, region));
  };

  const preflight = async (): Promise<AccountSnapshot> => {
    return await loadAccount(exec);
  };

  const discover = async (query: DiscoveryQuery = {}): Promise<DiscoveryResult> => {
    const account = await loadAccount(exec);
    if (!account.authenticated || !account.tenancyId || !account.homeRegion) {
      return {
        account,
        inventory: emptyInventory(),
        candidates: [],
        blockers: [
          {
            code: "permissions",
            message: account.evidence || "OCI session is not authenticated for profile PI_CLOUD",
          },
        ],
        partial: [],
      };
    }
    const inventory = await loadInventory(exec, account.tenancyId, account.homeRegion);
    const match = matchExactInstance(inventory.instances, query, DEFAULT_DISPLAY_NAME);
    const blockers: Blocker[] = [];
    if (inventory.failedQueries.length > 0) {
      blockers.push({
        code: "failed-inventory",
        message: `incomplete tenancy inventory: ${inventory.failedQueries.join("; ")}`,
      });
    }
    if (match.ambiguous) {
      blockers.push({
        code: "ambiguous-instance",
        message: "multiple live instances match; exact OCID required",
      });
    }
    return {
      account,
      inventory,
      candidates: match.candidates,
      adopted: match.adopted,
      blockers,
      partial: volumePartials(inventory.volumes),
    };
  };

  const evaluateCreate = async (request: CreateRequest): Promise<EligibilityReport> => {
    const discovered = await discover({
      instanceId: request.instanceId,
      displayName: request.displayName ?? DEFAULT_DISPLAY_NAME,
    });
    return buildEligibility(discovered, request, exec);
  };

  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const report = await evaluateCreate(request);
    if (report.adopted) {
      return {
        status: "adopted",
        instance: report.adopted,
        blockers: [],
        partial: volumePartials(report.inventory.volumes),
        account: report.account,
        inventory: report.inventory,
      };
    }
    if (!report.eligible) {
      return {
        status: statusForBlockers(report.blockers),
        blockers: report.blockers,
        partial: volumePartials(report.inventory.volumes),
        plannedWrites: report.plannedWrites,
        account: report.account,
        inventory: report.inventory,
      };
    }

    const intended = report.intended;
    if (!intended || !report.account.tenancyId || !report.account.homeRegion) {
      return {
        status: "blocked",
        blockers: [{ code: "permissions", message: "account identity incomplete" }],
        partial: [],
        account: report.account,
        inventory: report.inventory,
      };
    }

    const confirmed = request.confirm
      ? await request.confirm("create-a1", {
          intended,
          plannedWrites: report.plannedWrites,
          evidence: report.account.evidence,
        })
      : false;
    if (!confirmed) {
      return {
        status: "unconfirmed",
        blockers: [
          {
            code: "unconfirmed-write",
            message: "refusing API writes without explicit user confirmation",
          },
        ],
        partial: [],
        plannedWrites: report.plannedWrites,
        account: report.account,
        inventory: report.inventory,
      };
    }

    const region = report.account.homeRegion;
    const tenancyId = report.account.tenancyId;
    const partial: PartialAllocation[] = [];
    const network = await ensureNetwork(exec, {
      tenancyId,
      region,
      displayName: intended.displayName,
      sshCidr: intended.sshCidr,
      inventory: report.inventory,
      partial,
    });
    if (!network.ok) {
      return {
        status: "blocked",
        blockers: network.blockers,
        partial,
        account: report.account,
        inventory: report.inventory,
        attempts: 0,
      };
    }

    const image = await resolveEligibleImage(exec, tenancyId, region);
    if (!image) {
      return {
        status: "blocked",
        blockers: [
          {
            code: "image-ineligible",
            message: "no verified Always Free-eligible A1 image in the home region",
          },
        ],
        partial,
        account: report.account,
        inventory: report.inventory,
      };
    }

    const ads = report.inventory.availabilityDomains.length > 0
      ? report.inventory.availabilityDomains
      : await listAvailabilityDomains(exec, tenancyId, region);
    if (ads.length === 0) {
      return {
        status: "blocked",
        blockers: [{ code: "failed-inventory", message: "no availability domains returned" }],
        partial,
        account: report.account,
        inventory: report.inventory,
      };
    }

    let attempts = 0;
    let lastCapacity = "";
    for (let attempt = 0; attempt < MAX_CAPACITY_ATTEMPTS; attempt += 1) {
      attempts = attempt + 1;
      const ad = ads[attempt % ads.length];
      const launched = await launchInstance(exec, {
        tenancyId,
        region,
        availabilityDomain: ad,
        displayName: intended.displayName,
        subnetId: network.subnetId,
        nsgId: network.nsgId,
        imageId: image.id,
        bootVolumeGb: intended.bootVolumeGb,
        sshPublicKey: request.sshPublicKey,
      });
      if (launched.instance) {
        partial.push({
          kind: "instance",
          id: launched.instance.id,
          displayName: launched.instance.displayName,
          note: "created after explicit confirmation",
        });
        return {
          status: "created",
          instance: launched.instance,
          blockers: [],
          partial,
          attempts,
          account: report.account,
          inventory: report.inventory,
        };
      }
      if (launched.capacity) {
        lastCapacity = launched.message;
        if (capacityRetryDelayMs > 0 && attempt + 1 < MAX_CAPACITY_ATTEMPTS) {
          await wait(capacityRetryDelayMs);
        }
        continue;
      }
      return {
        status: "blocked",
        blockers: [{ code: "permissions", message: launched.message }],
        partial,
        attempts,
        account: report.account,
        inventory: report.inventory,
      };
    }

    return {
      status: "capacity",
      blockers: [
        {
          code: "capacity",
          message: `A1 capacity unavailable after ${attempts} bounded attempts; no paid fallback. ${lastCapacity}`.trim(),
        },
      ],
      partial,
      attempts,
      account: report.account,
      inventory: report.inventory,
    };
  };

  return { preflight, discover, evaluateCreate, create };
}

function buildArgv(ociBin: string, profile: string, parts: readonly string[], region?: string): string[] {
  const argv = [ociBin, "--profile", profile, "--auth", OCI_AUTH, "--output", "json"];
  if (region) argv.push("--region", region);
  argv.push(...parts);
  return argv;
}

async function defaultWait(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emptyInventory(): InventorySnapshot {
  return {
    compartments: [],
    availabilityDomains: [],
    instances: [],
    volumes: [],
    a1Ocpus: 0,
    a1MemoryGb: 0,
    storageGb: 0,
    failedQueries: [],
    attachmentsKnown: true,
  };
}

async function loadAccount(
  exec: (parts: readonly string[], region?: string) => Promise<CommandResult>,
): Promise<AccountSnapshot> {
  const regions = await readJson(exec(["iam", "region-subscription", "list"]));
  if (!regions.ok) {
    return {
      authenticated: false,
      billingPlan: "unknown",
      subscriptionAccess: "unknown",
      subscriptions: [],
      evidence: regions.error,
    };
  }
  const regionItems = ociItems(regions.value);
  const home = regionItems.find((item) => cliValue(item, "is_home_region") === true);
  const tenancyId = asString(cliValue(home ?? regionItems[0] ?? {}, "tenancy_id"));
  const homeRegion = asString(cliValue(home ?? {}, "region_name"));
  if (!tenancyId || !homeRegion) {
    return {
      authenticated: false,
      billingPlan: "unknown",
      subscriptionAccess: "unknown",
      subscriptions: [],
      evidence: "region-subscription list did not include tenancy-id and home region-name",
    };
  }

  const subscriptions = await readJson(
    exec(
      [
        "osp-gateway",
        "subscription-service",
        "subscription",
        "list",
        "--osp-home-region",
        homeRegion,
        "--compartment-id",
        tenancyId,
        "--all",
      ],
      homeRegion,
    ),
  );
  if (!subscriptions.ok) {
    return {
      authenticated: true,
      tenancyId,
      homeRegion,
      billingPlan: "unknown",
      subscriptionAccess: "denied",
      subscriptions: [],
      evidence: `OSP Gateway subscription list failed (absent or ambiguous permissions): ${subscriptions.error}`,
    };
  }
  const items = ociItems(subscriptions.value);
  const classified = classifySubscriptions(items);
  return {
    authenticated: true,
    tenancyId,
    homeRegion,
    billingPlan: classified.plan,
    subscriptionAccess: "ok",
    subscriptions: items.map((item) => ({
      id: asString(cliValue(item, "id")),
      planType: asString(cliValue(item, "plan_type")),
      accountType: asString(cliValue(item, "account_type")),
    })),
    evidence: classified.reason,
  };
}

async function loadInventory(
  exec: (parts: readonly string[], region?: string) => Promise<CommandResult>,
  tenancyId: string,
  region: string,
): Promise<InventorySnapshot> {
  const inventory = emptyInventory();
  inventory.compartments = [tenancyId];

  const compartments = await readJson(
    exec(
      [
        "iam",
        "compartment",
        "list",
        "--compartment-id",
        tenancyId,
        "--compartment-id-in-subtree",
        "true",
        "--access-level",
        "ANY",
        "--lifecycle-state",
        "ACTIVE",
        "--all",
      ],
      region,
    ),
  );
  if (!compartments.ok) {
    inventory.failedQueries.push(`compartment list: ${compartments.error}`);
    return inventory;
  }
  for (const item of ociItems(compartments.value)) {
    const id = asString(cliValue(item, "id"));
    if (id) inventory.compartments.push(id);
  }
  inventory.compartments = [...new Set(inventory.compartments)];

  inventory.availabilityDomains = await listAvailabilityDomains(exec, tenancyId, region);
  if (inventory.availabilityDomains.length === 0) {
    inventory.failedQueries.push("availability-domain list returned no domains");
  }

  let attachmentsKnown = true;
  const attachmentByVolume = new Map<string, string>();

  for (const compartmentId of inventory.compartments) {
    const instances = await readJson(
      exec(["compute", "instance", "list", "--compartment-id", compartmentId, "--all"], region),
    );
    if (!instances.ok) {
      inventory.failedQueries.push(`instance list ${compartmentId}: ${instances.error}`);
      continue;
    }
    for (const item of ociItems(instances.value)) {
      const parsed = parseInstance(item, compartmentId);
      if (parsed) inventory.instances.push(parsed);
    }

    const volumeSets = inventory.availabilityDomains.length > 0
      ? inventory.availabilityDomains
      : [undefined];
    for (const ad of volumeSets) {
      const bootArgs = ["bv", "boot-volume", "list", "--compartment-id", compartmentId, "--all"];
      const blockArgs = ["bv", "volume", "list", "--compartment-id", compartmentId, "--all"];
      if (ad) {
        bootArgs.push("--availability-domain", ad);
        blockArgs.push("--availability-domain", ad);
      }
      const boots = await readJson(exec(bootArgs, region));
      if (!boots.ok) {
        inventory.failedQueries.push(`boot-volume list ${compartmentId}: ${boots.error}`);
      } else {
        for (const item of ociItems(boots.value)) {
          const parsed = parseVolume(item, compartmentId, "boot");
          if (parsed) inventory.volumes.push(parsed);
        }
      }
      const blocks = await readJson(exec(blockArgs, region));
      if (!blocks.ok) {
        inventory.failedQueries.push(`volume list ${compartmentId}: ${blocks.error}`);
      } else {
        for (const item of ociItems(blocks.value)) {
          const parsed = parseVolume(item, compartmentId, "block");
          if (parsed) inventory.volumes.push(parsed);
        }
      }

      if (ad) {
        const attachments = await readJson(
          exec(
            [
              "compute",
              "boot-volume-attachment",
              "list",
              "--compartment-id",
              compartmentId,
              "--availability-domain",
              ad,
              "--all",
            ],
            region,
          ),
        );
        if (!attachments.ok) {
          attachmentsKnown = false;
        } else {
          for (const item of ociItems(attachments.value)) {
            const volumeId = asString(cliValue(item, "boot_volume_id"));
            const instanceId = asString(cliValue(item, "instance_id"));
            if (volumeId && instanceId) attachmentByVolume.set(volumeId, instanceId);
          }
        }
      }
    }
  }

  if (attachmentByVolume.size > 0) {
    inventory.volumes = inventory.volumes.map((volume) => ({
      ...volume,
      attachedInstanceId: volume.attachedInstanceId ?? attachmentByVolume.get(volume.id),
    }));
  } else if (inventory.volumes.some((volume) => volume.kind === "boot")) {
    attachmentsKnown = attachmentsKnown && inventory.availabilityDomains.length > 0;
  }
  inventory.attachmentsKnown = attachmentsKnown;

  const liveInstances = inventory.instances.filter((instance) => isLiveLifecycle(instance.lifecycleState));
  const a1 = liveInstances.filter((instance) => instance.shape === A1_SHAPE);
  inventory.a1Ocpus = a1.reduce((sum, instance) => sum + instance.ocpus, 0);
  inventory.a1MemoryGb = a1.reduce((sum, instance) => sum + instance.memoryGb, 0);
  inventory.storageGb = inventory.volumes
    .filter((volume) => isLiveLifecycle(volume.lifecycleState))
    .reduce((sum, volume) => sum + volume.sizeGb, 0);

  return inventory;
}

async function listAvailabilityDomains(
  exec: (parts: readonly string[], region?: string) => Promise<CommandResult>,
  tenancyId: string,
  region: string,
): Promise<string[]> {
  const ads = await readJson(
    exec(["iam", "availability-domain", "list", "--compartment-id", tenancyId], region),
  );
  if (!ads.ok) return [];
  return ociItems(ads.value)
    .map((item) => asString(cliValue(item, "name")))
    .filter((name): name is string => Boolean(name));
}

function parseInstance(item: Record<string, unknown>, compartmentId: string): InstanceSummary | undefined {
  const id = asString(cliValue(item, "id"));
  if (!id) return undefined;
  const shapeConfig = asRecord(cliValue(item, "shape_config")) ?? {};
  const tags = asRecord(cliValue(item, "freeform_tags")) ?? {};
  return {
    id,
    displayName: asString(cliValue(item, "display_name")) ?? "",
    shape: asString(cliValue(item, "shape")) ?? "",
    ocpus: asNumber(cliValue(shapeConfig, "ocpus")) ?? 0,
    memoryGb: asNumber(cliValue(shapeConfig, "memory_in_gbs")) ?? 0,
    lifecycleState: asString(cliValue(item, "lifecycle_state")) ?? "",
    availabilityDomain: asString(cliValue(item, "availability_domain")) ?? "",
    compartmentId: asString(cliValue(item, "compartment_id")) ?? compartmentId,
    managedBy: asString(tags["managed-by"] ?? tags.managedBy ?? tags.managed_by),
  };
}

function parseVolume(
  item: Record<string, unknown>,
  compartmentId: string,
  kind: "boot" | "block",
): VolumeSummary | undefined {
  const id = asString(cliValue(item, "id"));
  if (!id) return undefined;
  return {
    id,
    displayName: asString(cliValue(item, "display_name")) ?? "",
    sizeGb: asNumber(cliValue(item, "size_in_gbs")) ?? 0,
    kind,
    lifecycleState: asString(cliValue(item, "lifecycle_state")) ?? "",
    compartmentId: asString(cliValue(item, "compartment_id")) ?? compartmentId,
  };
}

function matchExactInstance(
  instances: InstanceSummary[],
  query: DiscoveryQuery,
  defaultName: string,
): { candidates: InstanceSummary[]; adopted?: InstanceSummary; ambiguous: boolean } {
  const live = instances.filter((instance) => isLiveLifecycle(instance.lifecycleState));
  if (query.instanceId) {
    const hits = live.filter((instance) => instance.id === query.instanceId);
    return { candidates: hits, adopted: hits.length === 1 ? hits[0] : undefined, ambiguous: hits.length > 1 };
  }
  const name = query.displayName ?? defaultName;
  const named = live.filter((instance) => instance.displayName === name);
  const owned = named.filter((instance) => instance.managedBy === MANAGED_BY);
  const pool = owned.length > 0 ? owned : named;
  return {
    candidates: pool,
    adopted: pool.length === 1 ? pool[0] : undefined,
    ambiguous: pool.length > 1,
  };
}

async function buildEligibility(
  discovered: DiscoveryResult,
  request: CreateRequest,
  exec: (parts: readonly string[], region?: string) => Promise<CommandResult>,
): Promise<EligibilityReport> {
  const blockers = [...discovered.blockers];
  const displayName = request.displayName ?? DEFAULT_DISPLAY_NAME;
  const bootVolumeGb = request.bootVolumeGb ?? DEFAULT_BOOT_VOLUME_GB;
  const homeRegion = discovered.account.homeRegion;
  const plannedWrites = plannedWriteList(displayName);

  if (discovered.adopted) {
    return {
      eligible: false,
      blockers: [],
      account: discovered.account,
      inventory: discovered.inventory,
      adopted: discovered.adopted,
      plannedWrites: [],
    };
  }

  if (!discovered.account.authenticated || !discovered.account.tenancyId || !homeRegion) {
    pushBlocker(blockers, {
      code: "permissions",
      message: discovered.account.evidence || "unauthenticated PI_CLOUD security_token session",
    });
  }

  if (request.region && homeRegion && request.region !== homeRegion) {
    pushBlocker(blockers, {
      code: "wrong-home-region",
      message: `requested region ${request.region} is not the tenancy home region ${homeRegion}; Always Free compute exists only in the home region`,
    });
  }

  if (!isOperatorSshCidr(request.publicSshCidr)) {
    pushBlocker(blockers, {
      code: "open-ssh",
      message: "SSH source must be the operator IPv4 /32; 0.0.0.0/0 and other open ranges are refused",
    });
  }

  if (discovered.account.subscriptionAccess !== "ok") {
    pushBlocker(blockers, {
      code: "permissions",
      message: discovered.account.evidence || "OSP Gateway subscription permissions are absent or ambiguous",
    });
  }
  if (discovered.account.billingPlan === "payg") {
    pushBlocker(blockers, {
      code: "payg-plan",
      message: "PAYG subscription cannot be treated as free-only; creation blocked",
    });
  } else if (discovered.account.billingPlan !== "free-tier") {
    pushBlocker(blockers, {
      code: "unknown-plan",
      message: `account family is not an unambiguous FREE_TIER inventory (${discovered.account.evidence})`,
    });
  }

  if (discovered.inventory.failedQueries.length > 0) {
    pushBlocker(blockers, {
      code: "failed-inventory",
      message: `cannot verify whole-tenancy usage: ${discovered.inventory.failedQueries.join("; ")}`,
    });
  }

  if (discovered.inventory.a1Ocpus + A1_OCPUS > A1_OCPUS || discovered.inventory.a1MemoryGb + A1_MEMORY_GB > A1_MEMORY_GB) {
    pushBlocker(blockers, {
      code: "preexisting-a1-usage",
      message: `existing A1 usage ${discovered.inventory.a1Ocpus} OCPU / ${discovered.inventory.a1MemoryGb} GB leaves no room for ${A1_OCPUS} OCPU / ${A1_MEMORY_GB} GB`,
    });
  }

  if (bootVolumeGb < MIN_BOOT_VOLUME_GB) {
    pushBlocker(blockers, {
      code: "boot-size",
      message: `boot volume ${bootVolumeGb} GB is below the documented Always Free minimum of ${MIN_BOOT_VOLUME_GB} GB`,
    });
  }

  const liveVolumes = discovered.inventory.volumes.filter((volume) => isLiveLifecycle(volume.lifecycleState));
  const liveInstanceIds = new Set(
    discovered.inventory.instances
      .filter((instance) => isLiveLifecycle(instance.lifecycleState))
      .map((instance) => instance.id),
  );
  const preserved = liveVolumes.filter((volume) => {
    if (volume.attachedInstanceId) return !liveInstanceIds.has(volume.attachedInstanceId);
    if (!discovered.inventory.attachmentsKnown) return liveInstanceIds.size === 0;
    return true;
  });
  const remainingStorage = ALWAYS_FREE_STORAGE_GB - discovered.inventory.storageGb;
  if (remainingStorage < bootVolumeGb) {
    pushBlocker(blockers, {
      code: preserved.length > 0 ? "preserved-volumes" : "storage-exceeded",
      message: `requested ${bootVolumeGb} GB boot exceeds remaining ${remainingStorage} GB of the 200 GB Always Free aggregate` +
        (preserved.length > 0 ? `; ${preserved.length} preserved volume(s) still consume the allowance` : ""),
    });
  } else if (preserved.length > 0 && !discovered.inventory.attachmentsKnown) {
    pushBlocker(blockers, {
      code: "preserved-volumes",
      message: "preserved or unattached volumes exist and attachment inventory could not be verified",
    });
  }

  if (discovered.account.tenancyId && homeRegion && discovered.inventory.failedQueries.length === 0) {
    const image = await resolveEligibleImage(exec, discovered.account.tenancyId, homeRegion);
    if (!image) {
      pushBlocker(blockers, {
        code: "image-ineligible",
        message: "no permitted Always Free-eligible A1 image could be verified",
      });
    }
    const ownership = await networkOwnershipBlocker(exec, discovered.account.tenancyId, homeRegion, displayName);
    if (ownership) pushBlocker(blockers, ownership);
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    account: discovered.account,
    inventory: discovered.inventory,
    plannedWrites,
    intended: homeRegion
      ? {
          region: homeRegion,
          shape: A1_SHAPE,
          ocpus: A1_OCPUS,
          memoryGb: A1_MEMORY_GB,
          bootVolumeGb,
          sshCidr: request.publicSshCidr,
          displayName,
        }
      : undefined,
  };
}

function plannedWriteList(displayName: string): string[] {
  return [
    `network vcn create ${displayName}-vcn`,
    `network internet-gateway create ${displayName}-igw`,
    "network route-table update",
    `network security-list create ${displayName}-sl`,
    `network nsg create ${displayName}-nsg`,
    "network nsg rules add tcp/22 operator /32",
    `network subnet create ${displayName}-subnet`,
    `compute instance launch ${A1_SHAPE} ${A1_OCPUS} OCPU ${A1_MEMORY_GB} GB`,
  ];
}

function statusForBlockers(blockers: Blocker[]): CreateResult["status"] {
  if (blockers.some((blocker) => blocker.code === "capacity")) return "capacity";
  return "blocked";
}

function pushBlocker(blockers: Blocker[], blocker: Blocker): void {
  if (!blockers.some((existing) => existing.code === blocker.code && existing.message === blocker.message)) {
    blockers.push(blocker);
  }
}

function volumePartials(volumes: VolumeSummary[]): PartialAllocation[] {
  return volumes
    .filter((volume) => isLiveLifecycle(volume.lifecycleState))
    .map((volume) => ({
      kind: volume.kind === "boot" ? "boot-volume" : "block-volume",
      id: volume.id,
      displayName: volume.displayName,
      note: volume.attachedInstanceId ? `attached to ${volume.attachedInstanceId}` : "unattached / preserved",
    }));
}

async function resolveEligibleImage(
  exec: (parts: readonly string[], region?: string) => Promise<CommandResult>,
  tenancyId: string,
  region: string,
): Promise<{ id: string; operatingSystem: string; displayName: string } | undefined> {
  for (const operatingSystem of ["Canonical Ubuntu", "Ubuntu", "Oracle Linux", "Oracle Linux Cloud Developer"]) {
    const listed = await readJson(
      exec(
        [
          "compute",
          "image",
          "list",
          "--compartment-id",
          tenancyId,
          "--operating-system",
          operatingSystem,
          "--shape",
          A1_SHAPE,
          "--sort-by",
          "TIMECREATED",
          "--sort-order",
          "DESC",
        ],
        region,
      ),
    );
    if (!listed.ok) continue;
    for (const item of ociItems(listed.value)) {
      const id = asString(cliValue(item, "id"));
      const os = asString(cliValue(item, "operating_system")) ?? operatingSystem;
      const displayName = asString(cliValue(item, "display_name")) ?? "";
      if (id && isAlwaysFreeEligibleA1Image({ operatingSystem: os, displayName })) {
        return { id, operatingSystem: os, displayName };
      }
    }
  }
  return undefined;
}

async function networkOwnershipBlocker(
  exec: (parts: readonly string[], region?: string) => Promise<CommandResult>,
  tenancyId: string,
  region: string,
  displayName: string,
): Promise<Blocker | undefined> {
  const listed = await readJson(
    exec(
      ["network", "vcn", "list", "--compartment-id", tenancyId, "--display-name", `${displayName}-vcn`, "--all"],
      region,
    ),
  );
  if (!listed.ok) {
    return { code: "failed-inventory", message: `vcn list failed: ${listed.error}` };
  }
  const vcns = ociItems(listed.value).filter((item) => {
    const state = asString(cliValue(item, "lifecycle_state")) ?? "";
    return isLiveLifecycle(state);
  });
  if (vcns.length === 0) return undefined;
  if (vcns.length > 1) {
    return { code: "ownership", message: `multiple VCNs named ${displayName}-vcn; refusing to guess` };
  }
  const tags = asRecord(cliValue(vcns[0], "freeform_tags")) ?? {};
  const managedBy = asString(tags["managed-by"] ?? tags.managedBy ?? tags.managed_by);
  if (managedBy !== MANAGED_BY) {
    return {
      code: "ownership",
      message: `existing VCN ${displayName}-vcn is not tagged managed-by=${MANAGED_BY}`,
    };
  }
  return undefined;
}

async function ensureNetwork(
  exec: (parts: readonly string[], region?: string) => Promise<CommandResult>,
  input: {
    tenancyId: string;
    region: string;
    displayName: string;
    sshCidr: string;
    inventory: InventorySnapshot;
    partial: PartialAllocation[];
  },
): Promise<{ ok: true; vcnId: string; subnetId: string; nsgId: string } | { ok: false; blockers: Blocker[] }> {
  if (!isOperatorSshCidr(input.sshCidr)) {
    return {
      ok: false,
      blockers: [{ code: "open-ssh", message: "refusing to write an open SSH rule" }],
    };
  }

  const vcnName = `${input.displayName}-vcn`;
  const igwName = `${input.displayName}-igw`;
  const slName = `${input.displayName}-sl`;
  const nsgName = `${input.displayName}-nsg`;
  const subnetName = `${input.displayName}-subnet`;
  const tags = JSON.stringify({ "managed-by": MANAGED_BY });

  const existingVcn = await findNamed(
    exec,
    ["network", "vcn", "list", "--compartment-id", input.tenancyId, "--display-name", vcnName, "--all"],
    input.region,
  );
  let vcnId = existingVcn?.id;
  if (existingVcn && existingVcn.managedBy !== MANAGED_BY) {
    return { ok: false, blockers: [{ code: "ownership", message: `will not mutate foreign VCN ${vcnName}` }] };
  }
  if (!vcnId) {
    const created = await readJson(
      exec(
        [
          "network",
          "vcn",
          "create",
          "--compartment-id",
          input.tenancyId,
          "--cidr-blocks",
          JSON.stringify(["10.0.0.0/16"]),
          "--display-name",
          vcnName,
          "--dns-label",
          dnsLabel(input.displayName, "vcn"),
          "--freeform-tags",
          tags,
          "--wait-for-state",
          "AVAILABLE",
        ],
        input.region,
      ),
    );
    vcnId = created.ok ? asString(cliValue(asRecord(unwrapData(created.value)) ?? {}, "id")) : undefined;
    if (!vcnId) {
      return { ok: false, blockers: [{ code: "permissions", message: `vcn create failed: ${created.ok ? "missing id" : created.error}` }] };
    }
    input.partial.push({ kind: "vcn", id: vcnId, displayName: vcnName, note: "created; not auto-destroyed" });
  } else {
    input.partial.push({ kind: "vcn", id: vcnId, displayName: vcnName, note: "reused owned VCN" });
  }

  const existingIgw = await findNamed(
    exec,
    ["network", "internet-gateway", "list", "--compartment-id", input.tenancyId, "--vcn-id", vcnId, "--display-name", igwName, "--all"],
    input.region,
  );
  let igwId = existingIgw?.id;
  if (!igwId) {
    const created = await readJson(
      exec(
        [
          "network",
          "internet-gateway",
          "create",
          "--compartment-id",
          input.tenancyId,
          "--vcn-id",
          vcnId,
          "--is-enabled",
          "true",
          "--display-name",
          igwName,
          "--freeform-tags",
          tags,
          "--wait-for-state",
          "AVAILABLE",
        ],
        input.region,
      ),
    );
    igwId = created.ok ? asString(cliValue(asRecord(unwrapData(created.value)) ?? {}, "id")) : undefined;
    if (!igwId) {
      return { ok: false, blockers: [{ code: "permissions", message: `internet-gateway create failed: ${created.ok ? "missing id" : created.error}` }] };
    }
    input.partial.push({ kind: "internet-gateway", id: igwId, displayName: igwName, note: "created; not auto-destroyed" });
  }

  const vcn = await readJson(exec(["network", "vcn", "get", "--vcn-id", vcnId], input.region));
  const defaultRt = vcn.ok ? asString(cliValue(asRecord(unwrapData(vcn.value)) ?? {}, "default_route_table_id")) : undefined;
  if (defaultRt && igwId) {
    await readJson(
      exec(
        [
          "network",
          "route-table",
          "update",
          "--rt-id",
          defaultRt,
          "--route-rules",
          JSON.stringify([{ cidrBlock: "0.0.0.0/0", networkEntityId: igwId, description: "internet via IGW" }]),
          "--force",
        ],
        input.region,
      ),
    );
  }

  const existingSl = await findNamed(
    exec,
    ["network", "security-list", "list", "--compartment-id", input.tenancyId, "--vcn-id", vcnId, "--display-name", slName, "--all"],
    input.region,
  );
  let slId = existingSl?.id;
  if (!slId) {
    const created = await readJson(
      exec(
        [
          "network",
          "security-list",
          "create",
          "--compartment-id",
          input.tenancyId,
          "--vcn-id",
          vcnId,
          "--display-name",
          slName,
          "--egress-security-rules",
          JSON.stringify([{ destination: "0.0.0.0/0", protocol: "all", isStateless: false, description: "all outbound" }]),
          "--ingress-security-rules",
          "[]",
          "--freeform-tags",
          tags,
          "--wait-for-state",
          "AVAILABLE",
        ],
        input.region,
      ),
    );
    slId = created.ok ? asString(cliValue(asRecord(unwrapData(created.value)) ?? {}, "id")) : undefined;
    if (!slId) {
      return { ok: false, blockers: [{ code: "permissions", message: `security-list create failed: ${created.ok ? "missing id" : created.error}` }] };
    }
    input.partial.push({ kind: "security-list", id: slId, displayName: slName, note: "egress only; no ingress" });
  }

  const existingNsg = await findNamed(
    exec,
    ["network", "nsg", "list", "--compartment-id", input.tenancyId, "--vcn-id", vcnId, "--display-name", nsgName, "--all"],
    input.region,
  );
  let nsgId = existingNsg?.id;
  if (!nsgId) {
    const created = await readJson(
      exec(
        [
          "network",
          "nsg",
          "create",
          "--compartment-id",
          input.tenancyId,
          "--vcn-id",
          vcnId,
          "--display-name",
          nsgName,
          "--freeform-tags",
          tags,
        ],
        input.region,
      ),
    );
    nsgId = created.ok ? asString(cliValue(asRecord(unwrapData(created.value)) ?? {}, "id")) : undefined;
    if (!nsgId) {
      return { ok: false, blockers: [{ code: "permissions", message: `nsg create failed: ${created.ok ? "missing id" : created.error}` }] };
    }
    input.partial.push({ kind: "nsg", id: nsgId, displayName: nsgName, note: "created; not auto-destroyed" });
  }

  const rules = await readJson(exec(["network", "nsg", "rules", "list", "--nsg-id", nsgId], input.region));
  const haveSsh = rules.ok
    && ociItems(rules.value).some((rule) => asString(cliValue(rule, "source")) === input.sshCidr);
  if (!haveSsh) {
    const added = await readJson(
      exec(
        [
          "network",
          "nsg",
          "rules",
          "add",
          "--nsg-id",
          nsgId,
          "--security-rules",
          JSON.stringify([
            {
              direction: "INGRESS",
              protocol: "6",
              source: input.sshCidr,
              sourceType: "CIDR_BLOCK",
              isStateless: false,
              tcpOptions: { destinationPortRange: { min: 22, max: 22 } },
              description: "pi-cloud: bootstrap SSH /32",
            },
          ]),
        ],
        input.region,
      ),
    );
    if (!added.ok) {
      return { ok: false, blockers: [{ code: "permissions", message: `nsg rules add failed: ${added.error}` }] };
    }
  }

  const existingSubnet = await findNamed(
    exec,
    ["network", "subnet", "list", "--compartment-id", input.tenancyId, "--vcn-id", vcnId, "--display-name", subnetName, "--all"],
    input.region,
  );
  let subnetId = existingSubnet?.id;
  if (!subnetId) {
    const created = await readJson(
      exec(
        [
          "network",
          "subnet",
          "create",
          "--compartment-id",
          input.tenancyId,
          "--vcn-id",
          vcnId,
          "--cidr-block",
          "10.0.0.0/24",
          "--display-name",
          subnetName,
          "--dns-label",
          dnsLabel(input.displayName, "sub"),
          "--security-list-ids",
          JSON.stringify([slId]),
          "--freeform-tags",
          tags,
          "--wait-for-state",
          "AVAILABLE",
        ],
        input.region,
      ),
    );
    subnetId = created.ok ? asString(cliValue(asRecord(unwrapData(created.value)) ?? {}, "id")) : undefined;
    if (!subnetId) {
      return { ok: false, blockers: [{ code: "permissions", message: `subnet create failed: ${created.ok ? "missing id" : created.error}` }] };
    }
    input.partial.push({ kind: "subnet", id: subnetId, displayName: subnetName, note: "created; not auto-destroyed" });
  }

  return { ok: true, vcnId, subnetId, nsgId };
}

async function launchInstance(
  exec: (parts: readonly string[], region?: string) => Promise<CommandResult>,
  input: {
    tenancyId: string;
    region: string;
    availabilityDomain: string;
    displayName: string;
    subnetId: string;
    nsgId: string;
    imageId: string;
    bootVolumeGb: number;
    sshPublicKey: string;
  },
): Promise<{ instance?: InstanceSummary; capacity: boolean; message: string }> {
  const launched = await readJson(
    exec(
      [
        "compute",
        "instance",
        "launch",
        "--compartment-id",
        input.tenancyId,
        "--availability-domain",
        input.availabilityDomain,
        "--shape",
        A1_SHAPE,
        "--shape-config",
        JSON.stringify({ ocpus: A1_OCPUS, memoryInGBs: A1_MEMORY_GB }),
        "--image-id",
        input.imageId,
        "--subnet-id",
        input.subnetId,
        "--nsg-ids",
        JSON.stringify([input.nsgId]),
        "--assign-public-ip",
        "true",
        "--display-name",
        input.displayName,
        "--hostname-label",
        hostnameLabel(input.displayName),
        "--boot-volume-size-in-gbs",
        String(input.bootVolumeGb),
        "--metadata",
        JSON.stringify({ ssh_authorized_keys: input.sshPublicKey }),
        "--freeform-tags",
        JSON.stringify({ "managed-by": MANAGED_BY }),
        "--wait-for-state",
        "RUNNING",
      ],
      input.region,
    ),
  );
  if (launched.ok) {
    const raw = asRecord(unwrapData(launched.value)) ?? {};
    const parsed = parseInstance(raw, input.tenancyId);
    if (parsed) return { instance: parsed, capacity: false, message: "launched" };
    return { capacity: false, message: "instance launch returned no instance id" };
  }
  if (isCapacityError(launched.error)) {
    return { capacity: true, message: launched.error };
  }
  return { capacity: false, message: launched.error };
}

function isCapacityError(message: string): boolean {
  return /outofhostcapacity|out of host capacity/i.test(message);
}

async function findNamed(
  exec: (parts: readonly string[], region?: string) => Promise<CommandResult>,
  parts: readonly string[],
  region: string,
): Promise<{ id: string; managedBy?: string } | undefined> {
  const listed = await readJson(exec(parts, region));
  if (!listed.ok) return undefined;
  const live = ociItems(listed.value).filter((item) => isLiveLifecycle(asString(cliValue(item, "lifecycle_state")) ?? "AVAILABLE"));
  if (live.length !== 1) return undefined;
  const tags = asRecord(cliValue(live[0], "freeform_tags")) ?? {};
  return {
    id: asString(cliValue(live[0], "id")) ?? "",
    managedBy: asString(tags["managed-by"] ?? tags.managedBy ?? tags.managed_by),
  };
}

function dnsLabel(displayName: string, suffix: string): string {
  const base = displayName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "picloud";
  return `${base}${suffix}`.slice(0, 15);
}

function hostnameLabel(displayName: string): string {
  return displayName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 15) || "pi-cloud";
}

async function readJson(resultPromise: Promise<CommandResult>): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const result = await resultPromise;
  if (result.code !== 0) {
    return { ok: false, error: compactError(result.stderr || result.stdout || `exit ${result.code}`) };
  }
  const text = result.stdout.trim();
  if (!text) return { ok: false, error: "empty CLI stdout" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON from CLI" };
  }
}

function compactError(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function ociItems(payload: unknown): Array<Record<string, unknown>> {
  const root = unwrapData(payload);
  if (Array.isArray(root)) return root.filter(isRecord);
  if (isRecord(root) && Array.isArray(root.items)) return root.items.filter(isRecord);
  if (isRecord(root) && Array.isArray(root.data)) return root.data.filter(isRecord);
  if (isRecord(root) && isRecord(root.data) && Array.isArray(root.data.items)) {
    return root.data.items.filter(isRecord);
  }
  return [];
}

function unwrapData(payload: unknown): unknown {
  return isRecord(payload) && "data" in payload ? payload.data : payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
