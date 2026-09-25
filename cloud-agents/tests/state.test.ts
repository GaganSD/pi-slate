import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireExclusiveLock,
  createFileRegistry,
  defaultState,
  loadState,
  saveState,
  setupLockPath,
  StateLoadError,
  StateLockError,
  updateState,
} from "../src/state.ts";

test("missing state.json is a first run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  const state = await loadState(dir);
  assert.deepEqual(state, defaultState());
});

test("corrupt JSON fails closed instead of defaulting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  await writeFile(join(dir, "state.json"), "{", { mode: 0o600 });
  await assert.rejects(() => loadState(dir), StateLoadError);
});

test("invalid version or enroll without host fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ version: 2, setupStep: "auth", sessions: [] }), {
    mode: 0o600,
  });
  await assert.rejects(() => loadState(dir), StateLoadError);
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({ version: 1, setupStep: "enroll", sessions: [] }),
    { mode: 0o600 },
  );
  await assert.rejects(() => loadState(dir), StateLoadError);
});

test("saveState writes atomically and survives a later load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  await saveState(dir, {
    version: 1,
    setupStep: "discover",
    sessions: [],
    identityFile: "/tmp/id",
  });
  const loaded = await loadState(dir);
  assert.equal(loaded.setupStep, "discover");
  assert.equal(loaded.identityFile, "/tmp/id");
});

test("existing unreadable state.json fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  const path = join(dir, "state.json");
  await writeFile(path, JSON.stringify(defaultState()), { mode: 0o000 });
  try {
    await assert.rejects(() => loadState(dir), StateLoadError);
  } finally {
    await chmod(path, 0o600);
  }
});

test("stale exclusive lock is not stolen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  await acquireExclusiveLock(setupLockPath(dir));
  await assert.rejects(() => acquireExclusiveLock(setupLockPath(dir)), StateLockError);
});

test("registry put serializes through the write lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-state-"));
  const registry = createFileRegistry(dir);
  await registry.put({
    id: "sess01",
    hostId: "inst-1",
    repo: "https://github.com/acme/proj.git",
    baseBranch: "main",
    workingBranch: "pi/sess01",
    tmuxSession: "pi-sess01",
    remotePath: "/home/ubuntu/pi-cloud/sessions/sess01/work",
    piSession: "sess01",
    status: "running",
    worktreesOwnedBy: "subagents",
  });
  const listed = await registry.list({ hostId: "inst-1" });
  assert.equal(listed.length, 1);
  const updated = await updateState(dir, (state) => ({ ...state, setupStep: "discover" }));
  assert.equal(updated.sessions.length, 1);
  assert.equal(updated.setupStep, "discover");
});
