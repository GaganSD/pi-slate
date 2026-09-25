import assert from "node:assert/strict";
import test from "node:test";
import { formatCloudStatus, inspectCloudStatus, isRemoteCloudWorkspace } from "../src/status.ts";
import type { CommandResult } from "../src/oci.ts";

test("remote workspace detection uses the pi-cloud session path", () => {
  assert.equal(isRemoteCloudWorkspace("/home/ubuntu/pi-cloud/sessions/sess01/work"), true);
  assert.equal(isRemoteCloudWorkspace("/Users/me/src/app"), false);
});

test("local idle status does not claim a live session", async () => {
  const status = await inspectCloudStatus({ cwd: "/Users/me/src/app" });
  assert.equal(status.mode, "local");
  assert.equal(status.connection, "unknown");
  assert.equal(status.subagentRuns, "unknown");
  assert.match(formatCloudStatus(status), /not active|unknown/i);
  assert.doesNotMatch(formatCloudStatus(status), /\bidle\b/);
});

test("remote status reports unknown git honestly and never says idle", async () => {
  const status = await inspectCloudStatus({
    cwd: "/home/ubuntu/pi-cloud/sessions/sess01/work",
    sessionId: "sess01",
    run: async (): Promise<CommandResult> => ({ code: 1, stdout: "", stderr: "missing" }),
  });
  assert.equal(status.mode, "remote");
  assert.equal(status.piSession, "sess01");
  assert.equal(status.commitsOnlyLocal, "unknown");
  assert.equal(status.subagentRuns, "unknown");
  const text = formatCloudStatus(status);
  assert.match(text, /unknown/);
  assert.doesNotMatch(text, /\bidle\b/);
});

test("remote status can see unpushed commits as local-only", async () => {
  const status = await inspectCloudStatus({
    cwd: "/home/ubuntu/pi-cloud/sessions/sess01/work",
    sessionId: "sess01",
    run: async (argv: readonly string[]) => {
      const key = argv.join(" ");
      if (key.includes("remote get-url")) return { code: 0, stdout: "https://github.com/acme/proj.git\n", stderr: "" };
      if (key.includes("branch --show-current")) return { code: 0, stdout: "pi/sess01\n", stderr: "" };
      if (key.includes("@{upstream}") && key.includes("rev-parse")) {
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (key.includes("rev-list")) return { code: 0, stdout: "2\n", stderr: "" };
      return { code: 1, stdout: "", stderr: key };
    },
  });
  assert.equal(status.commitsOnlyLocal, true);
  assert.equal(status.baseBranch, "main");
  assert.equal(status.workingBranch, "pi/sess01");
});
