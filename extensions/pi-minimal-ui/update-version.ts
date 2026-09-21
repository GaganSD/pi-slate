export const UPDATE_COMMAND = "/update";

export function parseVersion(value: string): [number, number, number] | undefined {
  const match = value.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now) return candidate.trim() !== current.trim();
  for (let index = 0; index < 3; index++) {
    if (next[index] > now[index]) return true;
    if (next[index] < now[index]) return false;
  }
  return false;
}

export function updateAvailableMessage(version: string): string {
  return `${version} is available. Use ${UPDATE_COMMAND} to update`;
}
