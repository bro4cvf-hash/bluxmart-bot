import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRetryableError,
  isRetryableError,
  retryCreate,
  retryIdempotent,
  RetryConfigurationError,
  type CreateRetryOptions,
} from '../../src/lib/discord/retry';
import { OperationAbortedError, OperationTimeoutError } from '../../src/lib/discord/errors';
import { deferred } from '../../src/lib/discord/timeout';

function httpError(status: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`http ${status}`), { status, ...extra });
}

test('classifies network, rate-limit, and server failures as retryable', () => {
  const network = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
  const rateLimit = httpError(429, { retry_after: 0.25 });
  const server = httpError(503);

  assert.equal(classifyRetryableError(network).kind, 'network');
  assert.equal(classifyRetryableError(Object.assign(new Error('socket'), { status: 0, code: 'ECONNRESET' })).retryable, true);
  assert.equal(classifyRetryableError(rateLimit).kind, 'rate-limit');
  assert.equal(classifyRetryableError(rateLimit).retryAfterMs, 250);
  assert.equal(classifyRetryableError(server).kind, 'server');
  assert.equal(isRetryableError(network), true);
  assert.equal(isRetryableError(rateLimit), true);
  assert.equal(isRetryableError(server), true);
});

test('classifies ordinary 4xx failures as permanent', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const classification = classifyRetryableError(httpError(status));
    assert.equal(classification.retryable, false, `status ${status}`);
    assert.equal(classification.kind, 'client');
  }
  assert.equal(classifyRetryableError(new OperationAbortedError()).retryable, false);
  assert.equal(classifyRetryableError(new Error('unknown failure')).retryable, false);
});

test('performs bounded retries and uses an injected waiter', async () => {
  let calls = 0;
  const waits: number[] = [];

  const value = await retryIdempotent(
    async () => {
      calls += 1;
      if (calls < 3) throw httpError(502);
      return 'done';
    },
    {
      maxAttempts: 3,
      baseDelayMs: 10,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    },
  );

  assert.equal(value, 'done');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
});

test('honors a bounded provider retry-after hint over backoff', async () => {
  const waits: number[] = [];
  let calls = 0;
  await retryIdempotent(
    async () => {
      calls += 1;
      if (calls === 1) throw httpError(429, { retry_after: 0.001 });
      return 'ok';
    },
    {
      maxAttempts: 2,
      baseDelayMs: 100,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    },
  );
  assert.deepEqual(waits, [1]);
});

test('stops at the configured retry bound', async () => {
  let calls = 0;
  await assert.rejects(
    retryIdempotent(
      async () => {
        calls += 1;
        throw httpError(503);
      },
      {
        maxAttempts: 3,
        baseDelayMs: 0,
        wait: async () => undefined,
      },
    ),
    (error) => (error as { status?: number }).status === 503,
  );
  assert.equal(calls, 3);
});

test('does not retry a permanent response', async () => {
  let calls = 0;
  await assert.rejects(
    retryIdempotent(
      async () => {
        calls += 1;
        throw httpError(400);
      },
      { maxAttempts: 5, wait: async () => undefined },
    ),
    (error) => (error as { status?: number }).status === 400,
  );
  assert.equal(calls, 1);
});

test('requires reconciliation before retrying a create', async () => {
  let creates = 0;
  let reconciliations = 0;
  const value = await retryCreate(
    async () => {
      creates += 1;
      throw httpError(500);
    },
    {
      maxAttempts: 2,
      baseDelayMs: 0,
      wait: async () => undefined,
      reconcile: async ({ attempt }) => {
        reconciliations += 1;
        return attempt === 1
          ? { kind: 'retry' as const }
          : { kind: 'resolved' as const, value: 'already-created' };
      },
    },
  );

  assert.equal(value, 'already-created');
  assert.equal(creates, 2);
  assert.equal(reconciliations, 2);
});

test('does not blindly retry a create without reconciliation', async () => {
  let calls = 0;
  const options = {
    maxAttempts: 3,
    wait: async () => undefined,
  } as unknown as CreateRetryOptions<string>;

  await assert.rejects(
    retryCreate(async () => {
      calls += 1;
      return 'unexpected';
    }, options),
    (error) => error instanceof RetryConfigurationError,
  );
  assert.equal(calls, 0);
});

test('aborts a non-cooperative operation through the shared signal', async () => {
  const controller = new AbortController();
  const operationGate = deferred<string>();
  const promise = retryIdempotent(() => operationGate.promise, {
    signal: controller.signal,
    maxAttempts: 1,
  });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(promise, (error) => error instanceof OperationAbortedError);
  operationGate.resolve('late');
});

test('aborts a retry wait even when a custom waiter is pending', async () => {
  const controller = new AbortController();
  const waitGate = deferred<void>();
  let calls = 0;
  const promise = retryIdempotent(
    async () => {
      calls += 1;
      throw httpError(503);
    },
    {
      maxAttempts: 2,
      baseDelayMs: 1,
      signal: controller.signal,
      wait: async () => waitGate.promise,
    },
  );
  await Promise.resolve();
  controller.abort();
  await assert.rejects(promise, (error) => error instanceof OperationAbortedError);
  assert.equal(calls, 1);
  waitGate.resolve();
});

test('classifies local timeouts separately from caller cancellation', () => {
  assert.equal(classifyRetryableError(new OperationTimeoutError(10)).kind, 'timeout');
  assert.equal(classifyRetryableError(new OperationTimeoutError(10)).retryable, true);
  assert.equal(classifyRetryableError(new OperationAbortedError()).kind, 'aborted');
  assert.equal(classifyRetryableError(new OperationAbortedError()).retryable, false);
});
