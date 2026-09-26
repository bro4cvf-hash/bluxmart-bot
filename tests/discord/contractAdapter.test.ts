import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractKeyedCoordinator } from '../../src/lib/discord/contractAdapter';
import { deferred } from '../../src/lib/discord/timeout';
import type { DiscordOperationRequest } from '../../src/contracts/discord';

const request: DiscordOperationRequest = {
  operationId: 'synthetic-operation',
  kind: 'fetch_roles',
  key: {
    guildId: 'synthetic-guild',
    resource: 'role',
    semanticKey: 'customer',
  },
};

test('adapts the A02 operation contract to the keyed coordinator', async () => {
  const gate = deferred<{ id: string }>();
  let calls = 0;
  const timestamps = [
    new Date('2026-01-01T00:00:00.000Z'),
    new Date('2026-01-01T00:00:01.000Z'),
  ];
  const coordinator = new ContractKeyedCoordinator({
    now: () => timestamps.shift() ?? new Date('2026-01-01T00:00:02.000Z'),
  });

  const first = coordinator.run(request, async () => {
    calls += 1;
    return gate.promise;
  });
  const second = coordinator.run(
    { ...request, operationId: 'synthetic-second-operation' },
    async () => {
      calls += 1;
      return { id: 'wrong' };
    },
  );
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);

  gate.resolve({ id: 'synthetic-role' });
  const result = await first;
  assert.equal(result.status, 'succeeded');
  if (result.status === 'succeeded') assert.equal(result.value.id, 'synthetic-role');
});

test('returns a sanitized contract failure for a permanent response', async () => {
  const coordinator = new ContractKeyedCoordinator({
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  const result = await coordinator.run(request, async () => {
    throw Object.assign(new Error('secret provider body'), { status: 403 });
  });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.equal(result.error.status, 403);
    assert.equal(result.error.message.includes('secret'), false);
    assert.equal((result.error as { cause?: unknown }).cause, undefined);
  }
});
