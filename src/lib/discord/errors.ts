/** Error values and dependency-free extraction helpers. */

export class OperationTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message = `Operation timed out after ${timeoutMs}ms`) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class OperationAbortedError extends Error {
  readonly code = 'ABORT_ERR';
  readonly reason?: unknown;
  readonly cause?: unknown;

  constructor(message = 'Operation was aborted', reason?: unknown) {
    super(message);
    this.name = 'AbortError';
    this.reason = reason;
    this.cause = reason;
  }
}

export class RetryConfigurationError extends Error {
  readonly code = 'ERR_RETRY_CONFIGURATION';

  constructor(message: string) {
    super(message);
    this.name = 'RetryConfigurationError';
  }
}

export function isOperationTimeoutError(error: unknown): error is OperationTimeoutError {
  return error instanceof OperationTimeoutError;
}

export function isOperationAbortedError(error: unknown): error is OperationAbortedError {
  return error instanceof OperationAbortedError;
}

export function isAbortError(error: unknown): boolean {
  if (isOperationAbortedError(error)) return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true;
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  if (value.name === 'AbortError' || value.code === 'ABORT_ERR') return true;
  return typeof value.message === 'string' && /\babort(?:ed)?\b/i.test(value.message);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch {
    // Some thrown values contain cycles or unsupported values.
  }
  return String(error);
}

export function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return error instanceof Error ? error.name : 'Error';
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function statusFromRecord(record: Record<string, unknown> | undefined): number | undefined {
  if (!record) return undefined;
  const direct = finiteNumber(record.status) ?? finiteNumber(record.statusCode);
  if (direct !== undefined) return direct;
  const response = asRecord(record.response);
  if (response) {
    const nested = finiteNumber(response.status) ?? finiteNumber(response.statusCode);
    if (nested !== undefined) return nested;
    const raw = asRecord(response.raw);
    if (raw) {
      const rawStatus = finiteNumber(raw.status) ?? finiteNumber(raw.statusCode);
      if (rawStatus !== undefined) return rawStatus;
    }
  }
  return undefined;
}

export function errorStatus(error: unknown): number | undefined {
  return statusFromRecord(asRecord(error));
}

function firstNumber(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function headerValue(headers: unknown, name: string): unknown {
  if (!headers) return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    try {
      const value = (get as (key: string) => unknown).call(headers, name);
      if (value !== null && value !== undefined) return value;
    } catch {
      // Fall through to object/Map inspection.
    }
  }
  if (headers instanceof Map) {
    const direct = headers.get(name) ?? headers.get(name.toLowerCase());
    if (direct !== undefined) return direct;
    const wanted = name.toLowerCase();
    for (const [key, value] of headers) {
      if (String(key).toLowerCase() === wanted) return value;
    }
    return undefined;
  }
  const record = asRecord(headers);
  if (!record) return undefined;
  const direct = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function responseHeaders(error: unknown): unknown {
  const record = asRecord(error);
  if (!record) return undefined;
  const response = asRecord(record.response);
  return response?.headers ?? record.headers;
}

function normalizeRetryAfterValue(value: unknown, now = Date.now()): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(0, numeric);
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
  return undefined;
}

/**
 * Read common HTTP/Discord retry hints. Discord's `retry_after` is expressed in
 * seconds; explicit `retryAfterMs`/`retry_after_ms` values are milliseconds.
 */
export function errorRetryAfterMs(error: unknown, now = Date.now()): number | undefined {
  const record = asRecord(error);
  if (!record) return undefined;
  const response = asRecord(record.response);
  const responseData = asRecord(response?.data) ?? asRecord(record.data);
  const raw = asRecord(record.raw) ?? asRecord(response?.raw);

  const explicit = firstNumber([
    record.retryAfterMs,
    record.retry_after_ms,
    responseData?.retryAfterMs,
    responseData?.retry_after_ms,
    raw?.retryAfterMs,
    raw?.retry_after_ms,
  ]);
  if (explicit !== undefined) return Math.max(0, explicit);

  const seconds = firstNumber([
    record.retry_after,
    record.retryAfter,
    responseData?.retry_after,
    responseData?.retryAfter,
    raw?.retry_after,
    raw?.retryAfter,
  ]);
  if (seconds !== undefined) return Math.max(0, seconds * 1000);

  const header = headerValue(responseHeaders(error), 'retry-after');
  return normalizeRetryAfterValue(header, now);
}

export function errorCause(error: unknown): unknown {
  if (error && typeof error === 'object' && 'cause' in error) {
    return (error as { cause?: unknown }).cause;
  }
  return undefined;
}

export function toAbortError(reason?: unknown): OperationAbortedError {
  if (isOperationAbortedError(reason)) return reason;
  if (reason instanceof Error && reason.message) {
    const error = new OperationAbortedError(reason.message, reason);
    return error;
  }
  return new OperationAbortedError(
    reason === undefined ? 'Operation was aborted' : `Operation was aborted: ${String(reason)}`,
    reason,
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toAbortError(signal.reason);
}

export {
  OperationTimeoutError as TimeoutError,
  OperationAbortedError as AbortError,
};
