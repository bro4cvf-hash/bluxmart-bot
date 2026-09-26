import {
  OperationTimeoutError,
  isAbortError,
  toAbortError,
} from './errors';

/** Injectable timer surface used by deterministic tests. */
export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimerScheduler: TimerScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    if (handle !== undefined) globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface WaitOptions {
  readonly signal?: AbortSignal;
  /** A fake scheduler can be supplied without changing global timers. */
  readonly scheduler?: TimerScheduler;
}

/**
 * Wait for a bounded delay. Production callers may use the default scheduler;
 * tests should inject a scheduler and invoke the callback themselves.
 */
export function waitForDelay(delayMs: number, options: WaitOptions = {}): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return Promise.reject(new RangeError('delayMs must be a finite non-negative number'));
  }

  const scheduler = options.scheduler ?? systemTimerScheduler;
  const signal = options.signal;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let handle: unknown;
    let timerScheduled = false;
    let removeAbortListener: (() => void) | undefined;

    const cleanup = () => {
      if (timerScheduled) scheduler.clearTimeout(handle);
      removeAbortListener?.();
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };

    if (signal?.aborted) {
      finish(toAbortError(signal.reason));
      return;
    }

    if (signal) {
      const onAbort = () => finish(toAbortError(signal.reason));
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }

    let scheduledHandle: unknown;
    try {
      scheduledHandle = scheduler.setTimeout(() => finish(), delayMs);
    } catch (error) {
      finish(error);
      return;
    }
    handle = scheduledHandle;
    timerScheduled = true;
    // A deterministic scheduler may invoke zero-delay callbacks synchronously.
    // Clear the handle that becomes known only after that callback returns.
    if (settled) scheduler.clearTimeout(scheduledHandle);
  });
}

/** Short alias useful in retry adapters. */
export const delay = waitForDelay;

export interface TimeoutOptions extends WaitOptions {
  readonly timeoutMs: number;
  /**
   * Runs after the timeout signal is aborted. Its result is intentionally not
   * awaited: the caller is already required to fail at the deadline.
   */
  readonly onTimeout?: (signal: AbortSignal) => void | Promise<void>;
}

export type TimedOperation<T> = (signal: AbortSignal) => T | Promise<T>;

/**
 * Run an operation with a deadline and always remove the timer and abort
 * listener. The operation receives a signal which is aborted on either an
 * external cancellation or the local deadline.
 */
export function withTimeout<T>(
  operation: TimedOperation<T>,
  options: TimeoutOptions,
): Promise<T>;
export function withTimeout<T>(
  operation: TimedOperation<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T>;
export function withTimeout<T>(
  operation: TimedOperation<T>,
  optionsOrTimeout: TimeoutOptions | number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const options: TimeoutOptions =
    typeof optionsOrTimeout === 'number'
      ? { timeoutMs: optionsOrTimeout, signal: externalSignal }
      : optionsOrTimeout;

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    return Promise.reject(new RangeError('timeoutMs must be a finite non-negative number'));
  }

  const scheduler = options.scheduler ?? systemTimerScheduler;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: unknown;
    let timerScheduled = false;
    let removeExternalListener: (() => void) | undefined;
    const controller = new AbortController();

    const cleanup = () => {
      if (timerScheduled) scheduler.clearTimeout(timer);
      removeExternalListener?.();
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const abortFromExternal = () => {
      const reason = toAbortError(options.signal?.reason);
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
      const timeoutError = new OperationTimeoutError(options.timeoutMs);
      controller.abort(timeoutError);
      // Cleanup callbacks must not turn a successful timeout into an unhandled
      // rejection. The operation race below remains the source of truth.
      void Promise.resolve()
        .then(() => options.onTimeout?.(controller.signal))
        .catch(() => undefined);
      settle(() => reject(timeoutError));
    };
    let scheduledTimer: unknown;
    try {
      scheduledTimer = scheduler.setTimeout(onDeadline, options.timeoutMs);
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    timer = scheduledTimer;
    timerScheduled = true;
    if (settled) scheduler.clearTimeout(scheduledTimer);

    // Start in a microtask so an already-aborted signal can win consistently,
    // while still making the operation synchronous-call compatible.
    void Promise.resolve().then(() => {
      if (settled || controller.signal.aborted) return;
      return operation(controller.signal);
    }).then(
      (value) => settle(() => resolve(value as T)),
      (error) => settle(() => reject(error)),
    );

  });
}

export const runWithTimeout = withTimeout;
export const withDeadline = withTimeout;

/**
 * Abortable variant without a deadline. It is useful when a caller supplies an
 * external signal to a retry loop or a feature service.
 */
export function withAbort<T>(
  operation: TimedOperation<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(toAbortError(signal.reason));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const controller = new AbortController();
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = () => {
      const reason = toAbortError(signal.reason);
      controller.abort(reason);
      settle(() => reject(reason));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve()
      .then(() => {
        if (settled || controller.signal.aborted) return undefined;
        return operation(controller.signal);
      })
      .then(
        (value) => settle(() => resolve(value as T)),
        (error) => settle(() => reject(error)),
      );
  });
}

export const abortable = withAbort;

/** A tiny deterministic deferred useful in fakes and tests. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** True for either local timeout or caller cancellation. */
export function isTimeoutOrAbortError(error: unknown): boolean {
  return error instanceof OperationTimeoutError || isAbortError(error);
}
