import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureOperationResult,
  failure,
  isOperationFailure,
  success,
} from '../../src/lib/discord/results';
import { OperationTimeoutError } from '../../src/lib/discord/errors';

test('constructs explicit success and sanitized failure results', () => {
  const ok = success('value', { attempts: 2, metadata: { source: 'test' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 'value');
  assert.equal(ok.attempts, 2);

  const failed = failure(new OperationTimeoutError(5));
  assert.equal(isOperationFailure(failed), true);
  assert.equal(failed.outcome, 'timed_out');
  assert.equal(failed.normalizedError.retryClass, 'timeout');
  assert.equal((failed.normalizedError as { cause?: unknown }).cause, undefined);
});

test('captures thrown values without false success', async () => {
  const result = await captureOperationResult(async () => {
    throw Object.assign(new Error('failed'), { status: 400 });
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.normalizedError.retryable, false);
  }
});
