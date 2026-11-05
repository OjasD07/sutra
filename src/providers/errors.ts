export type ProviderErrorKind =
  | "authentication" // 401
  | "insufficient_balance" // 402
  | "invalid_request" // 400 / 422
  | "rate_limited" // 429
  | "server_error" // 500
  | "overloaded" // 503
  | "network" // connection reset, DNS, etc.
  | "timeout"
  | "cancelled"
  | "stream_interrupted"
  | "protocol" // malformed response
  | "unknown";

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limited",
  "server_error",
  "overloaded",
  "network",
  "timeout",
  "stream_interrupted",
]);

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  /** True when part of the response was already streamed to the caller. */
  readonly partial: boolean;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts: { status?: number; retryAfterMs?: number; partial?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.partial = opts.partial ?? false;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

export function classifyHttpStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "insufficient_balance";
  if (status === 400 || status === 404 || status === 422) return "invalid_request";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 503) return "overloaded";
  if (status >= 500) return "server_error";
  return "unknown";
}

export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError && err.retryable;
}

/** Parse a Retry-After header (seconds or HTTP date). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/** Normalise fetch/abort/network failures into ProviderError. */
export function toProviderError(err: unknown, signal?: AbortSignal, partial = false): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted) return new ProviderError("cancelled", "Request cancelled", { cause: err, partial });
  const e = err as { name?: string; message?: string; code?: string };
  if (e?.name === "TimeoutError") return new ProviderError("timeout", "Request timed out", { cause: err, partial });
  if (e?.name === "AbortError") return new ProviderError("cancelled", "Request aborted", { cause: err, partial });
  const message = e?.message ?? String(err);
  return new ProviderError(partial ? "stream_interrupted" : "network", message, { cause: err, partial });
}
