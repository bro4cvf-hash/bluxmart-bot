"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEGACY_API_ERROR_CODES = exports.API_ERROR_CODES = void 0;
exports.API_ERROR_CODES = [
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
];
/** Codes emitted by early route handlers before the canonical vocabulary existed. */
exports.LEGACY_API_ERROR_CODES = [
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
];
