"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_RETRY_ATTEMPTS = exports.createWithReconciliation = exports.retryWithReconciliation = exports.retryNonIdempotent = exports.executeWithRetry = exports.withRetry = exports.normalizeError = exports.isRetryable = exports.classifyHttpError = exports.classifyError = exports.systemRetryWaiter = exports.RetryConfigurationError = void 0;
exports.classifyRetryableError = classifyRetryableError;
exports.isRetryableError = isRetryableError;
exports.isRetryableStatus = isRetryableStatus;
exports.toOperationError = toOperationError;
exports.retryIdempotent = retryIdempotent;
exports.retryWithSignal = retryWithSignal;
exports.retryCreate = retryCreate;
exports.retryCreateWithSignal = retryCreateWithSignal;
const errors_1 = require("./errors");
const timeout_1 = require("./timeout");
var errors_2 = require("./errors");
Object.defineProperty(exports, "RetryConfigurationError", { enumerable: true, get: function () { return errors_2.RetryConfigurationError; } });
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ALLOWED_ATTEMPTS = 20;
exports.MAX_RETRY_ATTEMPTS = MAX_ALLOWED_ATTEMPTS;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const systemRetryWaiter = (delayMs, signal, scheduler) => (0, timeout_1.waitForDelay)(delayMs, { signal, scheduler });
exports.systemRetryWaiter = systemRetryWaiter;
function numericStatus(error) {
    const status = (0, errors_1.errorStatus)(error);
    return status !== undefined && Number.isFinite(status) && status >= 100
        ? status
        : undefined;
}
function normalizedCode(error) {
    return ((0, errors_1.errorCode)(error) ?? '').toUpperCase();
}
function normalizedName(error) {
    return (0, errors_1.errorName)(error).toUpperCase();
}
const NETWORK_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);
function looksLikeNetworkError(error, status) {
    if (status !== undefined)
        return false;
    const code = normalizedCode(error);
    const name = normalizedName(error);
    if (NETWORK_CODES.has(code))
        return true;
    if (name === 'FETCHERROR' ||
        name === 'NETWORKERROR' ||
        name === 'REQUESTERROR' ||
        name === 'TIMEOUTERROR' ||
        name === 'SOCKETERROR') {
        return true;
    }
    const message = (0, errors_1.errorMessage)(error).toLowerCase();
    return (message.includes('fetch failed') ||
        message.includes('network error') ||
        message.includes('socket hang up') ||
        message.includes('connection reset') ||
        message.includes('connection refused') ||
        message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('temporarily unavailable'));
}
function makeClassification(retryable, kind, reason, error, status) {
    const code = (0, errors_1.errorCode)(error);
    const retryAfterMs = (0, errors_1.errorRetryAfterMs)(error);
    return {
        retryable,
        kind,
        status,
        code,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        reason,
    };
}
/**
 * Classify thrown values without importing a Discord client. HTTP 429 and 5xx,
 * network/timeout failures, and transient request timeouts are retryable.
 * Ordinary 4xx responses are permanent; caller cancellation is never retried.
 */
function classifyRetryableError(error) {
    const status = numericStatus(error);
    const code = normalizedCode(error);
    const name = normalizedName(error);
    // Prefer an explicit HTTP response over an incidental error code. A 400/403
    // response is permanent even if a client happened to attach ETIMEDOUT.
    if (status === 429 || (status === undefined && (code === 'TOO_MANY_REQUESTS' || code === 'RATE_LIMITED'))) {
        return makeClassification(true, 'rate-limit', 'The remote service reported a rate limit.', error, status);
    }
    if (status !== undefined && status >= 500 && status <= 599) {
        return makeClassification(true, 'server', 'The remote service reported a server error.', error, status);
    }
    // 408 and 425 are request-level transient failures even though their HTTP
    // status is in the 4xx range. All other 4xx responses are permanent.
    if (status === 408 || status === 425) {
        return makeClassification(true, 'network', 'The request was transiently unavailable.', error, status);
    }
    if (status !== undefined && status >= 400 && status <= 499) {
        return makeClassification(false, 'client', 'The remote service rejected the request permanently.', error, status);
    }
    if ((0, errors_1.isOperationTimeoutError)(error) || name === 'TIMEOUTERROR' || code === 'ETIMEDOUT') {
        return makeClassification(true, 'timeout', 'The operation reached its local or request timeout.', error, status);
    }
    if ((0, errors_1.isAbortError)(error)) {
        return makeClassification(false, 'aborted', 'The caller cancelled the operation.', error, status);
    }
    if (looksLikeNetworkError(error, status)) {
        return makeClassification(true, 'network', 'The network request failed before a permanent response was received.', error, status);
    }
    return makeClassification(false, 'unknown', 'The error is not known to be safely retryable.', error, status);
}
function isRetryableError(error) {
    return classifyRetryableError(error).retryable;
}
exports.classifyError = classifyRetryableError;
exports.classifyHttpError = classifyRetryableError;
exports.isRetryable = isRetryableError;
function isRetryableStatus(status) {
    return Number.isInteger(status) && (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599));
}
function toOperationError(error, classification = classifyRetryableError(error)) {
    return {
        name: (0, errors_1.errorName)(error),
        message: (0, errors_1.errorMessage)(error),
        ...(classification.code === undefined ? {} : { code: classification.code }),
        ...(classification.status === undefined ? {} : { status: classification.status }),
        retryable: classification.retryable,
        retryClass: classification.kind,
        ...(classification.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: classification.retryAfterMs }),
    };
}
exports.normalizeError = toOperationError;
function resolveMaxAttempts(options) {
    if (options.maxAttempts !== undefined && options.maxRetries !== undefined) {
        const implied = options.maxRetries + 1;
        if (options.maxAttempts !== implied) {
            throw new errors_1.RetryConfigurationError('maxAttempts and maxRetries must describe the same retry bound');
        }
    }
    const value = options.maxAttempts ?? (options.maxRetries !== undefined ? options.maxRetries + 1 : DEFAULT_MAX_ATTEMPTS);
    if (!Number.isInteger(value) || value < 1 || value > MAX_ALLOWED_ATTEMPTS) {
        throw new errors_1.RetryConfigurationError(`maxAttempts must be an integer between 1 and ${MAX_ALLOWED_ATTEMPTS}`);
    }
    return value;
}
function resolveNumber(value, fallback, name) {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved < 0) {
        throw new errors_1.RetryConfigurationError(`${name} must be a finite non-negative number`);
    }
    return resolved;
}
function validateRetryOptions(options) {
    resolveMaxAttempts(options);
    resolveNumber(options.baseDelayMs, DEFAULT_BASE_DELAY_MS, 'baseDelayMs');
    resolveNumber(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, 'maxDelayMs');
    const factor = resolveNumber(options.backoffFactor, DEFAULT_BACKOFF_FACTOR, 'backoffFactor');
    const jitter = resolveNumber(options.jitter, 0, 'jitter');
    if (factor < 1)
        throw new errors_1.RetryConfigurationError('backoffFactor must be at least 1');
    if (jitter > 1)
        throw new errors_1.RetryConfigurationError('jitter must be between 0 and 1');
}
function retryDelay(attempt, classification, options) {
    const base = resolveNumber(options.baseDelayMs, DEFAULT_BASE_DELAY_MS, 'baseDelayMs');
    const maximum = resolveNumber(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, 'maxDelayMs');
    const factor = resolveNumber(options.backoffFactor, DEFAULT_BACKOFF_FACTOR, 'backoffFactor');
    const jitter = resolveNumber(options.jitter, 0, 'jitter');
    if (factor < 1) {
        throw new errors_1.RetryConfigurationError('backoffFactor must be at least 1');
    }
    if (jitter > 1) {
        throw new errors_1.RetryConfigurationError('jitter must be between 0 and 1');
    }
    const exponential = Math.min(maximum, base * factor ** Math.max(0, attempt - 1));
    const serverHint = options.respectRetryAfter === false
        ? undefined
        : classification.retryAfterMs;
    let delay = serverHint === undefined
        ? exponential
        : Math.min(maximum, Math.max(0, serverHint));
    if (jitter > 0 && delay > 0) {
        const random = options.random ?? Math.random;
        const sample = random();
        if (!Number.isFinite(sample)) {
            throw new errors_1.RetryConfigurationError('random must return a finite number');
        }
        const normalized = Math.min(1, Math.max(0, sample));
        delay = Math.min(maximum, Math.max(0, delay * (1 - jitter + 2 * jitter * normalized)));
    }
    return Math.min(maximum, Math.max(0, delay));
}
function linkExternalSignal(signal, controller) {
    if (!signal)
        return () => undefined;
    const onAbort = () => controller.abort((0, errors_1.toAbortError)(signal.reason));
    if (signal.aborted)
        onAbort();
    else
        signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
}
function throwForSignal(signal) {
    throw (0, errors_1.toAbortError)(signal.reason);
}
async function runRetryLoop(operation, options, reconciliation) {
    validateRetryOptions(options);
    const maxAttempts = resolveMaxAttempts(options);
    const controller = new AbortController();
    const unlink = linkExternalSignal(options.signal, controller);
    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (controller.signal.aborted)
                throwForSignal(controller.signal);
            try {
                return await (0, timeout_1.withAbort)(() => operation({
                    attempt,
                    maxAttempts,
                    signal: controller.signal,
                }), controller.signal);
            }
            catch (error) {
                if (controller.signal.aborted)
                    throwForSignal(controller.signal);
                const classification = classifyRetryableError(error);
                if (!classification.retryable)
                    throw error;
                const delayMs = retryDelay(attempt, classification, options);
                const context = {
                    error,
                    classification,
                    attempt,
                    nextAttempt: attempt + 1,
                    maxAttempts,
                    signal: controller.signal,
                    delayMs,
                };
                if (options.shouldRetry &&
                    !(await (0, timeout_1.withAbort)(() => options.shouldRetry(error, context), controller.signal))) {
                    throw error;
                }
                if (controller.signal.aborted)
                    throwForSignal(controller.signal);
                if (reconciliation) {
                    const decision = await (0, timeout_1.withAbort)(() => reconciliation(context), controller.signal);
                    if (decision.kind === 'resolved') {
                        return decision.value;
                    }
                    if (decision.kind === 'failed') {
                        throw decision.error;
                    }
                    if (decision.kind !== 'retry') {
                        throw new errors_1.RetryConfigurationError('reconcile returned an unsupported decision');
                    }
                }
                if (controller.signal.aborted)
                    throwForSignal(controller.signal);
                if (attempt >= maxAttempts)
                    throw error;
                if (options.onRetry) {
                    await (0, timeout_1.withAbort)(() => options.onRetry(context), controller.signal);
                }
                if (delayMs > 0) {
                    const waiter = options.wait ?? exports.systemRetryWaiter;
                    await (0, timeout_1.withAbort)(() => waiter(delayMs, controller.signal, options.scheduler), controller.signal);
                }
            }
        }
        // The loop always returns or throws. This is only for type-checking and to
        // make an unexpected future control-flow change explicit.
        throw new errors_1.RetryConfigurationError('retry loop completed without a result');
    }
    finally {
        unlink();
    }
}
/**
 * Retry an idempotent operation. This function is intentionally named
 * idempotent so a create call cannot be accidentally passed to it.
 */
function retryIdempotent(operation, options = {}) {
    return runRetryLoop(operation, options);
}
/** Explicit aliases retain the idempotent-only contract in their names/docs. */
exports.withRetry = retryIdempotent;
exports.executeWithRetry = retryIdempotent;
/** Signal-first convenience form for adapters which pass AbortSignal to a client. */
function retryWithSignal(operation, options = {}) {
    return retryIdempotent((context) => operation(context.signal, context), options);
}
function parseReconciliationDecision(value) {
    if (!value || typeof value !== 'object' || !('kind' in value)) {
        throw new errors_1.RetryConfigurationError('reconcile must return { kind: "resolved", value }, { kind: "retry" }, or { kind: "failed", error }');
    }
    if (value.kind === 'resolved' && !('value' in value)) {
        throw new errors_1.RetryConfigurationError('a resolved reconciliation decision must include value');
    }
    if (value.kind !== 'resolved' && value.kind !== 'retry' && value.kind !== 'failed') {
        throw new errors_1.RetryConfigurationError('reconcile returned an unsupported decision');
    }
    if (value.kind === 'failed' && !('error' in value)) {
        throw new errors_1.RetryConfigurationError('a failed reconciliation decision must include error');
    }
    return value;
}
/**
 * Retry a non-idempotent create only after a reconciliation callback has had a
 * chance to discover an already-created resource. A missing callback is a
 * configuration error and no blind create retry is performed.
 */
function retryCreate(operation, options) {
    if (!options || typeof options.reconcile !== 'function') {
        return Promise.reject(new errors_1.RetryConfigurationError('Non-idempotent create operations require a reconcile callback'));
    }
    return runRetryLoop(operation, options, async (context) => {
        const decision = parseReconciliationDecision(await options.reconcile(context));
        if (decision.kind === 'resolved')
            return { kind: 'resolved', value: decision.value };
        return decision;
    });
}
exports.retryNonIdempotent = retryCreate;
exports.retryWithReconciliation = retryCreate;
exports.createWithReconciliation = retryCreate;
function retryCreateWithSignal(operation, options) {
    return retryCreate((context) => operation(context.signal, context), options);
}
