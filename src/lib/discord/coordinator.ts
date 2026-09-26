import { toAbortError } from './errors';

export type CoordinatorKey = string | number | symbol;

export interface CoordinatorContext<K extends CoordinatorKey = CoordinatorKey> {
  readonly key: K;
  /** Signal cancelled by cancel(key), not by an individual caller. */
  readonly signal: AbortSignal;
}

export interface CoordinatorRunOptions {
  /**
   * Cancels this caller's wait only. It never cancels a shared operation while
   * another caller is still waiting for the result.
   */
  readonly signal?: AbortSignal;
}

export type CoordinatorOptions = CoordinatorRunOptions | AbortSignal;

function normalizeCoordinatorOptions(
  options: CoordinatorOptions | undefined,
): CoordinatorRunOptions {
  if (!options) return {};
  if ('aborted' in options && typeof options.aborted === 'boolean') {
    return { signal: options as AbortSignal };
  }
  return options as CoordinatorRunOptions;
}

export type Operation<T = unknown, K extends CoordinatorKey = CoordinatorKey> = (
  context: CoordinatorContext<K>,
) => T | Promise<T>;

interface InFlight {
  readonly promise: Promise<unknown>;
  readonly controller: AbortController;
  waiters: number;
}

interface ExclusiveTail {
  readonly promise: Promise<void>;
  resolve: () => void;
}

/**
 * A per-key coordinator. Concurrent calls for one key share one operation and
 * one result; calls for different keys start independently. `withLock` is also
 * provided for callers that need a mutex without coalescing.
 */
export class KeyedCoordinator<K extends CoordinatorKey = CoordinatorKey> {
  private readonly inFlight = new Map<K, InFlight>();
  private readonly exclusiveTails = new Map<K, ExclusiveTail>();

  get size(): number {
    return this.inFlight.size;
  }

  has(key: K): boolean {
    return this.inFlight.has(key);
  }

  keys(): K[] {
    return [...this.inFlight.keys()];
  }

  run<T>(
    key: K,
    operation: (context: CoordinatorContext<K>) => T | Promise<T>,
    options: CoordinatorOptions = {},
  ): Promise<T> {
    const normalizedOptions = normalizeCoordinatorOptions(options);
    if (normalizedOptions.signal?.aborted) {
      return Promise.reject(toAbortError(normalizedOptions.signal.reason));
    }

    const current = this.inFlight.get(key);
    if (current) {
      if (normalizedOptions.signal) current.waiters += 1;
      return this.join(current, normalizedOptions.signal) as Promise<T>;
    }

    const controller = new AbortController();
    let entry!: InFlight;
    const operationPromise = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw toAbortError(controller.signal.reason);
        return operation({ key, signal: controller.signal });
      })
      .then(
        (value) => {
          this.remove(key, entry);
          return value;
        },
        (error) => {
          this.remove(key, entry);
          throw error;
        },
      );

    // A rejection is still returned to callers, but observing it here prevents
    // an unhandled-rejection report when a caller intentionally fire-and-forgets.
    operationPromise.catch(() => undefined);
    entry = { promise: operationPromise, controller, waiters: normalizedOptions.signal ? 1 : 0 };
    this.inFlight.set(key, entry);
    return this.join(entry, normalizedOptions.signal) as Promise<T>;
  }

  /** Start a new operation for a key after cancelling the previous one. */
  replace<T>(
    key: K,
    operation: (context: CoordinatorContext<K>) => T | Promise<T>,
    options: CoordinatorOptions = {},
  ): Promise<T> {
    const normalizedOptions = normalizeCoordinatorOptions(options);
    const previous = this.inFlight.get(key);
    if (previous && !previous.controller.signal.aborted) {
      previous.controller.abort(toAbortError('Operation replaced'));
    }
    if (normalizedOptions.signal?.aborted) {
      return Promise.reject(toAbortError(normalizedOptions.signal.reason));
    }

    const controller = new AbortController();
    let entry!: InFlight;
    const operationPromise = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw toAbortError(controller.signal.reason);
        return operation({ key, signal: controller.signal });
      })
      .then(
        (value) => {
          this.remove(key, entry);
          return value;
        },
        (error) => {
          this.remove(key, entry);
          throw error;
        },
      );
    operationPromise.catch(() => undefined);
    entry = { promise: operationPromise, controller, waiters: normalizedOptions.signal ? 1 : 0 };
    this.inFlight.set(key, entry);
    return this.join(entry, normalizedOptions.signal) as Promise<T>;
  }

  runReplacing<T>(
    key: K,
    operation: (context: CoordinatorContext<K>) => T | Promise<T>,
    options: CoordinatorOptions = {},
  ): Promise<T> {
    return this.replace(key, operation, options);
  }

  coalesce<T>(
    key: K,
    operation: (context: CoordinatorContext<K>) => T | Promise<T>,
    options: CoordinatorOptions = {},
  ): Promise<T> {
    return this.run(key, operation, options);
  }

  execute<T>(
    key: K,
    operation: (context: CoordinatorContext<K>) => T | Promise<T>,
    options: CoordinatorOptions = {},
  ): Promise<T> {
    return this.run(key, operation, options);
  }

  withKey<T>(
    key: K,
    operation: (context: CoordinatorContext<K>) => T | Promise<T>,
    options: CoordinatorOptions = {},
  ): Promise<T> {
    return this.run(key, operation, options);
  }

  /** Acquire the exclusive side of a key; the returned function is idempotent. */
  async acquire(key: K): Promise<() => void> {
    const previous = this.exclusiveTails.get(key);
    let resolveTail!: () => void;
    const tailPromise = new Promise<void>((resolve) => {
      resolveTail = resolve;
    });
    const tail: ExclusiveTail = { promise: tailPromise, resolve: resolveTail };
    this.exclusiveTails.set(key, tail);
    if (previous) await previous.promise;

    let released = false;
    return () => {
      if (released) return;
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
  async withLock<T>(
    key: K,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  lock<T>(key: K, operation: () => T | Promise<T>): Promise<T> {
    return this.withLock(key, operation);
  }

  runExclusive<T>(key: K, operation: () => T | Promise<T>): Promise<T> {
    return this.withLock(key, operation);
  }

  /** Cancel the shared operation. It remains keyed until the operation exits. */
  cancel(key: K, reason?: unknown): boolean {
    const entry = this.inFlight.get(key);
    if (!entry) return false;
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(toAbortError(reason));
    }
    return true;
  }

  clear(): void {
    // Keep entries until their operations settle. Removing an active entry
    // here would allow a second operation for the same key to overtake it.
    for (const entry of this.inFlight.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(toAbortError());
    }
  }

  private remove(key: K, entry: InFlight): void {
    if (this.inFlight.get(key) === entry) {
      this.inFlight.delete(key);
    }
  }

  private join<T>(entry: InFlight, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      return entry.promise as Promise<T>;
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        entry.waiters -= 1;
        signal.removeEventListener('abort', onAbort);
        action();
      };
      const onAbort = () => finish(() => reject(toAbortError(signal.reason)));

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (value) => finish(() => resolve(value as T)),
        (error) => finish(() => reject(error)),
      );
    });
  }
}

export const KeyedOperationCoordinator = KeyedCoordinator;
export const PerKeyCoordinator = KeyedCoordinator;
export const KeyedMutex = KeyedCoordinator;
export const AsyncKeyedCoordinator = KeyedCoordinator;
