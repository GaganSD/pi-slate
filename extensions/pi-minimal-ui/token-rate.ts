export const TOKEN_RATE_WINDOW_MS = 5000;
export const TOKEN_RATE_TICK_MS = 250;

export function displayedTokenRate(rate: number): number {
  return Number.isFinite(rate) ? Math.round(Math.max(0, rate)) : 0;
}

export type AssistantContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
};

type Sample = { t: number; tokens: number };

export function estimateAssistantTokens(message: { content?: readonly AssistantContentBlock[] }): number {
  const content = message.content;
  if (!content) return 0;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") chars += block.text?.length ?? 0;
    else if (block.type === "thinking") chars += block.thinking?.length ?? 0;
    else if (block.type === "toolCall") {
      chars += block.name?.length ?? 0;
      chars += stringifyArgs(block.arguments).length;
    }
  }
  return chars / 4;
}

function stringifyArgs(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? "";
  } catch {
    return "";
  }
}

export class TokenRateTracker {
  private samples: Sample[] = [];
  private lastPartialTokens = 0;
  private streaming = false;
  private lastRate = 0;
  private activeNow = 0;
  private lastWall: number | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private onChange?: () => void;
  private readonly now: () => number;
  private readonly schedule: typeof setInterval;
  private readonly unschedule: typeof clearInterval;

  constructor(
    now: () => number = Date.now,
    schedule: typeof setInterval = setInterval,
    unschedule: typeof clearInterval = clearInterval,
  ) {
    this.now = now;
    this.schedule = schedule;
    this.unschedule = unschedule;
  }

  setOnChange(callback: (() => void) | undefined): void {
    this.onChange = callback;
    if (callback && this.streaming) this.ensureTimer();
    else if (!callback) this.clearTimer();
  }

  startMessage(): void {
    this.lastPartialTokens = 0;
    this.samples = [];
    this.activeNow = 0;
    this.streaming = true;
    this.lastWall = this.now();
    this.ensureTimer();
  }

  observePartial(tokens: number): void {
    if (!this.streaming) this.startMessage();
    const next = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
    const delta = Math.max(0, next - this.lastPartialTokens);
    this.lastPartialTokens = next;
    if (delta <= 0) return;
    this.syncClock();
    this.samples.push({ t: this.activeNow, tokens: delta });
    this.prune();
    this.lastRate = this.liveRate(TOKEN_RATE_TICK_MS);
    this.onChange?.();
  }

  endMessage(): void {
    if (this.streaming) {
      this.syncClock();
      this.prune();
      if (this.samples.length > 0) this.lastRate = this.liveRate(1);
    }
    this.lastPartialTokens = 0;
    this.streaming = false;
    this.lastWall = null;
    this.clearTimer();
    this.onChange?.();
  }

  rate(): number {
    if (!this.streaming) return this.lastRate;
    this.syncClock();
    this.prune();
    if (this.samples.length === 0) return this.lastRate;
    this.lastRate = this.liveRate(TOKEN_RATE_TICK_MS);
    return this.lastRate;
  }

  dispose(): void {
    this.clearTimer();
    this.samples = [];
    this.lastPartialTokens = 0;
    this.streaming = false;
    this.lastRate = 0;
    this.activeNow = 0;
    this.lastWall = null;
    this.onChange = undefined;
  }

  private liveRate(minElapsedMs: number): number {
    if (this.samples.length === 0) return 0;
    let tokens = 0;
    for (const sample of this.samples) tokens += sample.tokens;
    const elapsedMs = Math.min(
      TOKEN_RATE_WINDOW_MS,
      Math.max(this.activeNow - this.samples[0]!.t, minElapsedMs),
    );
    return tokens / (elapsedMs / 1000);
  }

  private syncClock(): void {
    const wall = this.now();
    if (this.streaming && this.lastWall !== null) {
      this.activeNow += Math.max(0, wall - this.lastWall);
    }
    this.lastWall = wall;
  }

  private prune(): void {
    const cutoff = this.activeNow - TOKEN_RATE_WINDOW_MS;
    let index = 0;
    while (index < this.samples.length && this.samples[index]!.t < cutoff) index++;
    if (index > 0) this.samples = this.samples.slice(index);
  }

  private ensureTimer(): void {
    if (this.timer || !this.onChange || !this.streaming) return;
    this.timer = this.schedule(() => {
      if (!this.streaming) {
        this.clearTimer();
        return;
      }
      this.onChange?.();
    }, TOKEN_RATE_TICK_MS);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.unschedule(this.timer);
    this.timer = undefined;
  }
}
