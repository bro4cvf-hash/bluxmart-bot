/**
 * Discord operation and retry contracts.
 *
 * Ownership: A11 owns the coordinator, timeouts, and retry implementation.  No
 * `discord.js` types or gateway objects appear here, so ports can be tested with
 * deterministic fakes.  The invariant is one serialized decision per logical
 * operation key; a retry may repeat an idempotent call but must never report a
 * successful create without the resulting resource ID.
 */

import type { ChannelId, DiscordId, GuildId, IsoTimestamp, RoleId, UserId } from './primitives';

export type DiscordResourceKind =
  | 'role'
  | 'category'
  | 'channel'
  | 'permission_overwrites'
  | 'panel_message'
  | 'member_role'
  | 'command'
  | 'ticket_channel'
  | 'unknown';

export type DiscordOperationKind =
  | 'fetch_roles'
  | 'fetch_channels'
  | 'fetch_member'
  | 'create_role'
  | 'edit_role'
  | 'set_role_position'
  | 'create_category'
  | 'rename_category'
  | 'create_channel'
  | 'rename_channel'
  | 'set_channel_parent'
  | 'set_topic'
  | 'set_overwrites'
  | 'upsert_panel'
  | 'add_role'
  | 'remove_role'
  | 'delete_channel'
  | 'unknown';

export type DiscordOperationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

/**
 * A stable logical key for coordination.  `semanticKey` is optional for
 * operations on a concrete ID; it should be a role/category/channel key when
 * the operation is template-driven.
 */
export interface DiscordOperationKey {
  readonly guildId: GuildId;
  readonly resource: DiscordResourceKind;
  readonly semanticKey?: string;
  readonly resourceId?: DiscordId;
}

export type DiscordCoordinationMode = 'serialize' | 'deduplicate' | 'replace' | 'independent';

export interface DiscordOperationRequest<TInput = unknown> {
  readonly operationId: string;
  readonly kind: DiscordOperationKind;
  readonly key: DiscordOperationKey;
  readonly input?: TInput;
  /** Stable caller-supplied key for a logically repeatable mutation. */
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
}

export type DiscordOperationErrorCode =
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'server_unavailable'
  /** Normalized adapter spelling; equivalent transient server failure. */
  | 'server_error'
  | 'permission_denied'
  | 'missing_permission'
  | 'not_found'
  | 'invalid_request'
  | 'conflict'
  | 'cancelled'
  | 'unknown';

/** Sanitized adapter error. It intentionally has no raw `cause`, body, or stack. */
export interface DiscordOperationError {
  readonly code: DiscordOperationErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly global?: boolean;
}

export type DiscordRetryClass =
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'permission_denied'
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'cancelled'
  | 'unknown';

export type DiscordRetryAction = 'retry' | 'wait' | 'reconcile' | 'stop' | 'operator';

/** A classification is data, not a decision hidden inside an exception. */
export interface DiscordRetryClassification {
  readonly class: DiscordRetryClass;
  readonly retryable: boolean;
  readonly action: DiscordRetryAction;
  /** Safe explanation suitable for metrics, not a raw provider response. */
  readonly reason: string;
  readonly retryAfterMs?: number;
  readonly maxAttempts?: number;
}

export type DiscordRetryDecision = DiscordRetryClassification;
/** Short aliases for ports that do not need the Discord prefix. */
export type RetryClass = DiscordRetryClass;
export type RetryClassification = DiscordRetryClassification;
export type OperationResult<TValue> = DiscordOperationResult<TValue>;

export interface DiscordRetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: boolean;
  /** A provider retry-after value takes precedence over calculated backoff. */
  readonly respectRetryAfter: boolean;
}

export interface DiscordRateLimitInfo {
  readonly retryAfterMs: number;
  readonly scope: 'global' | 'route' | 'bucket' | 'user' | 'unknown';
  readonly global: boolean;
  /** Opaque bucket identifier; it is not an authorization token. */
  readonly bucketHash?: string;
}

export interface DiscordOperationSuccess<TValue> {
  readonly status: 'succeeded';
  readonly operationId: string;
  readonly key: DiscordOperationKey;
  readonly value: TValue;
  readonly attempts: number;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly retry?: DiscordRetryClassification;
}

export interface DiscordOperationFailure {
  readonly status: 'failed';
  readonly operationId: string;
  readonly key: DiscordOperationKey;
  readonly error: DiscordOperationError;
  readonly attempts: number;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly retry: DiscordRetryClassification;
}

export interface DiscordOperationCancelled {
  readonly status: 'cancelled';
  readonly operationId: string;
  readonly key: DiscordOperationKey;
  readonly reason: string;
  readonly attempts: number;
}

export type DiscordOperationResult<TValue> =
  | DiscordOperationSuccess<TValue>
  | DiscordOperationFailure
  | DiscordOperationCancelled;

export type DiscordOperationOutcome<TValue> = DiscordOperationResult<TValue>;

/** Minimal coordinator port; A11 may provide an in-memory or durable implementation. */
export interface DiscordOperationCoordinator {
  run<TValue>(
    request: DiscordOperationRequest,
    work: () => Promise<TValue>,
    options?: { readonly coordination?: DiscordCoordinationMode },
  ): Promise<DiscordOperationResult<TValue>>;
}

export interface DiscordOperationQueueEntry {
  readonly operationId: string;
  readonly key: DiscordOperationKey;
  readonly state: DiscordOperationState;
  readonly enqueuedAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly attempts: number;
}

/** Convenient result aliases for ports that name the operation differently. */
export type DiscordOperationResponse<TValue> = DiscordOperationResult<TValue>;
export type DiscordRetryClassificationResult = DiscordRetryClassification;

/** Explicitly name common resource IDs for port signatures without SDK types. */
export interface DiscordRoleTarget {
  readonly guildId: GuildId;
  readonly roleId: RoleId;
}
export interface DiscordMemberRoleTarget {
  readonly guildId: GuildId;
  readonly userId: UserId;
  readonly roleId: RoleId;
}
export interface DiscordChannelTarget {
  readonly guildId: GuildId;
  readonly channelId: ChannelId;
}
