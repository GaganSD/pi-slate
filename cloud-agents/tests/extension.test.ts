import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerCloudExtension } from "../src/index.ts";

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
    mode: "print" as const,
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
});
