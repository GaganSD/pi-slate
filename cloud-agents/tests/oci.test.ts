import assert from "node:assert/strict";
import test from "node:test";
import {
  A1_MEMORY_GB,
  A1_OCPUS,
  A1_SHAPE,
  ALWAYS_FREE_BACKUP_SLOTS,
  ALWAYS_FREE_STORAGE_GB,
  DEFAULT_BOOT_VOLUME_GB,
  DEFAULT_DISPLAY_NAME,
  MANAGED_BY,
  MAX_CAPACITY_ATTEMPTS,
  MIN_BOOT_VOLUME_GB,
  OCI_AUTH,
  OCI_PROFILE,
  classifySubscriptions,
  createOciProvider,
  isAlwaysFreeEligibleA1Image,
  isAvailablePlatformImage,
  isForbiddenSshCidr,
  isMutatingArgv,
  isOperatorSshCidr,
  type CommandResult,
  type CommandRunner,
  type CreateRequest,
} from "../src/oci.ts";

const TENANCY = "ocid1.tenancy.oc1..aaaa";
const HOME = "eu-frankfurt-1";
const AD = "eu-frankfurt-1-ad-1";
const IMAGE = "ocid1.image.oc1..ubuntu";
const SSH_CIDR = "203.0.113.10/32";
const SSH_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest pi-cloud-test";

type Parsed = {
  tokens: string[];
  flags: Record<string, string[]>;
};

type Handlers = Record<string, (parsed: Parsed) => CommandResult>;

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
  return ok([
    { "is-home-region": false, "region-name": "us-ashburn-1", "tenancy-id": TENANCY },
    { "is-home-region": true, "region-name": HOME, "tenancy-id": TENANCY },
  ]);
}

function subscriptions(planType: string | undefined, extra: Array<Record<string, unknown>> = []): CommandResult {
  const items = [
    ...(planType === undefined ? [{ id: "sub-1" }] : [{ id: "sub-1", "plan-type": planType }]),
    ...extra,
  ];
  return ok({ items });
}

function baseHandlers(overrides: Handlers = {}): Handlers {
  return {
    "iam region-subscription list": () => regionSubscriptions(),
    "osp-gateway subscription-service subscription list": () => subscriptions("FREE_TIER"),
    "iam compartment list": () => ok([]),
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
    "bv backup list": () => fail("backup inventory must not be queried"),
    "bv boot-volume-backup list": () => fail("backup inventory must not be queried"),
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
    ...overrides,
  };
}

function fakeRunner(overrides: Handlers = {}, log: string[][] = []): CommandRunner {
  const handlers = baseHandlers(overrides);
  return async (argv) => {
    log.push([...argv]);
    assert.equal(argv[0], "oci");
    assert.equal(argv[1], "--profile");
    assert.equal(argv[2], OCI_PROFILE);
    assert.equal(argv[3], "--auth");
    assert.equal(argv[4], OCI_AUTH);
    assert.equal(argv.includes("--output"), true);
    const parsed = parseArgv(argv);
    const key = parsed.tokens.join(" ");
    const handler = handlers[key];
    if (!handler) return fail(`unexpected command: ${key}`);
    return handler(parsed);
  };
}

function request(overrides: Partial<CreateRequest> = {}): CreateRequest {
  return {
    publicSshCidr: SSH_CIDR,
    sshPublicKey: SSH_KEY,
    ...overrides,
  };
}

function liveA1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ocid1.instance.oc1..existing",
    "display-name": "other-a1",
    shape: A1_SHAPE,
    "shape-config": { ocpus: A1_OCPUS, "memory-in-gbs": A1_MEMORY_GB },
    "lifecycle-state": "RUNNING",
    "availability-domain": AD,
    "compartment-id": TENANCY,
    "freeform-tags": {},
    ...overrides,
  };
}

test("classifySubscriptions accepts only an unambiguous FREE_TIER inventory", () => {
  assert.equal(classifySubscriptions([{ "plan-type": "FREE_TIER" }]).plan, "free-tier");
  assert.equal(classifySubscriptions([{ planType: "PAYG" }]).plan, "payg");
  assert.equal(classifySubscriptions([{ "plan-type": "FREE_TIER" }, { "plan-type": "PAYG" }]).plan, "unknown");
  assert.equal(classifySubscriptions([{ id: "missing" }]).plan, "unknown");
  assert.equal(classifySubscriptions([]).plan, "unknown");
});

test("SSH helpers refuse open ranges and accept operator /32", () => {
  assert.equal(isForbiddenSshCidr("0.0.0.0/0"), true);
  assert.equal(isForbiddenSshCidr("::/0"), true);
  assert.equal(isOperatorSshCidr("0.0.0.0/0"), false);
  assert.equal(isOperatorSshCidr("203.0.113.10/24"), false);
  assert.equal(isOperatorSshCidr(SSH_CIDR), true);
});

test("Always Free A1 image allowlist matches official families only", () => {
  assert.equal(isAlwaysFreeEligibleA1Image({ operatingSystem: "Canonical Ubuntu" }), true);
  assert.equal(isAlwaysFreeEligibleA1Image({ operatingSystem: "Oracle Linux" }), true);
  assert.equal(isAlwaysFreeEligibleA1Image({ operatingSystem: "Windows" }), false);
  assert.equal(isAlwaysFreeEligibleA1Image({ operatingSystem: "CentOS" }), false);
});

test("preflight uses PI_CLOUD security_token and never mutates", async () => {
  const log: string[][] = [];
  const provider = createOciProvider({ run: fakeRunner({}, log) });
  const account = await provider.preflight();
  assert.equal(account.authenticated, true);
  assert.equal(account.tenancyId, TENANCY);
  assert.equal(account.homeRegion, HOME);
  assert.equal(account.billingPlan, "free-tier");
  assert.equal(log.length > 0, true);
  for (const argv of log) {
    assert.equal(isMutatingArgv(argv), false, argv.join(" "));
    assert.equal(argv.includes(OCI_PROFILE), true);
    assert.equal(argv.includes(OCI_AUTH), true);
  }
  assert.equal(
    log.some((argv) => argv.includes("osp-gateway") && argv.includes("subscription-service")),
    true,
  );
});

test("wrong home region blocks create and issues no writes", async () => {
  const log: string[][] = [];
  const provider = createOciProvider({ run: fakeRunner({}, log) });
  const result = await provider.create(request({ region: "us-ashburn-1", confirm: async () => true }));
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers.some((blocker) => blocker.code === "wrong-home-region"), true);
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
});

test("PAYG plan blocks create", async () => {
  const provider = createOciProvider({
    run: fakeRunner({
      "osp-gateway subscription-service subscription list": () => subscriptions("PAYG"),
    }),
  });
  const report = await provider.evaluateCreate(request());
  assert.equal(report.eligible, false);
  assert.equal(report.blockers.some((blocker) => blocker.code === "payg-plan"), true);
  const created = await provider.create(request({ confirm: async () => true }));
  assert.equal(created.status, "blocked");
  assert.equal(created.blockers.some((blocker) => blocker.code === "payg-plan"), true);
});

test("unknown or mixed plan blocks create", async () => {
  const unknownProvider = createOciProvider({
    run: fakeRunner({
      "osp-gateway subscription-service subscription list": () => subscriptions(undefined),
    }),
  });
  const unknown = await unknownProvider.evaluateCreate(request());
  assert.equal(unknown.blockers.some((blocker) => blocker.code === "unknown-plan"), true);

  const mixedProvider = createOciProvider({
    run: fakeRunner({
      "osp-gateway subscription-service subscription list": () =>
        subscriptions("FREE_TIER", [{ id: "sub-2", "plan-type": "PAYG" }]),
    }),
  });
  const mixed = await mixedProvider.evaluateCreate(request());
  assert.equal(mixed.account.billingPlan, "unknown");
  assert.equal(mixed.blockers.some((blocker) => blocker.code === "unknown-plan"), true);

  const failedProvider = createOciProvider({
    run: fakeRunner({
      "osp-gateway subscription-service subscription list": () => fail("Authorization failed or requested resource not found"),
    }),
  });
  const failed = await failedProvider.evaluateCreate(request());
  assert.equal(failed.account.billingPlan, "unknown");
  assert.equal(failed.blockers.some((blocker) => blocker.code === "unknown-plan"), true);
});

test("preexisting A1 usage blocks another 2 OCPU / 12 GB create", async () => {
  const provider = createOciProvider({
    run: fakeRunner({
      "compute instance list": () => ok([liveA1()]),
    }),
  });
  const report = await provider.evaluateCreate(request());
  assert.equal(report.eligible, false);
  assert.equal(report.blockers.some((blocker) => blocker.code === "preexisting-a1-usage"), true);
  assert.match(report.blockers.find((blocker) => blocker.code === "preexisting-a1-usage")?.message ?? "", /2 OCPU/);
});

test("preserved volumes that exhaust the 200 GB aggregate block create", async () => {
  const provider = createOciProvider({
    run: fakeRunner({
      "bv boot-volume list": () =>
        ok([
          {
            id: "ocid1.bootvolume.oc1..preserved",
            "display-name": "left-behind",
            "size-in-gbs": ALWAYS_FREE_STORAGE_GB - 10,
            "lifecycle-state": "AVAILABLE",
            "compartment-id": TENANCY,
          },
        ]),
    }),
  });
  const report = await provider.evaluateCreate(request({ bootVolumeGb: DEFAULT_BOOT_VOLUME_GB }));
  assert.equal(report.eligible, false);
  assert.equal(report.blockers.some((blocker) => blocker.code === "preserved-volumes"), true);
  assert.equal(report.inventory.storageGb, ALWAYS_FREE_STORAGE_GB - 10);
});

test("failed inventory blocks create", async () => {
  const provider = createOciProvider({
    run: fakeRunner({
      "compute instance list": () => fail("NotAuthorizedOrNotFound"),
    }),
  });
  const report = await provider.evaluateCreate(request());
  assert.equal(report.eligible, false);
  assert.equal(report.blockers.some((blocker) => blocker.code === "failed-inventory"), true);
});

test("open SSH CIDR blocks create and never writes 0.0.0.0/0", async () => {
  const log: string[][] = [];
  const provider = createOciProvider({ run: fakeRunner({}, log) });
  const result = await provider.create(request({ publicSshCidr: "0.0.0.0/0", confirm: async () => true }));
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers.some((blocker) => blocker.code === "open-ssh"), true);
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
  assert.equal(
    log.some((argv) => argv.includes("0.0.0.0/0") && argv.includes("nsg")),
    false,
  );
});

test("capacity failure is bounded, surfaces partial network, and has no paid fallback", async () => {
  const log: string[][] = [];
  let launches = 0;
  const provider = createOciProvider({
    capacityRetryDelayMs: 0,
    run: fakeRunner(
      {
        "compute instance launch": () => {
          launches += 1;
          return fail("OutOfHostCapacity: out of host capacity for shape VM.Standard.A1.Flex");
        },
      },
      log,
    ),
  });
  const result = await provider.create(request({ confirm: async () => true }));
  assert.equal(result.status, "capacity");
  assert.equal(result.attempts, MAX_CAPACITY_ATTEMPTS);
  assert.equal(launches, MAX_CAPACITY_ATTEMPTS);
  assert.equal(result.blockers.some((blocker) => blocker.code === "capacity"), true);
  assert.match(result.blockers[0]?.message ?? "", /no paid fallback/);
  assert.equal(result.partial.some((item) => item.kind === "vcn"), true);
  assert.equal(
    log.some((argv) => argv.includes("launch") && argv.includes("VM.Standard.E4.Flex")),
    false,
  );
  assert.equal(
    log.filter((argv) => argv.includes("instance") && argv.includes("launch")).length,
    MAX_CAPACITY_ATTEMPTS,
  );
  assert.equal(log.some((argv) => argv.includes("terminate") || argv.includes("delete")), false);
});

test("exact instance id is adopted without writes", async () => {
  const log: string[][] = [];
  const existing = liveA1({
    id: "ocid1.instance.oc1..keep",
    "display-name": DEFAULT_DISPLAY_NAME,
    "freeform-tags": { "managed-by": MANAGED_BY },
  });
  const provider = createOciProvider({
    run: fakeRunner(
      {
        "compute instance list": () => ok([existing]),
      },
      log,
    ),
  });
  const result = await provider.create(
    request({ instanceId: "ocid1.instance.oc1..keep", confirm: async () => true }),
  );
  assert.equal(result.status, "adopted");
  assert.equal(result.instance?.id, "ocid1.instance.oc1..keep");
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
});

test("FREE_TIER alone does not authorize create without confirmation", async () => {
  const log: string[][] = [];
  const provider = createOciProvider({ run: fakeRunner({}, log) });
  const report = await provider.evaluateCreate(request());
  assert.equal(report.eligible, true);
  assert.equal(report.intended?.imageId, IMAGE);
  assert.equal(report.intended?.imageName, "Canonical-Ubuntu-22.04");
  assert.equal(report.image?.id, IMAGE);
  const result = await provider.create(request());
  assert.equal(result.status, "unconfirmed");
  assert.equal(result.blockers.some((blocker) => blocker.code === "unconfirmed-write"), true);
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
});

test("confirmed free-tier create launches home-region A1 2/12 with /32 SSH", async () => {
  const log: string[][] = [];
  const provider = createOciProvider({ run: fakeRunner({}, log) });
  const result = await provider.create(request({ confirm: async () => true }));
  assert.equal(result.status, "created");
  assert.equal(result.instance?.shape, A1_SHAPE);
  const launch = log.find((argv) => argv.includes("instance") && argv.includes("launch"));
  assert.ok(launch);
  assert.equal(launch.includes(HOME), true);
  assert.equal(launch.includes(A1_SHAPE), true);
  assert.equal(launch.some((part) => part.includes(`"ocpus":${A1_OCPUS}`) || part.includes(`"ocpus": ${A1_OCPUS}`)), true);
  assert.equal(launch.includes(String(DEFAULT_BOOT_VOLUME_GB)), true);
  const nsgAdd = log.find((argv) => argv.includes("nsg") && argv.includes("add"));
  assert.ok(nsgAdd);
  assert.equal(nsgAdd.some((part) => part.includes(SSH_CIDR)), true);
  assert.equal(nsgAdd.some((part) => part.includes("0.0.0.0/0")), false);
  assert.equal(launch.includes(IMAGE), true);
});

test("only AVAILABLE platform images with compartment-id null are eligible", () => {
  assert.equal(
    isAvailablePlatformImage({
      "compartment-id": null,
      "lifecycle-state": "AVAILABLE",
    }),
    true,
  );
  assert.equal(
    isAvailablePlatformImage({
      "lifecycle-state": "AVAILABLE",
      "operating-system": "Canonical Ubuntu",
    }),
    false,
  );
  assert.equal(
    isAvailablePlatformImage({
      "compartment-id": TENANCY,
      "lifecycle-state": "AVAILABLE",
    }),
    false,
  );
});

test("custom or unmarked images block create", async () => {
  const custom = createOciProvider({
    run: fakeRunner({
      "compute image list": () =>
        ok([
          {
            id: "ocid1.image.oc1..custom",
            "operating-system": "Canonical Ubuntu",
            "display-name": "my-custom-ubuntu",
            "compartment-id": TENANCY,
            "lifecycle-state": "AVAILABLE",
          },
        ]),
    }),
  });
  const customReport = await custom.evaluateCreate(request());
  assert.equal(customReport.eligible, false);
  assert.equal(customReport.blockers.some((blocker) => blocker.code === "image-ineligible"), true);

  const unmarked = createOciProvider({
    run: fakeRunner({
      "compute image list": () =>
        ok([
          {
            id: "ocid1.image.oc1..unknown",
            "operating-system": "Canonical Ubuntu",
            "display-name": "Canonical-Ubuntu-22.04",
            "lifecycle-state": "AVAILABLE",
          },
        ]),
    }),
  });
  const unmarkedReport = await unmarked.evaluateCreate(request());
  assert.equal(unmarkedReport.eligible, false);
  assert.match(unmarkedReport.blockers.find((blocker) => blocker.code === "image-ineligible")?.message ?? "", /compartment-id key missing/);
});

test("boot volume below 50 GB is rejected before network writes", async () => {
  const log: string[][] = [];
  const provider = createOciProvider({ run: fakeRunner({}, log) });
  const result = await provider.create(request({ bootVolumeGb: MIN_BOOT_VOLUME_GB - 1, confirm: async () => true }));
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers.some((blocker) => blocker.code === "boot-size"), true);
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
});

test("failed network lookup does not create a duplicate", async () => {
  const log: string[][] = [];
  const provider = createOciProvider({
    run: fakeRunner(
      {
        "network vcn list": () => fail("NotAuthorizedOrNotFound"),
      },
      log,
    ),
  });
  const result = await provider.create(request({ confirm: async () => true }));
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers.some((blocker) => blocker.code === "failed-inventory"), true);
  assert.equal(log.some((argv) => argv.includes("vcn") && argv.includes("create")), false);
});

test("foreign NSG on an owned VCN is refused", async () => {
  const log: string[][] = [];
  const provider = createOciProvider({
    run: fakeRunner(
      {
        "network vcn list": () =>
          ok([
            {
              id: "ocid1.vcn.oc1..vcn",
              "display-name": `${DEFAULT_DISPLAY_NAME}-vcn`,
              "lifecycle-state": "AVAILABLE",
              "freeform-tags": { "managed-by": MANAGED_BY },
            },
          ]),
        "network nsg list": () =>
          ok([
            {
              id: "ocid1.networksecuritygroup.oc1..foreign",
              "display-name": `${DEFAULT_DISPLAY_NAME}-nsg`,
              "lifecycle-state": "AVAILABLE",
              "freeform-tags": { "managed-by": "someone-else" },
            },
          ]),
      },
      log,
    ),
  });
  const result = await provider.create(request({ confirm: async () => true }));
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers.some((blocker) => blocker.code === "ownership"), true);
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
});

test("route-table update failure keeps partial network and does not launch", async () => {
  const log: string[][] = [];
  const provider = createOciProvider({
    run: fakeRunner(
      {
        "network route-table update": () => fail("NotAuthorized"),
      },
      log,
    ),
  });
  const result = await provider.create(request({ confirm: async () => true }));
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers.some((blocker) => blocker.code === "permissions"), true);
  assert.equal(result.partial.some((item) => item.kind === "vcn"), true);
  assert.equal(log.some((argv) => argv.includes("instance") && argv.includes("launch")), false);
});

test("200 GB aggregate is boot+block only; backups are a separate five-slot allowance", async () => {
  assert.equal(ALWAYS_FREE_BACKUP_SLOTS, 5);
  const log: string[][] = [];
  const provider = createOciProvider({ run: fakeRunner({}, log) });
  const report = await provider.evaluateCreate(request());
  assert.equal(report.inventory.storageGb, 0);
  assert.equal(log.some((argv) => argv.includes("backup")), false);
});

test("plan flip after confirm blocks create with zero writes", async () => {
  const log: string[][] = [];
  let afterConfirm = false;
  const provider = createOciProvider({
    run: fakeRunner(
      {
        "osp-gateway subscription-service subscription list": () =>
          subscriptions(afterConfirm ? "PAYG" : "FREE_TIER"),
      },
      log,
    ),
  });
  const result = await provider.create(
    request({
      confirm: async () => {
        afterConfirm = true;
        return true;
      },
    }),
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers.some((blocker) => blocker.code === "payg-plan"), true);
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
});

test("A1 inventory change after confirm blocks create with zero writes", async () => {
  const log: string[][] = [];
  let afterConfirm = false;
  const provider = createOciProvider({
    run: fakeRunner(
      {
        "compute instance list": () => ok(afterConfirm ? [liveA1()] : []),
      },
      log,
    ),
  });
  const result = await provider.create(
    request({
      confirm: async () => {
        afterConfirm = true;
        return true;
      },
    }),
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers.some((blocker) => blocker.code === "preexisting-a1-usage"), true);
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
});

test("selected image change after confirm does not switch images or write", async () => {
  const log: string[][] = [];
  let afterConfirm = false;
  const provider = createOciProvider({
    run: fakeRunner(
      {
        "compute image list": () =>
          ok([
            {
              id: afterConfirm ? "ocid1.image.oc1..other" : IMAGE,
              "operating-system": "Canonical Ubuntu",
              "display-name": afterConfirm ? "Canonical-Ubuntu-24.04" : "Canonical-Ubuntu-22.04",
              "compartment-id": null,
              "lifecycle-state": "AVAILABLE",
            },
          ]),
      },
      log,
    ),
  });
  const result = await provider.create(
    request({
      confirm: async () => {
        afterConfirm = true;
        return true;
      },
    }),
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers.some((blocker) => blocker.code === "stale-eligibility"), true);
  assert.match(result.blockers[0]?.message ?? "", /imageId/);
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
  assert.equal(log.some((argv) => argv.includes("ocid1.image.oc1..other") && argv.includes("launch")), false);
});

test("instance appearing after confirm must be adopted on a separate run", async () => {
  const log: string[][] = [];
  let afterConfirm = false;
  const provider = createOciProvider({
    run: fakeRunner(
      {
        "compute instance list": () =>
          ok(
            afterConfirm
              ? [
                  liveA1({
                    id: "ocid1.instance.oc1..new",
                    "display-name": DEFAULT_DISPLAY_NAME,
                    "freeform-tags": { "managed-by": MANAGED_BY },
                  }),
                ]
              : [],
          ),
      },
      log,
    ),
  });
  const result = await provider.create(
    request({
      confirm: async () => {
        afterConfirm = true;
        return true;
      },
    }),
  );
  assert.equal(result.status, "blocked");
  assert.notEqual(result.status, "adopted");
  assert.equal(result.blockers.some((blocker) => blocker.code === "stale-eligibility"), true);
  assert.match(result.blockers[0]?.message ?? "", /separate run/);
  assert.equal(log.some((argv) => isMutatingArgv(argv)), false);
});
