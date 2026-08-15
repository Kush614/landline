import { logDecision } from "./log.js";

export class HttpError extends Error {
  constructor(public status: number, public body: string, public url: string) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 300)}`);
  }
}

export interface FetchOpts extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

/**
 * Every external call: 20s timeout, one retry, structured error.
 * Callers are expected to wrap this in their own fallback (§0.4).
 */
export async function req<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { timeoutMs = 20_000, retries = 1, ...init } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text, url);
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (err) {
      lastErr = err;
      // 4xx are our fault — retrying won't help.
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 750));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Runs `fn`, and on any failure logs it and returns `fallback` instead of throwing. */
export async function softly<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
  orderId?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logDecision({
      agent: "system",
      type: "fallback",
      orderId,
      input: label,
      output: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}
