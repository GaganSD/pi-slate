import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { createGitPorcelainRunner, GitStatusPoller } from "../extensions/sidebar/git-status.ts";

test("porcelain runner rejects timeout, maxBuffer, and nonzero git errors", async () => {
  const cases = [
    Object.assign(new Error("timeout"), { killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
    Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
    Object.assign(new Error("nonzero"), { code: 128 }),
  ];

  for (const error of cases) {
    const runner = createGitPorcelainRunner(50, (_file, _args, _options, callback) => {
      callback(error, "");
    });
    await assert.rejects(() => runner("/repo"), error);
  }
});

test("poller keeps the last snapshot on timeout, maxBuffer, and nonzero status", async () => {
  const failures = [
    Object.assign(new Error("killed"), { killed: true }),
    Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
    Object.assign(new Error("not a git repo"), { code: 128 }),
  ];

  for (const error of failures) {
    let shouldFail = false;
    const seen: string[][] = [];
    const poller = new GitStatusPoller((files) => {
      seen.push(files.map((item) => item.path));
    }, async () => {
      if (shouldFail) throw error;
      return " M keep.ts\0";
    }, 60_000);
    poller.start("/repo");
    await poller.refresh();
    shouldFail = true;
    await poller.refresh();
    assert.deepEqual(seen, [["keep.ts"]], error.message);
    poller.dispose();
  }
});

test("poller coalesces refreshes to one in-flight status plus one trailing pull", async () => {
  let pulls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const poller = new GitStatusPoller(() => {}, async () => {
    pulls += 1;
    if (pulls === 1) await firstGate;
    return " M a.ts\0";
  }, 60_000);

  poller.start("/repo");
  const waiting = [
    poller.refresh(),
    poller.refresh(),
    poller.refresh(),
    poller.refresh(),
  ];
  releaseFirst();
  await Promise.all(waiting);
  assert.equal(pulls, 2);
  poller.dispose();
});

test("successful empty porcelain still publishes a clean tree", async () => {
  let output = " M a.ts\0";
  const seen: number[] = [];
  const poller = new GitStatusPoller((files) => {
    seen.push(files.length);
  }, async () => output, 60_000);
  poller.start("/repo");
  await poller.refresh();
  output = "";
  await poller.refresh();
  assert.deepEqual(seen, [1, 0]);
  poller.dispose();
});

test("createGitPorcelainRunner uses execFile and rejects real missing repos", async () => {
  const runner = createGitPorcelainRunner(2_000, execFile);
  await assert.rejects(() => runner("/this/path/is/not/a/git/repo"));
});
