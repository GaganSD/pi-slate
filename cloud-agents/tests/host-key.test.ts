import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CLOUD_INIT_CONSOLE_HISTORY_SOURCE,
  consoleHistoryLooksLikeSerialService,
  enrollGuestSshHostKey,
  extractGuestSshHostKeys,
  preferGuestSshHostKey,
} from "../src/host-key.ts";
import { createRemoteTransport, type RemoteHost } from "../src/remote.ts";
import { type CommandResult, type CommandRunner } from "../src/oci.ts";
import { CLOUD_INIT_CONSOLE, GUEST_SSH_HOST_KEY } from "./fixtures.ts";

const HOST_KEY = GUEST_SSH_HOST_KEY;

const SERIAL_ONLY = `
Starting serial-console service
instance-console-connection listening
ecdsa-sha2-nistp256 AAAASerialConsoleServiceKeyNotGuest
`;

function ok(data: unknown): CommandResult {
  return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
}

function fail(message: string): CommandResult {
  return { code: 1, stdout: "", stderr: message };
}

test("extracts guest sshd keys from the cloud-init HOST KEY KEYS block only", () => {
  const keys = extractGuestSshHostKeys(CLOUD_INIT_CONSOLE);
  assert.equal(keys.some((key) => key.startsWith(HOST_KEY)), true);
  assert.equal(preferGuestSshHostKey(keys)?.startsWith("ssh-ed25519 "), true);
  assert.deepEqual(extractGuestSshHostKeys("SHA256:abcdef"), []);
  assert.deepEqual(extractGuestSshHostKeys(SERIAL_ONLY), []);
  assert.equal(consoleHistoryLooksLikeSerialService(SERIAL_ONLY), true);
  assert.equal(consoleHistoryLooksLikeSerialService(CLOUD_INIT_CONSOLE), false);
});

test("enrolls a stored guest key without SSH or console capture", async () => {
  const knownHostsDir = await mkdtemp(join(tmpdir(), "pi-cloud-hk-"));
  const log: string[][] = [];
  const run: CommandRunner = async (argv) => {
    log.push([...argv]);
    return fail("no commands expected");
  };
  const remote = createRemoteTransport({ run, knownHostsDir });
  const host: RemoteHost = {
    id: "inst-adoptme0001",
    address: "203.0.113.10",
    user: "ubuntu",
    expectedHostKey: HOST_KEY,
  };
  const pinned = await enrollGuestSshHostKey({
    run,
    remote,
    instanceId: "ocid1.instance.oc1..adoptme",
    compartmentId: "ocid1.tenancy.oc1..aaaa",
    host,
    confirmCapture: async () => {
      throw new Error("capture should not run");
    },
  });
  assert.equal(pinned.ok, true);
  if (pinned.ok) {
    assert.equal(pinned.pinned.source, "cloud-init-console-history");
    assert.equal(pinned.pinned.host.expectedHostKey, HOST_KEY);
  }
  assert.equal(log.length, 0);
});

test("refuses serial-console-only history and does not SSH", async () => {
  const knownHostsDir = await mkdtemp(join(tmpdir(), "pi-cloud-hk-"));
  const log: string[][] = [];
  const run: CommandRunner = async (argv) => {
    log.push([...argv]);
    assert.equal(argv[0], "oci");
    assert.equal(argv.includes("accept-new"), false);
    if (argv.includes("console-history") && argv.includes("list")) {
      return ok([{ id: "ocid1.consolehistory.oc1..ch", "lifecycle-state": "SUCCEEDED" }]);
    }
    if (argv.includes("get-content")) {
      const file = argv[argv.indexOf("--file") + 1];
      const { writeFile } = await import("node:fs/promises");
      await writeFile(file, SERIAL_ONLY);
      return { code: 0, stdout: "", stderr: "" };
    }
    return fail(`unexpected: ${argv.join(" ")}`);
  };
  const remote = createRemoteTransport({ run, knownHostsDir });
  const result = await enrollGuestSshHostKey({
    run,
    remote,
    instanceId: "ocid1.instance.oc1..adoptme",
    compartmentId: "ocid1.tenancy.oc1..aaaa",
    host: { id: "inst-adoptme0001", address: "203.0.113.10", user: "ubuntu" },
    confirmCapture: async () => false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.blockers.some((blocker) => blocker.code === "missing-host-key"), true);
  }
  assert.equal(log.some((argv) => argv[0] === "ssh"), false);
  assert.equal(log.some((argv) => argv.includes("capture")), false);
});

test("unconfirmed capture stays blocked and never uses accept-new", async () => {
  const knownHostsDir = await mkdtemp(join(tmpdir(), "pi-cloud-hk-"));
  const log: string[][] = [];
  const run: CommandRunner = async (argv) => {
    log.push([...argv]);
    if (argv.includes("console-history") && argv.includes("list")) return ok([]);
    return fail(`unexpected: ${argv.join(" ")}`);
  };
  const remote = createRemoteTransport({ run, knownHostsDir });
  const result = await enrollGuestSshHostKey({
    run,
    remote,
    instanceId: "ocid1.instance.oc1..adoptme",
    compartmentId: "ocid1.tenancy.oc1..aaaa",
    host: { id: "inst-adoptme0001", address: "203.0.113.10", user: "ubuntu" },
    confirmCapture: async () => false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.blockers[0]?.message ?? "", /console history/i);
  }
  assert.equal(log.some((argv) => argv[0] === "ssh"), false);
  assert.equal(log.some((argv) => argv.includes("accept-new")), false);
  assert.equal(CLOUD_INIT_CONSOLE_HISTORY_SOURCE.includes("cloud-init"), true);
});
