import assert from "node:assert/strict";
import test from "node:test";
import {
  ghCreateIssueArgs,
  issueTemplate,
  newIssueUrl,
  openUrlArgs,
  parseGhIssueUrl,
  SLATE_ISSUES_URL,
  SLATE_NEW_ISSUE_URL,
  SLATE_REPO,
} from "../extensions/pi-slate/bug.ts";
import { SLATE_VERSION } from "../extensions/pi-slate/layout.ts";

test("bug links stay on the slate issues tracker", () => {
  assert.equal(SLATE_ISSUES_URL, "https://github.com/GaganSD/pi-slate/issues");
  assert.equal(SLATE_NEW_ISSUE_URL, "https://github.com/GaganSD/pi-slate/issues/new");
  assert.equal(SLATE_REPO, "GaganSD/pi-slate");
  const url = new URL(newIssueUrl("Sidebar crash", "Steps"));
  assert.equal(url.origin + url.pathname, SLATE_NEW_ISSUE_URL);
  assert.equal(url.searchParams.get("title"), "Sidebar crash");
  assert.equal(url.searchParams.get("body"), "Steps");
});

test("issue template includes environment and empty report sections", () => {
  assert.match(SLATE_VERSION, /^\d+\.\d+\.\d+$/);
  const body = issueTemplate({ slateVersion: SLATE_VERSION, piVersion: "0.85.1", platform: "darwin arm64" });
  assert.match(body, /## What happened/);
  assert.match(body, /## Expected/);
  assert.match(body, new RegExp(`- pi-slate: ${SLATE_VERSION}`));
  assert.match(body, /- pi: 0\.85\.1/);
  assert.match(body, /- platform: darwin arm64/);
});

test("gh output and open args stay usable across platforms", () => {
  assert.equal(parseGhIssueUrl("https://github.com/GaganSD/pi-slate/issues/12\n"), "https://github.com/GaganSD/pi-slate/issues/12");
  assert.equal(parseGhIssueUrl("failed"), undefined);
  assert.deepEqual(ghCreateIssueArgs("Title", "Body"), [
    "issue", "create", "--repo", SLATE_REPO, "--title", "Title", "--body", "Body",
  ]);
  assert.deepEqual(openUrlArgs(SLATE_ISSUES_URL, "darwin"), { command: "open", args: [SLATE_ISSUES_URL] });
  assert.deepEqual(openUrlArgs(SLATE_ISSUES_URL, "linux"), { command: "xdg-open", args: [SLATE_ISSUES_URL] });
  assert.deepEqual(openUrlArgs(SLATE_ISSUES_URL, "win32"), { command: "cmd", args: ["/c", "start", "", `"${SLATE_ISSUES_URL}"`] });
});

test("new issue URLs stay under the browser length cap", () => {
  const href = newIssueUrl("&".repeat(200), "body & details\n".repeat(4000));
  assert.ok(href.length <= 7000);
  assert.ok(href.startsWith(SLATE_NEW_ISSUE_URL));
});
