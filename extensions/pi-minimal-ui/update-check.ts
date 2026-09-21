import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isNewerVersion, updateAvailableMessage } from "./update-version.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const CHECK_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 120_000;

type LatestRelease = {
  version: string;
};

function skippedByEnv(): boolean {
  return Boolean(process.env.PI_OFFLINE) || Boolean(process.env.PI_SKIP_VERSION_CHECK);
}

async function fetchLatestRelease(): Promise<LatestRelease | undefined> {
  if (process.env.PI_OFFLINE) return undefined;
  const response = await fetch(LATEST_VERSION_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  const data = (await response.json()) as { version?: unknown };
  if (typeof data.version !== "string" || !data.version.trim()) return undefined;
  return { version: data.version.trim() };
}

export async function checkForUpdate(currentVersion = VERSION): Promise<string | undefined> {
  if (skippedByEnv()) return undefined;
  try {
    const latest = await fetchLatestRelease();
    if (latest && isNewerVersion(latest.version, currentVersion)) return latest.version;
  } catch {
    return undefined;
  }
  return undefined;
}

export function installUpdateCheck(pi: ExtensionAPI): void {
  pi.registerCommand("update", {
    description: "Update Pi to the latest version",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Updating Pi…", "info");
      const result = await pi.exec("pi", ["update"], { timeout: UPDATE_TIMEOUT_MS });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (result.code === 0) {
        ctx.ui.notify(output || "Pi updated. Restart to use the new version.", "info");
        return;
      }
      ctx.ui.notify(output || `Update failed (exit ${result.code}).`, "error");
    },
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" || ctx.mode !== "tui" || skippedByEnv()) return;
    process.env.PI_SKIP_VERSION_CHECK = "1";
    void notifyIfUpdateAvailable(ctx);
  });
}

async function notifyIfUpdateAvailable(ctx: ExtensionContext): Promise<void> {
  const version = await checkForUpdate();
  if (!version) return;
  ctx.ui.notify(updateAvailableMessage(version), "info");
}
