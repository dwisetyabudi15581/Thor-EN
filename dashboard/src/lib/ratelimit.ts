// In-memory sliding-window rate limiter — the same pattern as the Thor bot:
// max 5 failures / 10 minutes per user; success resets the count.

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;

const failures = new Map<string, number[]>();

export function noteFailure(bucket: string): void {
  const now = Date.now();
  const list = (failures.get(bucket) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  failures.set(bucket, list);
}

export function noteSuccess(bucket: string): void {
  failures.delete(bucket);
}

export function isRateLimited(bucket: string): boolean {
  const now = Date.now();
  const list = (failures.get(bucket) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(bucket, list);
  return list.length >= MAX_FAILURES;
}

// Periodic cleanup so the Map never grows unbounded
if (typeof setInterval === "function") {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, list] of failures) {
      const alive = list.filter((t) => now - t < WINDOW_MS);
      if (alive.length === 0) failures.delete(k);
      else failures.set(k, alive);
    }
  }, 60 * 1000);
  // Don't keep the Node process from exiting
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}
