"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toOperationResult = exports.err = exports.ok = exports.failureResult = void 0;
exports.success = success;
exports.reconciled = reconciled;
exports.unchanged = unchanged;
exports.pending = pending;
exports.failure = failure;
exports.isOperationSuccess = isOperationSuccess;
exports.isOperationFailure = isOperationFailure;
exports.mapOperationResult = mapOperationResult;
exports.captureOperationResult = captureOperationResult;
exports.unwrapOperationResult = unwrapOperationResult;
exports.describeError = describeError;
const errors_1 = require("./errors");
const retry_1 = require("./retry");
function success(value, options = {}) {
    return {
        ok: true,
        value,
        outcome: options.outcome ?? 'success',
        attempts: options.attempts ?? 1,
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    };
}
function reconciled(value, options = {}) {
    return success(value, { ...options, outcome: 'reconciled' });
}
function unchanged(value, options = {}) {
    return success(value, { ...options, outcome: 'unchanged' });
}
function pending(value, options = {}) {
    return success(value, { ...options, outcome: 'pending' });
}
function inferFailureOutcome(error) {
    if ((0, errors_1.isOperationTimeoutError)(error))
        return 'timed_out';
    if ((0, errors_1.isOperationAbortedError)(error))
        return 'aborted';
    const classification = (0, retry_1.classifyRetryableError)(error);
    if (classification.kind === 'aborted')
        return 'aborted';
    if (classification.status === 409)
        return 'conflict';
    if (classification.status !== undefined && classification.status >= 400 && classification.status < 500) {
        return 'rejected';
    }
    return 'failed';
}
function failure(error, options = {}) {
    const normalizedError = options.normalizedError ?? (0, retry_1.toOperationError)(error);
    return {
        ok: false,
        error,
        normalizedError,
        outcome: options.outcome ?? inferFailureOutcome(error),
        attempts: options.attempts ?? 1,
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    };
}
exports.failureResult = failure;
exports.ok = success;
exports.err = failure;
exports.toOperationResult = captureOperationResult;
function isOperationSuccess(result) {
    return result.ok;
}
function isOperationFailure(result) {
    return !result.ok;
}
function mapOperationResult(result, mapper) {
    return result.ok ? success(mapper(result.value), {
        outcome: result.outcome,
        attempts: result.attempts,
        ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    }) : failure(result.error, {
        outcome: result.outcome,
        attempts: result.attempts,
        normalizedError: result.normalizedError,
        ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    });
}
async function captureOperationResult(operation, options = {}) {
    try {
        return success(await operation(), options);
    }
    catch (error) {
        return failure(error, { attempts: options.attempts ?? 1 });
    }
}
function unwrapOperationResult(result) {
    if (result.ok)
        return result.value;
    if (result.error instanceof Error)
        throw result.error;
    throw new Error((0, errors_1.errorMessage)(result.error), { cause: result.error });
}
/** Convert a raw error without exposing implementation-specific error classes. */
function describeError(error) {
    return { name: (0, errors_1.errorName)(error), message: (0, errors_1.errorMessage)(error) };
}
