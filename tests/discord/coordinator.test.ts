import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KeyedCoordinator,
  type CoordinatorContext,
} from '../../src/lib/discord/coordinator';
import { deferred } from '../../src/lib/discord/timeout';

test('coalesces callers for one key and returns the same result', async () => {
  const coordinator = new KeyedCoordinator<string>();
  const gate = deferred<{ value: string }>();
  const contexts: CoordinatorContext<string>[] = [];
  let calls = 0;

  const operation = async (context: CoordinatorContext<string>) => {
    calls += 1;
    contexts.push(context);
    return gate.promise;
  };

  const first = coordinator.run('guild:one', operation);
  const second = coordinator.run('guild:one', async () => {
    calls += 1;
    return { value: 'wrong operation' };
  });

  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(coordinator.size, 1);
  assert.deepEqual(contexts[0].key, 'guild:one');

  const value = { value: 'shared' };
  gate.resolve(value);
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a, value);
  assert.strictEqual(b, value);
  assert.equal(coordinator.size, 0);
});

test('serializes operations for the same lock key', async () => {
  const coordinator = new KeyedCoordinator<string>();
  const firstGate = deferred<void>();
  const events: string[] = [];

  const first = coordinator.withLock('ticket:1', async () => {
    events.push('first:start');
    await firstGate.promise;
    events.push('first:end');
  });
  await Promise.resolve();
  const second = coordinator.withLock('ticket:1', async () => {
    events.push('second:start');
  });

  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('allows different keys to run concurrently', async () => {
  const coordinator = new KeyedCoordinator<string>();
  const firstGate = deferred<string>();
  const secondGate = deferred<string>();
  const started: string[] = [];

  const first = coordinator.run('key:a', async () => {
    started.push('a');
    return firstGate.promise;
  });
  const second = coordinator.run('key:b', async () => {
    started.push('b');
    return secondGate.promise;
  });

  await Promise.resolve();
  assert.deepEqual(started.sort(), ['a', 'b']);
  firstGate.resolve('a');
  secondGate.resolve('b');
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
});

test('releases a key after a failed operation', async () => {
  const coordinator = new KeyedCoordinator<string>();
  const failure = new Error('first failed');
  const first = coordinator.run('key:recover', async () => {
    throw failure;
  });

  await assert.rejects(first, (error) => error === failure);
  assert.equal(coordinator.size, 0);

  const second = await coordinator.run('key:recover', async () => 'recovered');
  assert.equal(second, 'recovered');
  assert.equal(coordinator.size, 0);
});
