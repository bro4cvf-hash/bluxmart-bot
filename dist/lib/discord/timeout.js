"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.abortable = exports.withDeadline = exports.runWithTimeout = exports.delay = exports.systemTimerScheduler = void 0;
exports.waitForDelay = waitForDelay;
exports.withTimeout = withTimeout;
exports.withAbort = withAbort;
exports.deferred = deferred;
exports.isTimeoutOrAbortError = isTimeoutOrAbortError;
const errors_1 = require("./errors");
exports.systemTimerScheduler = {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => {
        if (handle !== undefined)
            globalThis.clearTimeout(handle);
    },
};
/**
 * Wait for a bounded delay. Production callers may use the default scheduler;
 * tests should inject a scheduler and invoke the callback themselves.
 */
function waitForDelay(delayMs, options = {}) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
        return Promise.reject(new RangeError('delayMs must be a finite non-negative number'));
    }
    const scheduler = options.scheduler ?? exports.systemTimerScheduler;
    const signal = options.signal;
    return new Promise((resolve, reject) => {
        let settled = false;
        let handle;
        let timerScheduled = false;
        let removeAbortListener;
        const cleanup = () => {
            if (timerScheduled)
                scheduler.clearTimeout(handle);
            removeAbortListener?.();
        };
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (error === undefined)
                resolve();
            else
                reject(error);
        };
        if (signal?.aborted) {
            finish((0, errors_1.toAbortError)(signal.reason));
            return;
        }
        if (signal) {
            const onAbort = () => finish((0, errors_1.toAbortError)(signal.reason));
            signal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        }
        let scheduledHandle;
        try {
            scheduledHandle = scheduler.setTimeout(() => finish(), delayMs);
        }
        catch (error) {
            finish(error);
            return;
        }
        handle = scheduledHandle;
        timerScheduled = true;
        // A deterministic scheduler may invoke zero-delay callbacks synchronously.
        // Clear the handle that becomes known only after that callback returns.
        if (settled)
            scheduler.clearTimeout(scheduledHandle);
    });
}
/** Short alias useful in retry adapters. */
exports.delay = waitForDelay;
function withTimeout(operation, optionsOrTimeout, externalSignal) {
    const options = typeof optionsOrTimeout === 'number'
        ? { timeoutMs: optionsOrTimeout, signal: externalSignal }
        : optionsOrTimeout;
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
        return Promise.reject(new RangeError('timeoutMs must be a finite non-negative number'));
    }
    const scheduler = options.scheduler ?? exports.systemTimerScheduler;
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        let timerScheduled = false;
        let removeExternalListener;
        const controller = new AbortController();
        const cleanup = () => {
            if (timerScheduled)
                scheduler.clearTimeout(timer);
            removeExternalListener?.();
        };
        const settle = (action) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            action();
        };
        const abortFromExternal = () => {
            const reason = (0, errors_1.toAbortError)(options.signal?.reason);
            controller.abort(reason);
            settle(() => reject(reason));
        };
        if (options.signal) {
            if (options.signal.aborted) {
                abortFromExternal();
                return;
            }
            options.signal.addEventListener('abort', abortFromExternal, { once: true });
            removeExternalListener = () => options.signal?.removeEventListener('abort', abortFromExternal);
        }
        const onDeadline = () => {
            const timeoutError = new errors_1.OperationTimeoutError(options.timeoutMs);
            controller.abort(timeoutError);
            // Cleanup callbacks must not turn a successful timeout into an unhandled
            // rejection. The operation race below remains the source of truth.
            void Promise.resolve()
                .then(() => options.onTimeout?.(controller.signal))
                .catch(() => undefined);
            settle(() => reject(timeoutError));
        };
        let scheduledTimer;
        try {
            scheduledTimer = scheduler.setTimeout(onDeadline, options.timeoutMs);
        }
        catch (error) {
            settle(() => reject(error));
            return;
        }
        timer = scheduledTimer;
        timerScheduled = true;
        if (settled)
            scheduler.clearTimeout(scheduledTimer);
        // Start in a microtask so an already-aborted signal can win consistently,
        // while still making the operation synchronous-call compatible.
        void Promise.resolve().then(() => {
            if (settled || controller.signal.aborted)
                return;
            return operation(controller.signal);
        }).then((value) => settle(() => resolve(value)), (error) => settle(() => reject(error)));
    });
}
exports.runWithTimeout = withTimeout;
exports.withDeadline = withTimeout;
/**
 * Abortable variant without a deadline. It is useful when a caller supplies an
 * external signal to a retry loop or a feature service.
 */
function withAbort(operation, signal) {
    if (signal.aborted)
        return Promise.reject((0, errors_1.toAbortError)(signal.reason));
    return new Promise((resolve, reject) => {
        let settled = false;
        const controller = new AbortController();
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const settle = (action) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            action();
        };
        const onAbort = () => {
            const reason = (0, errors_1.toAbortError)(signal.reason);
            controller.abort(reason);
            settle(() => reject(reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void Promise.resolve()
            .then(() => {
            if (settled || controller.signal.aborted)
                return undefined;
            return operation(controller.signal);
        })
            .then((value) => settle(() => resolve(value)), (error) => settle(() => reject(error)));
    });
}
exports.abortable = withAbort;
function deferred() {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}
/** True for either local timeout or caller cancellation. */
function isTimeoutOrAbortError(error) {
    return error instanceof errors_1.OperationTimeoutError || (0, errors_1.isAbortError)(error);
}
