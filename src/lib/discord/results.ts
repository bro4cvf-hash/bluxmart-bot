import {
  errorMessage,
  errorName,
  isOperationAbortedError,
  isOperationTimeoutError,
} from './errors';
import { classifyRetryableError, toOperationError } from './retry';
import type {
  OperationFailure,
  OperationMetadata,
  OperationOutcome,
  OperationResult,
  OperationSuccess,
} from './types';

export interface SuccessOptions {
  readonly outcome?: 'success' | 'reconciled' | 'unchanged' | 'pending';
  readonly attempts?: number;
  readonly metadata?: OperationMetadata;
}

export interface FailureOptions {
  readonly outcome?: Extract<
    OperationOutcome,
    'failed' | 'rejected' | 'aborted' | 'timed_out' | 'conflict'
  >;
  readonly attempts?: number;
  readonly metadata?: OperationMetadata;
  readonly normalizedError?: OperationFailure['normalizedError'];
}

export function success<T>(value: T, options: SuccessOptions = {}): OperationSuccess<T> {
  return {
    ok: true,
    value,
    outcome: options.outcome ?? 'success',
    attempts: options.attempts ?? 1,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

export function reconciled<T>(value: T, options: Omit<SuccessOptions, 'outcome'> = {}): OperationSuccess<T> {
  return success(value, { ...options, outcome: 'reconciled' });
}

export function unchanged<T>(value: T, options: Omit<SuccessOptions, 'outcome'> = {}): OperationSuccess<T> {
  return success(value, { ...options, outcome: 'unchanged' });
}

export function pending<T>(value: T, options: Omit<SuccessOptions, 'outcome'> = {}): OperationSuccess<T> {
  return success(value, { ...options, outcome: 'pending' });
}

type FailureOutcome = 'failed' | 'rejected' | 'aborted' | 'timed_out' | 'conflict';

function inferFailureOutcome(error: unknown): FailureOutcome {
  if (isOperationTimeoutError(error)) return 'timed_out';
  if (isOperationAbortedError(error)) return 'aborted';
  const classification = classifyRetryableError(error);
  if (classification.kind === 'aborted') return 'aborted';
  if (classification.status === 409) return 'conflict';
  if (classification.status !== undefined && classification.status >= 400 && classification.status < 500) {
    return 'rejected';
  }
  return 'failed';
}

export function failure<E>(
  error: E,
  options: FailureOptions = {},
): OperationFailure<E> {
  const normalizedError = options.normalizedError ?? toOperationError(error);
  return {
    ok: false,
    error,
    normalizedError,
    outcome: options.outcome ?? inferFailureOutcome(error),
    attempts: options.attempts ?? 1,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

export const failureResult = failure;
export const ok = success;
export const err = failure;
export const toOperationResult = captureOperationResult;

export function isOperationSuccess<T, E = unknown>(
  result: OperationResult<T, E>,
): result is OperationSuccess<T> {
  return result.ok;
}

export function isOperationFailure<T, E = unknown>(
  result: OperationResult<T, E>,
): result is OperationFailure<E> {
  return !result.ok;
}

export function mapOperationResult<T, U, E = unknown>(
  result: OperationResult<T, E>,
  mapper: (value: T) => U,
): OperationResult<U, E> {
  return result.ok ? success(mapper(result.value), {
    outcome: result.outcome,
    attempts: result.attempts,
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
  }) : failure(result.error, {
    outcome: result.outcome,
    attempts: result.attempts,
    normalizedError: result.normalizedError,
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
  });
}

export async function captureOperationResult<T>(
  operation: () => T | Promise<T>,
  options: Omit<SuccessOptions, 'outcome'> = {},
): Promise<OperationResult<T>> {
  try {
    return success(await operation(), options);
  } catch (error) {
    return failure(error, { attempts: options.attempts ?? 1 });
  }
}

export function unwrapOperationResult<T, E = unknown>(
  result: OperationResult<T, E>,
): T {
  if (result.ok) return result.value;
  if (result.error instanceof Error) throw result.error;
  throw new Error(errorMessage(result.error), { cause: result.error });
}

/** Convert a raw error without exposing implementation-specific error classes. */
export function describeError(error: unknown): {
  readonly name: string;
  readonly message: string;
} {
  return { name: errorName(error), message: errorMessage(error) };
}
