import { spawn } from "node:child_process";
import type { CommandResult } from "./oci.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function unwrapData(payload: unknown): unknown {
  return isRecord(payload) && "data" in payload ? payload.data : payload;
}

export function ociItems(payload: unknown): Array<Record<string, unknown>> {
  const root = unwrapData(payload);
  if (Array.isArray(root)) return root.filter(isRecord);
  if (isRecord(root) && Array.isArray(root.items)) return root.items.filter(isRecord);
  if (isRecord(root) && Array.isArray(root.data)) return root.data.filter(isRecord);
  if (isRecord(root) && isRecord(root.data) && Array.isArray(root.data.items)) {
    return root.data.items.filter(isRecord);
  }
  return [];
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function compactText(text: string, max = 1200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function hostIdFromOcid(ocid: string): string {
  const tail = ocid.replace(/[^A-Za-z0-9]/g, "").slice(-12) || "instance";
  return `inst-${tail}`.slice(0, 64);
}

export function guestUserForOs(operatingSystem?: string): string {
  const value = (operatingSystem ?? "").trim().toLowerCase();
  if (value.includes("oracle")) return "opc";
  return "ubuntu";
}

export async function spawnInherit(argv: readonly string[]): Promise<CommandResult> {
  if (argv.length === 0) return { stdout: "", stderr: "empty argv", code: 1 };
  const [command, ...args] = argv;
  return await new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: "inherit" });
    child.on("error", (error: Error) => {
      resolve({ stdout: "", stderr: error.message, code: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout: "", stderr: "", code: code ?? 1 });
    });
  });
}
