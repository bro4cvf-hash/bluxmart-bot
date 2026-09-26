/**
 * Safe setup and live-sync status contracts.
 *
 * Ownership: A10 owns reconciliation and queueing; this module only describes
 * observable outcomes.  A failed guild must never turn a whole multi-guild
 * sync into a false success, and a result must never carry a raw exception,
 * filesystem path, or provider response.  Existing `created/repaired/roles/
 * channels` fields remain present for live-sync consumers.
 */

import type { ChannelId, CategoryId, DiscordId, GuildId, IsoTimestamp, RoleId } from './primitives';
import type { CategoryIdMap, ChannelIdMap, RoleIdMap } from './keys';
import type { PersistenceRevision } from './persistence';

export type SetupStatus =
  | 'uninitialized'
  | 'ready'
  | 'stale'
  | 'degraded'
  | 'corrupt'
  | 'unknown';

export type SyncStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'applied'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'not_ready';

export type GuildSyncStatus = 'applied' | 'partial' | 'failed' | 'skipped';
export type KnownSyncReason =
  | 'startup'
  | 'guild_join'
  | 'template_change'
  | 'self_heal'
  | 'dashboard_save'
  | 'scheduled'
  | 'manual'
  | 'webhook'
  | 'unknown';
/** Known reasons are documented; adapters may carry an old custom reason. */
export type SyncReason = KnownSyncReason | (string & {});

export type SyncOperation =
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
  | 'persist_setup'
  | 'unknown';

export type SyncFailureCode =
  | 'permission_denied'
  | 'rate_limited'
  | 'missing_resource'
  | 'invalid_state'
  | 'revision_conflict'
  | 'persistence_failure'
  | 'timeout'
  | 'cancelled'
  | 'upstream_unavailable'
  | 'unknown';

/** A public, sanitized failure. Do not add `cause`, stack, or raw response fields. */
export interface SyncFailure {
  readonly guildId: GuildId;
  readonly code: SyncFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly operation?: SyncOperation;
  readonly retryAfterMs?: number;
}

export type SafeSyncFailure = SyncFailure;

/** Aggregate/status failure without a required guild context. */
export interface SyncFailureSummary {
  readonly code: SyncFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface SyncSkip {
  readonly guildId: GuildId;
  readonly code: 'not_ready' | 'out_of_scope' | 'already_queued' | 'unmanaged' | 'unknown';
  readonly message: string;
}

export interface GuildSyncResult {
  readonly guildId: GuildId;
  readonly status: GuildSyncStatus;
  /** Number of newly created managed resources. */
  readonly created: number;
  /** Number of existing managed resources repaired in place. */
  readonly repaired: number;
  readonly roles: number;
  readonly channels: number;
  /** Present for applied/partial outcomes; absent when no durable revision exists. */
  readonly revision?: PersistenceRevision;
  readonly failures: readonly SyncFailure[];
}

export interface AllGuildSyncResult {
  readonly status: 'applied' | 'partial' | 'failed' | 'skipped';
  readonly applied: readonly GuildSyncResult[];
  readonly failed: readonly SyncFailure[];
  readonly skipped: readonly SyncSkip[];
}

export type PartialSyncResult = AllGuildSyncResult;
export type SafeAllGuildSyncResult = AllGuildSyncResult;

export interface TemplateSyncResult extends AllGuildSyncResult {
  readonly revision: PersistenceRevision;
  readonly queued: boolean;
  readonly reason?: SyncReason;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
}

/** The old live-sync result shape, kept for source-compatible adapters. */
export interface LegacyGuildSyncResult {
  readonly guildId: GuildId;
  readonly created: number;
  readonly repaired: number;
  readonly roles: number;
  readonly channels: number;
}

export interface LegacySyncFailure {
  readonly guildId: GuildId;
  /** Raw exception text is retained only for old internal callers, never public API output. */
  readonly error: string;
}

export interface LegacyAllGuildSyncResult {
  readonly applied: readonly LegacyGuildSyncResult[];
  readonly failed: readonly LegacySyncFailure[];
}

export interface LegacyTemplateSyncResult extends LegacyAllGuildSyncResult {
  readonly revision: PersistenceRevision;
  readonly queued: boolean;
}

export type SyncStatusResult = SyncStatusSnapshot;
export type SafeSetupStatus = SetupStatusResult;

export interface SafeGuildSetup {
  readonly guildId: GuildId;
  readonly status: SetupStatus;
  readonly roles: RoleIdMap;
  readonly channels: ChannelIdMap;
  readonly categoryIds?: CategoryIdMap;
  readonly welcomeChannelId?: ChannelId;
  readonly logChannelId?: ChannelId;
  readonly ticketCategoryId?: CategoryId;
  readonly autoRoleId?: RoleId;
  readonly revision?: PersistenceRevision;
  readonly updatedAt?: IsoTimestamp;
}

export interface SetupStatusResult {
  readonly status: SetupStatus;
  readonly guildId?: GuildId;
  readonly revision?: PersistenceRevision;
  readonly updatedAt?: IsoTimestamp;
  readonly lastSync?: SyncStatusSnapshot;
  readonly failure?: SyncFailureSummary;
}

export interface SyncStatusSnapshot {
  readonly status: SyncStatus;
  readonly revision?: PersistenceRevision;
  readonly guildId?: GuildId;
  readonly reason?: SyncReason;
  readonly queuedAt?: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly appliedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  /** Only a sanitized summary; raw errors are not part of the status contract. */
  readonly lastFailure?: SyncFailureSummary;
}

/**
 * A failure for a multi-item operation. `partial` is a first-class outcome and
 * must not be flattened into a successful aggregate.
 */
export interface PartialFailure<TContext = unknown> {
  readonly context?: TContext;
  readonly code: SyncFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

/** Current persisted setup shape, intentionally permissive for legacy/custom keys. */
export interface LegacyGuildSetup {
  readonly guildId: DiscordId;
  readonly roles: Readonly<Record<string, RoleId>>;
  readonly channels: Readonly<Record<string, ChannelId>>;
  readonly categoryIds?: Readonly<Record<string, CategoryId>>;
  readonly welcomeChannelId?: ChannelId;
  readonly logChannelId?: ChannelId;
  readonly ticketCategoryId?: CategoryId;
  readonly autoRoleId?: RoleId;
  readonly updatedAt: IsoTimestamp;
}

/** Source-compatible name for the old persisted setup shape. */
export type GuildSetup = LegacyGuildSetup;
export type GuildSetupSnapshot = SafeGuildSetup;
export type SafeSetupSnapshot = SafeGuildSetup;
