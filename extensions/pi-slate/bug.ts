import { SLATE_ISSUES_URL, SLATE_NEW_ISSUE_URL, SLATE_REPO } from "./layout.ts";

export { SLATE_ISSUES_URL, SLATE_NEW_ISSUE_URL, SLATE_REPO };

const ISSUE_URL_LIMIT = 7000;

function buildIssueUrl(title: string, body: string): string {
  const url = new URL(SLATE_NEW_ISSUE_URL);
  if (title) url.searchParams.set("title", title);
  if (body) url.searchParams.set("body", body);
  return url.toString();
}

export function newIssueUrl(title: string, body: string): string {
  let nextTitle = title;
  let nextBody = body;
  let href = buildIssueUrl(nextTitle, nextBody);
  while (href.length > ISSUE_URL_LIMIT && nextBody.length > 0) {
    const overflow = href.length - ISSUE_URL_LIMIT;
    nextBody = nextBody.slice(0, Math.max(0, nextBody.length - Math.max(16, overflow))).trimEnd();
    if (nextBody) nextBody = `${nextBody}\n\n…`;
    href = buildIssueUrl(nextTitle, nextBody);
  }
  while (href.length > ISSUE_URL_LIMIT && nextTitle.length > 0) {
    nextTitle = nextTitle.slice(0, Math.max(0, nextTitle.length - 8));
    href = buildIssueUrl(nextTitle, nextBody);
  }
  return href.length > ISSUE_URL_LIMIT ? SLATE_NEW_ISSUE_URL : href;
}

export function issueTemplate(env: { slateVersion: string; piVersion: string; platform: string }): string {
  return [
    "## What happened",
    "",
    "",
    "## Expected",
    "",
    "",
    "## Environment",
    "",
    `- pi-slate: ${env.slateVersion}`,
    `- pi: ${env.piVersion}`,
    `- platform: ${env.platform}`,
    "",
  ].join("\n");
}

export function parseGhIssueUrl(stdout: string): string | undefined {
  const match = stdout.match(/https:\/\/github\.com\/\S+\/issues\/\d+/);
  return match?.[0];
}

export function openExternalArgs(target: string, platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", `"${target}"`] };
  return { command: "xdg-open", args: [target] };
}

export function openUrlArgs(url: string, platform = process.platform): { command: string; args: string[] } {
  return openExternalArgs(url, platform);
}

export function ghCreateIssueArgs(title: string, body: string): string[] {
  return ["issue", "create", "--repo", SLATE_REPO, "--title", title, "--body", body];
}
