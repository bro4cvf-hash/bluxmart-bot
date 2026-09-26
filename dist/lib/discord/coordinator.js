"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsyncKeyedCoordinator = exports.KeyedMutex = exports.PerKeyCoordinator = exports.KeyedOperationCoordinator = exports.KeyedCoordinator = void 0;
const errors_1 = require("./errors");
function normalizeCoordinatorOptions(options) {
    if (!options)
        return {};
    if ('aborted' in options && typeof options.aborted === 'boolean') {
        return { signal: options };
    }
    return options;
}
/**
 * A per-key coordinator. Concurrent calls for one key share one operation and
 * one result; calls for different keys start independently. `withLock` is also
 * provided for callers that need a mutex without coalescing.
 */
class KeyedCoordinator {
    inFlight = new Map();
    exclusiveTails = new Map();
    get size() {
        return this.inFlight.size;
    }
    has(key) {
        return this.inFlight.has(key);
    }
    keys() {
        return [...this.inFlight.keys()];
    }
    run(key, operation, options = {}) {
        const normalizedOptions = normalizeCoordinatorOptions(options);
        if (normalizedOptions.signal?.aborted) {
            return Promise.reject((0, errors_1.toAbortError)(normalizedOptions.signal.reason));
        }
        const current = this.inFlight.get(key);
        if (current) {
            if (normalizedOptions.signal)
                current.waiters += 1;
            return this.join(current, normalizedOptions.signal);
        }
        const controller = new AbortController();
        let entry;
        const operationPromise = Promise.resolve()
            .then(() => {
            if (controller.signal.aborted)
                throw (0, errors_1.toAbortError)(controller.signal.reason);
            return operation({ key, signal: controller.signal });
        })
            .then((value) => {
            this.remove(key, entry);
            return value;
        }, (error) => {
            this.remove(key, entry);
            throw error;
        });
        // A rejection is still returned to callers, but observing it here prevents
        // an unhandled-rejection report when a caller intentionally fire-and-forgets.
        operationPromise.catch(() => undefined);
        entry = { promise: operationPromise, controller, waiters: normalizedOptions.signal ? 1 : 0 };
        this.inFlight.set(key, entry);
        return this.join(entry, normalizedOptions.signal);
    }
    /** Start a new operation for a key after cancelling the previous one. */
    replace(key, operation, options = {}) {
        const normalizedOptions = normalizeCoordinatorOptions(options);
        const previous = this.inFlight.get(key);
        if (previous && !previous.controller.signal.aborted) {
            previous.controller.abort((0, errors_1.toAbortError)('Operation replaced'));
        }
        if (normalizedOptions.signal?.aborted) {
            return Promise.reject((0, errors_1.toAbortError)(normalizedOptions.signal.reason));
        }
        const controller = new AbortController();
        let entry;
        const operationPromise = Promise.resolve()
            .then(() => {
            if (controller.signal.aborted)
                throw (0, errors_1.toAbortError)(controller.signal.reason);
            return operation({ key, signal: controller.signal });
        })
            .then((value) => {
            this.remove(key, entry);
            return value;
        }, (error) => {
            this.remove(key, entry);
            throw error;
        });
        operationPromise.catch(() => undefined);
        entry = { promise: operationPromise, controller, waiters: normalizedOptions.signal ? 1 : 0 };
        this.inFlight.set(key, entry);
        return this.join(entry, normalizedOptions.signal);
    }
    runReplacing(key, operation, options = {}) {
        return this.replace(key, operation, options);
    }
    coalesce(key, operation, options = {}) {
        return this.run(key, operation, options);
    }
    execute(key, operation, options = {}) {
        return this.run(key, operation, options);
    }
    withKey(key, operation, options = {}) {
        return this.run(key, operation, options);
    }
    /** Acquire the exclusive side of a key; the returned function is idempotent. */
    async acquire(key) {
        const previous = this.exclusiveTails.get(key);
        let resolveTail;
        const tailPromise = new Promise((resolve) => {
            resolveTail = resolve;
        });
        const tail = { promise: tailPromise, resolve: resolveTail };
        this.exclusiveTails.set(key, tail);
        if (previous)
            await previous.promise;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            tail.resolve();
            if (this.exclusiveTails.get(key) === tail) {
                this.exclusiveTails.delete(key);
            }
        };
    }
    /**
     * Run operations serially for a key without coalescing them. Different keys
     * remain independent. The lock is always released in a finally block.
     */
    async withLock(key, operation) {
        const release = await this.acquire(key);
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
    lock(key, operation) {
        return this.withLock(key, operation);
    }
    runExclusive(key, operation) {
        return this.withLock(key, operation);
    }
    /** Cancel the shared operation. It remains keyed until the operation exits. */
    cancel(key, reason) {
        const entry = this.inFlight.get(key);
        if (!entry)
            return false;
        if (!entry.controller.signal.aborted) {
            entry.controller.abort((0, errors_1.toAbortError)(reason));
        }
        return true;
    }
    clear() {
        // Keep entries until their operations settle. Removing an active entry
        // here would allow a second operation for the same key to overtake it.
        for (const entry of this.inFlight.values()) {
            if (!entry.controller.signal.aborted)
                entry.controller.abort((0, errors_1.toAbortError)());
        }
    }
    remove(key, entry) {
        if (this.inFlight.get(key) === entry) {
            this.inFlight.delete(key);
        }
    }
    join(entry, signal) {
        if (!signal) {
            return entry.promise;
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (action) => {
                if (settled)
                    return;
                settled = true;
                entry.waiters -= 1;
                signal.removeEventListener('abort', onAbort);
                action();
            };
            const onAbort = () => finish(() => reject((0, errors_1.toAbortError)(signal.reason)));
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            entry.promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
        });
    }
}
exports.KeyedCoordinator = KeyedCoordinator;
exports.KeyedOperationCoordinator = KeyedCoordinator;
exports.PerKeyCoordinator = KeyedCoordinator;
exports.KeyedMutex = KeyedCoordinator;
exports.AsyncKeyedCoordinator = KeyedCoordinator;
