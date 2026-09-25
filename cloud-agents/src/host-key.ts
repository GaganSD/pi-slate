import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cliValue,
  GUEST_SSH_HOST_FINGERPRINT_SOURCE,
  isUsableGuestSshHostFingerprint,
  OCI_AUTH,
  OCI_PROFILE,
  type CommandRunner,
} from "./oci.ts";
import {
  parseHostKey,
  type PinResult,
  type RemoteBlocker,
  type RemoteHost,
  type RemoteTransport,
} from "./remote.ts";
import { asString, compactText, isRecord, ociItems, unwrapData } from "./util.ts";

/** Independently authenticated cloud-init console history is the only enrollable guest sshd source. */
export const CLOUD_INIT_CONSOLE_HISTORY_SOURCE = "authenticated OCI cloud-init console-history";

const HOST_KEY_BLOCK =
  /-----BEGIN SSH HOST KEY KEYS-----([\s\S]*?)-----END SSH HOST KEY KEYS-----/;

export type EnrollRequest = {
  run: CommandRunner;
  remote: RemoteTransport;
  instanceId: string;
  compartmentId: string;
  region?: string;
  host: Omit<RemoteHost, "expectedHostKey"> & { expectedHostKey?: string };
  aliases?: readonly string[];
  confirmCapture: () => Promise<boolean>;
};

export function extractGuestSshHostKeys(consoleText: string): string[] {
  const match = HOST_KEY_BLOCK.exec(consoleText);
  if (!match) return [];
  const found: string[] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const parsed = parseHostKey(line);
    if (!parsed) continue;
    found.push(`${parsed.type} ${parsed.data}${parsed.comment ? ` ${parsed.comment}` : ""}`);
  }
  return unique(found);
}

export function preferGuestSshHostKey(keys: readonly string[]): string | undefined {
  const ranked = [...keys].sort((left, right) => rankKey(left) - rankKey(right));
  return ranked[0];
}

export function consoleHistoryLooksLikeSerialService(text: string): boolean {
  const value = text.toLowerCase();
  return (
    value.includes("instance-console-connection") ||
    (value.includes("serial-console") && !HOST_KEY_BLOCK.test(text))
  );
}

export async function enrollGuestSshHostKey(request: EnrollRequest): Promise<PinResult> {
  const expectedHostKey = request.host.expectedHostKey?.trim()
    ? request.host.expectedHostKey.trim()
    : await readGuestKeyFromConsoleHistory(request);
  if (typeof expectedHostKey !== "string") return expectedHostKey;

  return await request.remote.pinHostKey({
    host: {
      id: request.host.id,
      address: request.host.address,
      user: request.host.user,
      expectedHostKey,
    },
    source: CLOUD_INIT_CONSOLE_HISTORY_SOURCE,
    aliases: request.aliases,
  });
}

async function readGuestKeyFromConsoleHistory(
  request: EnrollRequest,
): Promise<string | PinResult> {
  const listed = await ociJson(request, [
    "compute",
    "console-history",
    "list",
    "--compartment-id",
    request.compartmentId,
    "--instance-id",
    request.instanceId,
    "--all",
  ]);
  if (!listed.ok) {
    return blocked(
      "missing-host-key",
      `could not list console history: ${listed.error}. Guest sshd is not enrolled; SSH is blocked.`,
    );
  }

  const existing = historyIds(listed.value);
  for (const id of existing) {
    const extracted = await contentToKey(request, id);
    if (extracted) return extracted;
  }

  const confirmed = await request.confirmCapture();
  if (!confirmed) {
    return blocked(
      "missing-host-key",
      "refusing to capture console history without confirmation. Guest sshd is not enrolled; SSH is blocked. Capture cloud-init console history from the OCI Console after first boot, then re-run pi --cloud.",
    );
  }

  const captured = await ociJson(request, [
    "compute",
    "console-history",
    "capture",
    "--instance-id",
    request.instanceId,
    "--wait-for-state",
    "SUCCEEDED",
    "--wait-for-state",
    "FAILED",
  ]);
  if (!captured.ok) {
    return blocked(
      "missing-host-key",
      `console-history capture failed: ${captured.error}. Guest sshd is not enrolled; SSH is blocked.`,
    );
  }
  const capturedId =
    asString(cliValue(asRecord(unwrapData(captured.value)) ?? {}, "id")) ?? historyIds(captured.value)[0];
  if (!capturedId) {
    return blocked(
      "missing-host-key",
      "console-history capture returned no id. Guest sshd is not enrolled; SSH is blocked.",
    );
  }
  const extracted = await contentToKey(request, capturedId);
  if (extracted) return extracted;
  return blocked(
    "missing-host-key",
    "cloud-init console-history did not contain a guest SSH HOST KEY KEYS block. Refusing accept-new and serial-console service keys. Wait for cloud-init to finish, capture console history again, then re-run pi --cloud.",
  );
}

async function contentToKey(request: EnrollRequest, historyId: string): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-console-"));
  const file = join(dir, "console-history.txt");
  try {
    const result = await request.run(
      ociArgv(
        [
          "compute",
          "console-history",
          "get-content",
          "--instance-console-history-id",
          historyId,
          "--file",
          file,
        ],
        request.region,
        false,
      ),
    );
    if (result.code !== 0) return undefined;
    const text = await readFile(file, "utf8");
    if (consoleHistoryLooksLikeSerialService(text) && !HOST_KEY_BLOCK.test(text)) return undefined;
    return preferGuestSshHostKey(extractGuestSshHostKeys(text));
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function enrollmentSourceIsUsable(source: string): boolean {
  return isUsableGuestSshHostFingerprint(source);
}

function historyIds(payload: unknown): string[] {
  return ociItems(payload)
    .filter((item) => {
      const state = (asString(cliValue(item, "lifecycle_state")) ?? "").toUpperCase();
      return state === "" || state === "SUCCEEDED" || state === "AVAILABLE";
    })
    .map((item) => asString(cliValue(item, "id")))
    .filter((id): id is string => Boolean(id));
}

async function ociJson(
  request: EnrollRequest,
  parts: readonly string[],
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const result = await request.run(ociArgv(parts, request.region, true));
  if (result.code !== 0) {
    return { ok: false, error: compactText(result.stderr || result.stdout || `exit ${result.code}`) };
  }
  const text = result.stdout.trim();
  if (!text) return { ok: false, error: "empty CLI stdout" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON from CLI" };
  }
}

function ociArgv(parts: readonly string[], region: string | undefined, json: boolean): string[] {
  const argv = ["oci", "--profile", OCI_PROFILE, "--auth", OCI_AUTH];
  if (json) argv.push("--output", "json");
  if (region) argv.push("--region", region);
  argv.push(...parts);
  return argv;
}

function blocked(code: RemoteBlocker["code"], message: string): PinResult {
  return { ok: false, blockers: [{ code, message }] };
}

function rankKey(raw: string): number {
  if (raw.startsWith("ssh-ed25519 ")) return 0;
  if (raw.startsWith("ecdsa-sha2-nistp256 ")) return 1;
  if (raw.startsWith("ecdsa-sha2-nistp384 ")) return 2;
  if (raw.startsWith("ecdsa-sha2-nistp521 ")) return 3;
  if (raw.startsWith("ssh-rsa ")) return 4;
  return 9;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export { GUEST_SSH_HOST_FINGERPRINT_SOURCE };
