import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OperationAbortedError,
  OperationTimeoutError,
} from '../../src/lib/discord/errors';
import { combineAbortSignals } from '../../src/lib/discord/abort';
import {
  deferred,
  withAbort,
  withTimeout,
  type TimerScheduler,
} from '../../src/lib/discord/timeout';

class ManualScheduler implements TimerScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, { callback: () => void; delayMs: number }>();
  readonly cleared: number[] = [];

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.cleared.push(handle);
      this.callbacks.delete(handle);
    }
  }

  pending(): Array<{ handle: number; delayMs: number }> {
    return [...this.callbacks.entries()].map(([handle, entry]) => ({
      handle,
      delayMs: entry.delayMs,
    }));
  }

  fire(handle: number): void {
    const entry = this.callbacks.get(handle);
    if (!entry) return;
    this.callbacks.delete(handle);
    entry.callback();
  }
}

test('cleans the timeout handle when an operation settles', async () => {
  const scheduler = new ManualScheduler();
  const result = await withTimeout(
    async () => 'ok',
    { timeoutMs: 50, scheduler },
  );

  assert.equal(result, 'ok');
  assert.equal(scheduler.pending().length, 0);
  assert.equal(scheduler.cleared.length, 1);
});

test('times out, aborts the operation signal, and settles the promise', async () => {
  const scheduler = new ManualScheduler();
  const gate = deferred<string>();
  let operationSignal: AbortSignal | undefined;
  const promise = withTimeout(
    (signal) => {
      operationSignal = signal;
      return gate.promise;
    },
    { timeoutMs: 25, scheduler },
  );

  await Promise.resolve();
  const timer = scheduler.pending()[0];
  assert.ok(timer);
  scheduler.fire(timer.handle);

  await assert.rejects(promise, (error) => error instanceof OperationTimeoutError);
  assert.equal(operationSignal?.aborted, true);
  gate.resolve('late result');
  assert.equal(scheduler.pending().length, 0);
});

test('external cancellation rejects and removes the timeout listener', async () => {
  const scheduler = new ManualScheduler();
  const controller = new AbortController();
  const gate = deferred<void>();
  const promise = withTimeout(
    () => gate.promise,
    { timeoutMs: 100, signal: controller.signal, scheduler },
  );

  controller.abort();
  await assert.rejects(promise, (error) => error instanceof OperationAbortedError);
  assert.equal(scheduler.pending().length, 0);
  gate.resolve();
});

test('withAbort propagates cancellation without a real wait', async () => {
  const controller = new AbortController();
  const gate = deferred<string>();
  const promise = withAbort(() => gate.promise, controller.signal);
  controller.abort();
  await assert.rejects(promise, (error) => error instanceof OperationAbortedError);
  gate.resolve('late');
});

test('combines and disposes abort sources', () => {
  const first = new AbortController();
  const second = new AbortController();
  const linked = combineAbortSignals(first.signal, second.signal);
  first.abort();
  assert.equal(linked.signal.aborted, true);
  linked.dispose();
  second.abort();
});
