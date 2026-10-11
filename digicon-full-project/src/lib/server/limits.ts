export const MAX_BODY_BYTES = 2_048;
export const MAX_MESSAGE_CHARS = 500;

/** Sliding-window limiter, per user. In-memory; use a shared store when running several instances. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 20, private windowMs = 60_000, private now: () => number = Date.now) {}
  /** True while the key is under its limit. Does not record a hit. */
  peek(key: string): boolean {
    const t = this.now();
    return (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs).length < this.max;
  }
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
export function getLimiter(): RateLimiter {
  const g = globalThis as unknown as { __digiconLimiter?: RateLimiter };
  return (g.__digiconLimiter ??= new RateLimiter());
}

/** Failed sign-ins per client address: slows token guessing. */
export function getAuthFailLimiter(): RateLimiter {
  const g = globalThis as unknown as { __digiconAuthFail?: RateLimiter };
  return (g.__digiconAuthFail ??= new RateLimiter(10, 60_000));
}
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (fwd || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
}
