import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnCommand } from "../src/oci.ts";
import { handleCloudFlag, registerCloudExtension } from "../src/index.ts";
import { resolveCloudRun } from "../src/setup.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakePi(flags: Record<string, boolean | string | undefined> = {}) {
  const registered: Record<string, unknown> = {};
  const commands: Record<string, { description?: string; handler: Function }> = {};
  const handlers: Record<string, Function> = {};
  let shutdowns = 0;
  const notifies: string[] = [];
  const pi = {
    registerFlag(name: string, options: unknown) {
      registered[name] = options;
    },
    getFlag(name: string) {
      return flags[name];
    },
    registerCommand(name: string, options: { description?: string; handler: Function }) {
      commands[name] = options;
    },
    on(event: string, handler: Function) {
      handlers[event] = handler;
      return () => undefined;
    },
    sendMessage() {},
  };
  const ctx = {
    mode: "print" as "print" | "tui",
    hasUI: false,
    cwd: process.cwd(),
    ui: {
      notify(message: string) {
        notifies.push(message);
      },
      async confirm() {
        return false;
      },
      async select() {
        return undefined;
      },
      async input() {
        return undefined;
      },
      async custom() {
        throw new Error("custom UI should not run");
      },
    },
    sessionManager: {
      getSessionId: () => "local-session",
      getSessionName: () => undefined,
    },
    shutdown() {
      shutdowns += 1;
    },
  };
  return { pi, ctx, registered, commands, handlers, notifies, shutdowns: () => shutdowns };
}

test("package.json declares a Pi extension and no second executable", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name: string;
    bin?: unknown;
    pi?: { extensions?: string[] };
  };
  assert.equal(manifest.name, "pi-cloud-agent");
  assert.equal(manifest.bin, undefined);
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);
});

test("registers --cloud --repo --branch and read-only /cloud", () => {
  const fake = fakePi();
  registerCloudExtension(fake.pi as never);
  assert.equal(Boolean(fake.registered.cloud), true);
  assert.equal(Boolean(fake.registered.repo), true);
  assert.equal(Boolean(fake.registered.branch), true);
  assert.equal(typeof fake.commands.cloud.handler, "function");
  assert.match(fake.commands.cloud.description ?? "", /status/i);
});

test("session_start without --cloud does not attach or shut down", async () => {
  const fake = fakePi({ cloud: false });
  registerCloudExtension(fake.pi as never);
  await fake.handlers.session_start({}, fake.ctx);
  assert.equal(fake.shutdowns(), 0);
  assert.equal(fake.notifies.length, 0);
});

test("pi --cloud in a non-TUI mode refuses local fallback and shuts down", async () => {
  const fake = fakePi({ cloud: true });
  registerCloudExtension(fake.pi as never);
  await fake.handlers.session_start({}, fake.ctx);
  assert.equal(fake.shutdowns(), 1);
  assert.match(fake.notifies.join("\n"), /TUI|local tools/i);
});

test("README documents local install and PI_CLOUD browser auth", async () => {
  const readme = await readFile(join(root, "README.md"), "utf8");
  assert.match(readme, /pi install \.\/cloud-agents/);
  assert.match(readme, /PI_CLOUD/);
  assert.match(readme, /pi --cloud/);
  assert.match(readme, /--repo/);
  assert.match(readme, /--branch/);
  assert.match(readme, /22\.19/);
  assert.match(readme, /remote default HEAD/);
});

test("/cloud default runner is resolveCloudRun, not undefined", async () => {
  assert.equal(resolveCloudRun(undefined), spawnCommand);
  assert.equal(resolveCloudRun({}), spawnCommand);
  const fake = fakePi();
  const gitCalls: string[][] = [];
  const stateDir = await mkdtemp(join(tmpdir(), "pi-cloud-ext-"));
  registerCloudExtension(fake.pi as never, {
    stateDir,
    run: async (argv) => {
      gitCalls.push([...argv]);
      return { code: 1, stdout: "", stderr: "offline fixture" };
    },
  });
  fake.ctx.cwd = "/home/ubuntu/pi-cloud/sessions/sess01/work";
  await fake.commands.cloud.handler("", fake.ctx);
  assert.equal(gitCalls.some((argv) => argv[0] === "git"), true);
  assert.doesNotMatch(fake.notifies.join("\n"), /\bidle\b/);
});

test("thrown startup still shuts down local Pi", async () => {
  const fake = fakePi({ cloud: true });
  fake.ctx.mode = "tui";
  fake.ctx.hasUI = true;
  const stateDir = await mkdtemp(join(tmpdir(), "pi-cloud-ext-"));
  await mkdir(join(stateDir, "ssh"), { recursive: true });
  await writeFile(join(stateDir, "ssh", "id_ed25519.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIlocalfixture pi-cloud\n");
  await handleCloudFlag(fake.pi as never, fake.ctx as never, {
    stateDir,
    oci: {
      async preflight() {
        throw new Error("oci exploded");
      },
    } as never,
  });
  assert.equal(fake.shutdowns(), 1);
  assert.match(fake.notifies.join("\n"), /failed closed|oci exploded/i);
});
