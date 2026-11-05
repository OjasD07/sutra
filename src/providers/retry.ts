import { ProviderError, toProviderError } from "./errors.js";
import type { ModelEvent, ModelProvider, ModelRequest } from "./types.js";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const defaultRetryPolicy: RetryPolicy = { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 30_000 };

export interface RetryNotice {
  attempt: number;
  delayMs: number;
  error: ProviderError;
}

export function backoffDelay(policy: RetryPolicy, attempt: number, error: ProviderError, rand = Math.random): number {
  if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, policy.maxDelayMs);
  const exp = policy.baseDelayMs * 2 ** (attempt - 1);
  // Full jitter keeps concurrent clients from synchronising.
  return Math.min(policy.maxDelayMs, Math.round(exp / 2 + rand() * (exp / 2)));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError("cancelled", "Request cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ProviderError("cancelled", "Request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry wrapper. A request is retried transparently only while nothing has been
 * yielded. If a stream breaks after partial output, the caller receives a
 * `stream_interrupted` error with `partial: true` and decides what to do (the
 * runtime discards the partial message and re-issues the request), which keeps
 * the UI honest about what happened.
 */
export async function* generateWithRetry(
  provider: ModelProvider,
  request: ModelRequest,
  opts: { signal?: AbortSignal; policy?: RetryPolicy; onRetry?: (n: RetryNotice) => void; sleepFn?: typeof sleep } = {},
): AsyncIterable<ModelEvent> {
  const policy = opts.policy ?? defaultRetryPolicy;
  const sleepFn = opts.sleepFn ?? sleep;
  for (let attempt = 1; ; attempt++) {
    let yielded = false;
    try {
      for await (const ev of provider.generate(request, opts.signal)) {
        yielded = true;
        yield ev;
      }
      return;
    } catch (raw) {
      const err = toProviderError(raw, opts.signal, yielded);
      if (yielded || !err.retryable || attempt > policy.maxRetries || opts.signal?.aborted) {
        if (yielded && !err.partial) {
          throw new ProviderError(err.retryable ? "stream_interrupted" : err.kind, err.message, {
            status: err.status,
            partial: true,
            cause: err,
          });
        }
        throw err;
      }
      const delayMs = backoffDelay(policy, attempt, err);
      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleepFn(delayMs, opts.signal);
    }
  }
}
