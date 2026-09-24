"use strict";
/** Error values and dependency-free extraction helpers. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AbortError = exports.TimeoutError = exports.RetryConfigurationError = exports.OperationAbortedError = exports.OperationTimeoutError = void 0;
exports.isOperationTimeoutError = isOperationTimeoutError;
exports.isOperationAbortedError = isOperationAbortedError;
exports.isAbortError = isAbortError;
exports.errorMessage = errorMessage;
exports.errorName = errorName;
exports.errorCode = errorCode;
exports.errorStatus = errorStatus;
exports.errorRetryAfterMs = errorRetryAfterMs;
exports.errorCause = errorCause;
exports.toAbortError = toAbortError;
exports.throwIfAborted = throwIfAborted;
class OperationTimeoutError extends Error {
    code = 'ETIMEDOUT';
    timeoutMs;
    constructor(timeoutMs, message = `Operation timed out after ${timeoutMs}ms`) {
        super(message);
        this.name = 'TimeoutError';
        this.timeoutMs = timeoutMs;
    }
}
exports.OperationTimeoutError = OperationTimeoutError;
exports.TimeoutError = OperationTimeoutError;
class OperationAbortedError extends Error {
    code = 'ABORT_ERR';
    reason;
    cause;
    constructor(message = 'Operation was aborted', reason) {
        super(message);
        this.name = 'AbortError';
        this.reason = reason;
        this.cause = reason;
    }
}
exports.OperationAbortedError = OperationAbortedError;
exports.AbortError = OperationAbortedError;
class RetryConfigurationError extends Error {
    code = 'ERR_RETRY_CONFIGURATION';
    constructor(message) {
        super(message);
        this.name = 'RetryConfigurationError';
    }
}
exports.RetryConfigurationError = RetryConfigurationError;
function isOperationTimeoutError(error) {
    return error instanceof OperationTimeoutError;
}
function isOperationAbortedError(error) {
    return error instanceof OperationAbortedError;
}
function isAbortError(error) {
    if (isOperationAbortedError(error))
        return true;
    if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
        return true;
    if (!error || typeof error !== 'object')
        return false;
    const value = error;
    if (value.name === 'AbortError' || value.code === 'ABORT_ERR')
        return true;
    return typeof value.message === 'string' && /\babort(?:ed)?\b/i.test(value.message);
}
function errorMessage(error) {
    if (error instanceof Error && error.message)
        return error.message;
    if (typeof error === 'string' && error.length > 0)
        return error;
    try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== '{}')
            return serialized;
    }
    catch {
        // Some thrown values contain cycles or unsupported values.
    }
    return String(error);
}
function errorName(error) {
    if (error && typeof error === 'object' && 'name' in error) {
        const name = error.name;
        if (typeof name === 'string' && name.length > 0)
            return name;
    }
    return error instanceof Error ? error.name : 'Error';
}
function errorCode(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const value = error.code;
    if (typeof value === 'string' && value.length > 0)
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return undefined;
}
function asRecord(value) {
    return value !== null && typeof value === 'object'
        ? value
        : undefined;
}
function finiteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
function statusFromRecord(record) {
    if (!record)
        return undefined;
    const direct = finiteNumber(record.status) ?? finiteNumber(record.statusCode);
    if (direct !== undefined)
        return direct;
    const response = asRecord(record.response);
    if (response) {
        const nested = finiteNumber(response.status) ?? finiteNumber(response.statusCode);
        if (nested !== undefined)
            return nested;
        const raw = asRecord(response.raw);
        if (raw) {
            const rawStatus = finiteNumber(raw.status) ?? finiteNumber(raw.statusCode);
            if (rawStatus !== undefined)
                return rawStatus;
        }
    }
    return undefined;
}
function errorStatus(error) {
    return statusFromRecord(asRecord(error));
}
function firstNumber(values) {
    for (const value of values) {
        const parsed = finiteNumber(value);
        if (parsed !== undefined)
            return parsed;
    }
    return undefined;
}
function headerValue(headers, name) {
    if (!headers)
        return undefined;
    const get = headers.get;
    if (typeof get === 'function') {
        try {
            const value = get.call(headers, name);
            if (value !== null && value !== undefined)
                return value;
        }
        catch {
            // Fall through to object/Map inspection.
        }
    }
    if (headers instanceof Map) {
        const direct = headers.get(name) ?? headers.get(name.toLowerCase());
        if (direct !== undefined)
            return direct;
        const wanted = name.toLowerCase();
        for (const [key, value] of headers) {
            if (String(key).toLowerCase() === wanted)
                return value;
        }
        return undefined;
    }
    const record = asRecord(headers);
    if (!record)
        return undefined;
    const direct = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
    if (direct !== undefined)
        return direct;
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(record)) {
        if (key.toLowerCase() === wanted)
            return value;
    }
    return undefined;
}
function responseHeaders(error) {
    const record = asRecord(error);
    if (!record)
        return undefined;
    const response = asRecord(record.response);
    return response?.headers ?? record.headers;
}
function normalizeRetryAfterValue(value, now = Date.now()) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, value);
    }
    if (typeof value !== 'string' || value.trim() === '')
        return undefined;
    const numeric = Number(value);
    if (Number.isFinite(numeric))
        return Math.max(0, numeric);
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp))
        return Math.max(0, timestamp - now);
    return undefined;
}
/**
 * Read common HTTP/Discord retry hints. Discord's `retry_after` is expressed in
 * seconds; explicit `retryAfterMs`/`retry_after_ms` values are milliseconds.
 */
function errorRetryAfterMs(error, now = Date.now()) {
    const record = asRecord(error);
    if (!record)
        return undefined;
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
    if (explicit !== undefined)
        return Math.max(0, explicit);
    const seconds = firstNumber([
        record.retry_after,
        record.retryAfter,
        responseData?.retry_after,
        responseData?.retryAfter,
        raw?.retry_after,
        raw?.retryAfter,
    ]);
    if (seconds !== undefined)
        return Math.max(0, seconds * 1000);
    const header = headerValue(responseHeaders(error), 'retry-after');
    return normalizeRetryAfterValue(header, now);
}
function errorCause(error) {
    if (error && typeof error === 'object' && 'cause' in error) {
        return error.cause;
    }
    return undefined;
}
function toAbortError(reason) {
    if (isOperationAbortedError(reason))
        return reason;
    if (reason instanceof Error && reason.message) {
        const error = new OperationAbortedError(reason.message, reason);
        return error;
    }
    return new OperationAbortedError(reason === undefined ? 'Operation was aborted' : `Operation was aborted: ${String(reason)}`, reason);
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw toAbortError(signal.reason);
}
