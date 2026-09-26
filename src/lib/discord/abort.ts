import { toAbortError } from './errors';

export interface LinkedAbortSignal {
  readonly signal: AbortSignal;
  /** Remove all source listeners; safe to call more than once. */
  dispose(): void;
}

/**
 * Combine any number of cancellation sources without relying on AbortSignal.any
 * (which is not available in every supported Node/runtime combination).
 */
export function combineAbortSignals(
  ...sources: readonly (AbortSignal | undefined)[]
): LinkedAbortSignal {
  const controller = new AbortController();
  const listeners: Array<{ source: AbortSignal; listener: () => void }> = [];

  const abortFrom = (source: AbortSignal) => {
    if (controller.signal.aborted) return;
    controller.abort(toAbortError(source.reason));
  };

  for (const source of sources) {
    if (!source) continue;
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
      if (disposed) return;
      disposed = true;
      for (const { source, listener } of listeners) {
        source.removeEventListener('abort', listener);
      }
      listeners.length = 0;
    },
  };
}

export const mergeAbortSignals = combineAbortSignals;
