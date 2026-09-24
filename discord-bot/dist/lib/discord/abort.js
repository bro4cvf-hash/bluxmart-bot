"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeAbortSignals = void 0;
exports.combineAbortSignals = combineAbortSignals;
const errors_1 = require("./errors");
/**
 * Combine any number of cancellation sources without relying on AbortSignal.any
 * (which is not available in every supported Node/runtime combination).
 */
function combineAbortSignals(...sources) {
    const controller = new AbortController();
    const listeners = [];
    const abortFrom = (source) => {
        if (controller.signal.aborted)
            return;
        controller.abort((0, errors_1.toAbortError)(source.reason));
    };
    for (const source of sources) {
        if (!source)
            continue;
        if (source.aborted) {
            abortFrom(source);
            break;
        }
        const listener = () => abortFrom(source);
        source.addEventListener('abort', listener, { once: true });
        listeners.push({ source, listener });
    }
    let disposed = false;
    return {
        signal: controller.signal,
        dispose: () => {
            if (disposed)
                return;
            disposed = true;
            for (const { source, listener } of listeners) {
                source.removeEventListener('abort', listener);
            }
            listeners.length = 0;
        },
    };
}
exports.mergeAbortSignals = combineAbortSignals;
