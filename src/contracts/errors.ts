/**
 * Stable public error vocabulary.
 *
 * Ownership: API adapters own HTTP status selection and exception mapping;
 * A02 owns the codes and the safe response shape.  Messages and details in
 * this contract are safe for an untrusted client.  They must never contain a
 * token, cookie, authorization header, raw request body, stack, or provider
 * response.  Lower-case codes are retained only for old route consumers and
 * should be normalized to the canonical upper-case spelling at new boundaries.
 */

import type { CorrelationId, SafeDetails, SafeMessage } from './primitives';

export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'REVISION_CONFLICT',
  'RATE_LIMITED',
  'CSRF_FAILED',
  'NOT_READY',
  'UPSTREAM_UNAVAILABLE',
  'PERSISTENCE_CONFLICT',
  'PERSISTENCE_CORRUPT',
  'PERSISTENCE_WRITE_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_SIGNATURE',
  'REPLAY_DETECTED',
  'UNKNOWN_PRODUCT',
  'CROSS_GUILD_FORBIDDEN',
  'DISCORD_PERMISSION_DENIED',
  'DISCORD_RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type CanonicalApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Codes emitted by early route handlers before the canonical vocabulary existed. */
export const LEGACY_API_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'revision_conflict',
  'rate_limited',
  'csrf_failed',
  'not_ready',
  'upstream_unavailable',
  'persistence_conflict',
  'persistence_corrupt',
  'persistence_write_failed',
  'idempotency_conflict',
  'invalid_signature',
  'replay_detected',
  'unknown_product',
  'cross_guild_forbidden',
  'internal_error',
] as const;

export type LegacyApiErrorCode = (typeof LEGACY_API_ERROR_CODES)[number];
/** Accepted spelling at compatibility boundaries; new responses use `CanonicalApiErrorCode`. */
export type ApiErrorCode = CanonicalApiErrorCode | LegacyApiErrorCode;
export type ErrorCode = ApiErrorCode;

export interface ApiError {
  /** Stable machine-readable code. */
  readonly code: ApiErrorCode;
  /** Sanitized, human-readable summary. */
  readonly message: SafeMessage;
  /** HTTP status selected by the API adapter, normally 400-599. */
  readonly status: number;
  /** Optional request identifier safe to show in support flows. */
  readonly requestId?: string;
  /** Alias for clients that call the request identifier a correlation ID. */
  readonly correlationId?: CorrelationId;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  /** Small, non-sensitive field/value details only. */
  readonly details?: SafeDetails;
  /** Validation messages keyed by public field names. */
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
}

export interface ApiErrorResponse {
  readonly error: ApiError;
}

/** Compatibility aliases for route/service layers that used these names. */
export type ErrorResponse = ApiErrorResponse;
export type ApiErrorEnvelope = ApiErrorResponse;
export type StructuredApiError = ApiError;

/** A compact, safe failure summary for status endpoints and sync results. */
export interface SafeErrorSummary {
  readonly code: string;
  readonly message: SafeMessage;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

/** Legacy routes sometimes returned only a string. It is deliberately not an error contract. */
export interface LegacyErrorResponse {
  readonly error: string;
}
