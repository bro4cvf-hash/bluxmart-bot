import type {
  DiscordCoordinationMode,
  DiscordOperationCoordinator,
  DiscordOperationError,
  DiscordOperationErrorCode,
  DiscordOperationFailure,
  DiscordOperationKey,
  DiscordOperationRequest,
  DiscordOperationResult,
  DiscordOperationSuccess,
  DiscordRetryAction,
  DiscordRetryClassification,
  DiscordRetryClass,
} from '../../contracts/discord';
import type { TimerScheduler } from './timeout';
import { withTimeout } from './timeout';
import { classifyRetryableError } from './retry';
import type { RetryClassification } from './types';
import { KeyedCoordinator } from './coordinator';

/**
 * Adapter for the operation contract owned by A02. The generic coordinator in
 * this directory remains usable without the contracts; this thin adapter gives
 * live-sync and lifecycle code a typed boundary without exposing discord.js.
 */
export interface ContractCoordinatorOptions {
  /** Inject a deterministic timer when a request has a timeout. */
  readonly scheduler?: TimerScheduler;
  /** Injectable clock for result timestamps in tests. */
  readonly now?: () => Date;
}

function operationKey(key: DiscordOperationKey): string {
  return JSON.stringify([
    key.guildId,
    key.resource,
    key.semanticKey ?? null,
    key.resourceId ?? null,
  ]);
}

export function guildCoordinationKey(guildId: string): string {
  return `guild:${guildId}`;
}

function contractErrorCode(
  classification: RetryClassification,
): DiscordOperationErrorCode {
  const retryClass = contractClass(classification);
  if (retryClass === 'server_error') return 'server_unavailable';
  if (retryClass === 'cancelled') return 'cancelled';
  if (retryClass === 'rate_limited') return 'rate_limited';
  if (retryClass === 'timeout') return 'timeout';
  if (retryClass === 'network') return 'network';
  if (retryClass === 'permission_denied') return 'permission_denied';
  if (retryClass === 'not_found') return 'not_found';
  if (retryClass === 'conflict') return 'conflict';
  if (retryClass === 'invalid_request') return 'invalid_request';
  return 'unknown';
}

function contractClass(
  classification: RetryClassification,
): DiscordRetryClass {
  if (classification.kind === 'rate-limit') return 'rate_limited';
  if (classification.kind === 'timeout') return 'timeout';
  if (classification.kind === 'network') return 'network';
  if (classification.kind === 'server') return 'server_error';
  if (classification.status === 408) return 'timeout';
  if (classification.kind === 'aborted') return 'cancelled';
  if (classification.status === 401 || classification.status === 403) {
    return 'permission_denied';
  }
  if (classification.status === 404) return 'not_found';
  if (classification.status === 409) return 'conflict';
  if (classification.kind === 'client') return 'invalid_request';
  return 'unknown';
}

function contractAction(
  classification: RetryClassification,
): DiscordRetryAction {
  if (!classification.retryable) {
    if (classification.kind === 'aborted') return 'stop';
    if (
      classification.status === 401 ||
      classification.status === 403 ||
      classification.status === 404
    ) {
      return 'stop';
    }
    return 'operator';
  }
  return classification.retryAfterMs === undefined ? 'retry' : 'wait';
}

function contractRetryClassification(
  classification: RetryClassification,
): DiscordRetryClassification {
  return {
    class: contractClass(classification),
    retryable: classification.retryable,
    action: contractAction(classification),
    reason: classification.reason,
    ...(classification.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: classification.retryAfterMs }),
    maxAttempts: 1,
  };
}

function safeMessage(classification: RetryClassification): string {
  switch (classification.kind) {
    case 'rate-limit':
      return 'The remote service rate-limited the operation.';
    case 'timeout':
      return 'The operation timed out.';
    case 'network':
      return 'The remote service could not be reached.';
    case 'server':
      return 'The remote service is temporarily unavailable.';
    case 'aborted':
      return 'The operation was cancelled.';
    case 'client':
      if (classification.status === 401 || classification.status === 403) {
        return 'The remote service denied the operation.';
      }
      if (classification.status === 404) return 'The requested resource was not found.';
      if (classification.status === 409) return 'The operation conflicted with current state.';
      return 'The remote service rejected the operation.';
    default:
      return 'The operation failed.';
  }
}

function errorGlobal(error: unknown): boolean | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { global?: unknown }).global;
  return typeof value === 'boolean' ? value : undefined;
}

function contractError(
  error: unknown,
  classification: RetryClassification,
): DiscordOperationError {
  const global = errorGlobal(error);
  return {
    code: contractErrorCode(classification),
    message: safeMessage(classification),
    ...(classification.status === undefined ? {} : { status: classification.status }),
    ...(classification.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: classification.retryAfterMs }),
    ...(global === undefined ? {} : { global }),
  };
}

export class ContractKeyedCoordinator implements DiscordOperationCoordinator {
  private readonly coordinator = new KeyedCoordinator<string>();
  private readonly scheduler?: TimerScheduler;
  private readonly now: () => Date;

  constructor(options: ContractCoordinatorOptions = {}) {
    this.scheduler = options.scheduler;
    this.now = options.now ?? (() => new Date());
  }

  run<TValue>(
    request: DiscordOperationRequest,
    work: () => TValue | Promise<TValue>,
    options: { readonly coordination?: DiscordCoordinationMode } = {},
  ): Promise<DiscordOperationResult<TValue>> {
    const mode = options.coordination ?? 'deduplicate';
    const key = operationKey(request.key);

    if (mode === 'independent') {
      return this.execute(request, work);
    }
    if (mode === 'serialize') {
      return this.coordinator.withLock(key, () => this.execute(request, work));
    }
    if (mode === 'replace') {
      // A replacement gets a fresh slot for the same logical key. The old
      // operation is cancelled, while a replacement can start without waiting
      // for a remote call which may not observe cancellation.
      return this.coordinator.replace(key, () => this.execute(request, work));
    }
    return this.coordinator.run(key, () => this.execute(request, work));
  }

  private async execute<TValue>(
    request: DiscordOperationRequest,
    work: () => TValue | Promise<TValue>,
  ): Promise<DiscordOperationResult<TValue>> {
    const startedAt = this.timestamp();
    try {
      const value = request.timeoutMs === undefined
        ? await work()
        : await withTimeout(
            () => work(),
            { timeoutMs: request.timeoutMs, scheduler: this.scheduler },
          );
      const success: DiscordOperationSuccess<TValue> = {
        status: 'succeeded',
        operationId: request.operationId,
        key: request.key,
        value,
        attempts: 1,
        startedAt,
        finishedAt: this.timestamp(),
      };
      return success;
    } catch (error) {
      const classification = classifyRetryableError(error);
      const retry = contractRetryClassification(classification);
      if (classification.kind === 'aborted') {
        return {
          status: 'cancelled',
          operationId: request.operationId,
          key: request.key,
          reason: safeMessage(classification),
          attempts: 1,
        };
      }
      const failure: DiscordOperationFailure = {
        status: 'failed',
        operationId: request.operationId,
        key: request.key,
        error: contractError(error, classification),
        attempts: 1,
        startedAt,
        finishedAt: this.timestamp(),
        retry,
      };
      return failure;
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export const DiscordCoordinator = ContractKeyedCoordinator;
export const LiveSyncCoordinator = ContractKeyedCoordinator;
export const DefaultDiscordOperationCoordinator = ContractKeyedCoordinator;

export function createContractCoordinator(
  options: ContractCoordinatorOptions = {},
): ContractKeyedCoordinator {
  return new ContractKeyedCoordinator(options);
}

export const createDiscordCoordinator = createContractCoordinator;

export function classifyDiscordError(error: unknown): DiscordRetryClassification {
  return contractRetryClassification(classifyRetryableError(error));
}

export function toDiscordOperationError(
  error: unknown,
  classification: RetryClassification = classifyRetryableError(error),
): DiscordOperationError {
  return contractError(error, classification);
}

export { contractRetryClassification, operationKey };
