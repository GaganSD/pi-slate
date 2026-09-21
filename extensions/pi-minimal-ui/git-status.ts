import { execFile } from "node:child_process";
import { parsePorcelain, sameFiles, type FileChange } from "./files-modified.ts";

export const GIT_STATUS_POLL_MS = 2000;
export const GIT_STATUS_TIMEOUT_MS = 2000;

export type GitPorcelainRunner = (cwd: string) => Promise<string>;

export function createGitPorcelainRunner(
  timeoutMs = GIT_STATUS_TIMEOUT_MS,
): GitPorcelainRunner {
  return (cwd) => new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (!error) {
          resolve(typeof stdout === "string" ? stdout : "");
          return;
        }
        if (error.killed) {
          reject(error);
          return;
        }
        resolve("");
      },
    );
  });
}

export class GitStatusPoller {
  private cwd = "";
  private timer?: ReturnType<typeof setInterval>;
  private queue: Promise<void> = Promise.resolve();
  private last: FileChange[] = [];
  private started = false;
  private readonly onChange: (files: FileChange[]) => void;
  private readonly run: GitPorcelainRunner;
  private readonly intervalMs: number;

  constructor(
    onChange: (files: FileChange[]) => void,
    run: GitPorcelainRunner = createGitPorcelainRunner(),
    intervalMs = GIT_STATUS_POLL_MS,
  ) {
    this.onChange = onChange;
    this.run = run;
    this.intervalMs = intervalMs;
  }

  setCwd(cwd: string): void {
    if (this.cwd === cwd) return;
    this.cwd = cwd;
    this.last = [];
    if (this.started) void this.refresh();
  }

  start(cwd: string): void {
    this.cwd = cwd;
    this.last = [];
    this.started = true;
    void this.refresh();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  refresh(): Promise<void> {
    if (!this.started || !this.cwd) return Promise.resolve();
    this.queue = this.queue.then(() => this.pull());
    return this.queue;
  }

  dispose(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async pull(): Promise<void> {
    if (!this.started || !this.cwd) return;
    const cwd = this.cwd;
    try {
      const next = parsePorcelain(await this.run(cwd));
      if (!this.started || this.cwd !== cwd) return;
      if (sameFiles(this.last, next)) return;
      this.last = next;
      this.onChange(next);
    } catch {
      // Timeouts keep the last successful snapshot.
    }
  }
}
