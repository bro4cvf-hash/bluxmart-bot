/**
 * Dependency-free contracts shared by the Discord-facing feature modules.
 *
 * Nothing in this file imports discord.js.  The feature modules can therefore
 * use these contracts with the real client, with a small adapter, or with the
 * in-memory fakes in `fakes.ts`.
 */

/** A stable logical key used by reconciliation code (not a Discord snowflake). */
export type ResourceKey = string;

/** HTTP/error classifications shared by retry and result helpers. */
export type RetryClass =
  | 'network'
  | 'rate-limit'
  | 'server'
  | 'timeout'
  | 'client'
  | 'aborted'
  | 'unknown';

export interface RetryClassification {
  /** True only for errors which are safe to try again. */
  readonly retryable: boolean;
  readonly kind: RetryClass;
  readonly status?: number;
  readonly code?: string;
  /** A server supplied delay, normalized to milliseconds when available. */
  readonly retryAfterMs?: number;
  readonly reason: string;
}

/** A safe, serializable description of an arbitrary thrown value. */
export interface OperationError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryClass: RetryClass;
  readonly retryAfterMs?: number;
}

export type OperationOutcome =
  | 'success'
  | 'reconciled'
  | 'unchanged'
  | 'pending'
  | 'failed'
  | 'rejected'
  | 'aborted'
  | 'timed_out'
  | 'conflict';

export type OperationMetadata = Readonly<Record<string, unknown>>;

export interface OperationSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly outcome: 'success' | 'reconciled' | 'unchanged' | 'pending';
  readonly attempts: number;
  readonly metadata?: OperationMetadata;
}

export interface OperationFailure<E = unknown> {
  readonly ok: false;
  /** The original value thrown by the operation, when one exists. */
  readonly error: E;
  /** A stable classification for logging, retry, and user-facing mapping. */
  readonly normalizedError: OperationError;
  readonly outcome: 'failed' | 'rejected' | 'aborted' | 'timed_out' | 'conflict';
  readonly attempts: number;
  readonly metadata?: OperationMetadata;
}

export type OperationResult<T, E = unknown> =
  | OperationSuccess<T>
  | OperationFailure<E>;

/** Optional context accepted by structural ports. */
export interface PortContext {
  readonly signal?: AbortSignal;
  readonly attempt?: number;
}

export interface RoleSnapshot {
  readonly id: string;
  readonly guildId: string;
  readonly key: ResourceKey;
  readonly name: string;
  readonly color?: number;
  readonly permissions: readonly string[];
  readonly position?: number;
  readonly hoist?: boolean;
}

export interface RoleInput {
  readonly key: ResourceKey;
  readonly name: string;
  readonly color?: number;
  readonly permissions?: readonly string[];
  readonly position?: number;
  readonly hoist?: boolean;
}

export type RolePatch = Partial<Omit<RoleInput, 'key'>> & {
  readonly key?: ResourceKey;
};

export interface CategorySnapshot {
  readonly id: string;
  readonly guildId: string;
  readonly key: ResourceKey;
  readonly name: string;
  readonly position?: number;
}

export interface CategoryInput {
  readonly key: ResourceKey;
  readonly name: string;
  readonly position?: number;
}

export type CategoryPatch = Partial<Omit<CategoryInput, 'key'>> & {
  readonly key?: ResourceKey;
};

export interface ChannelSnapshot {
  readonly id: string;
  readonly guildId: string;
  readonly key: ResourceKey;
  readonly name: string;
  /** A small, client-independent vocabulary for test fakes. */
  readonly type: string;
  readonly parentKey?: ResourceKey;
  readonly topic?: string;
  readonly position?: number;
}

export interface ChannelInput {
  readonly key: ResourceKey;
  readonly name: string;
  readonly type: string;
  readonly parentKey?: ResourceKey;
  readonly topic?: string;
  readonly position?: number;
}

export type ChannelPatch = Partial<Omit<ChannelInput, 'key'>> & {
  readonly key?: ResourceKey;
};

/**
 * The port intentionally exposes create/update/read operations but no delete
 * operation. Evidence and unmanaged-resource safety remain feature-owned.
 */
export interface ResourcePort<TInput, TPatch, TEntity> {
  getById(
    guildId: string,
    id: string,
    context?: PortContext,
  ): Promise<TEntity | null>;
  findByKey(
    guildId: string,
    key: ResourceKey,
    context?: PortContext,
  ): Promise<TEntity | null>;
  create(
    guildId: string,
    input: TInput,
    context?: PortContext,
  ): Promise<TEntity>;
  update(
    guildId: string,
    id: string,
    patch: TPatch,
    context?: PortContext,
  ): Promise<TEntity>;
}

export interface RolePosition {
  readonly id: string;
  readonly position: number;
}

export interface RolePort extends ResourcePort<RoleInput, RolePatch, RoleSnapshot> {
  setPositions(
    guildId: string,
    positions: readonly RolePosition[],
    context?: PortContext,
  ): Promise<void>;
}
export type CategoryPort = ResourcePort<
  CategoryInput,
  CategoryPatch,
  CategorySnapshot
>;
export type ChannelPort = ResourcePort<ChannelInput, ChannelPatch, ChannelSnapshot>;

export interface SetupState {
  readonly roles: Readonly<Record<ResourceKey, string>>;
  readonly categories: Readonly<Record<ResourceKey, string>>;
  readonly channels: Readonly<Record<ResourceKey, string>>;
}

export interface SetupSnapshot extends SetupState {
  readonly guildId: string;
  readonly revision?: number;
}

export interface SetupPort {
  load(guildId: string, context?: PortContext): Promise<SetupSnapshot | null>;
  save(guildId: string, state: SetupState, context?: PortContext): Promise<void>;
  readonly roles: RolePort;
  readonly categories: CategoryPort;
  readonly channels: ChannelPort;
}

export type TicketStatus = 'open' | 'closed' | 'archived';

export interface TicketSnapshot {
  readonly id: string;
  readonly guildId: string;
  readonly userId: string;
  readonly typeId: string;
  readonly topic: string;
  readonly status: TicketStatus;
  readonly idempotencyKey?: string;
  readonly categoryKey?: ResourceKey;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TicketCreateInput {
  readonly guildId: string;
  readonly userId: string;
  readonly typeId: string;
  /** Stable interaction/order key used to reconcile a retried create. */
  readonly idempotencyKey?: string;
  readonly name: string;
  readonly topic: string;
  readonly categoryKey?: ResourceKey;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TicketPort {
  findOpen(
    guildId: string,
    userId: string,
    typeId: string,
    context?: PortContext,
  ): Promise<TicketSnapshot | null>;
  create(input: TicketCreateInput, context?: PortContext): Promise<TicketSnapshot>;
  /** Optional durable lookup used as the reconciliation callback for create. */
  findByIdempotencyKey?(
    idempotencyKey: string,
    context?: PortContext,
  ): Promise<TicketSnapshot | null>;
  close(
    guildId: string,
    ticketId: string,
    context?: PortContext,
  ): Promise<TicketSnapshot>;
}

export interface MemberSnapshot {
  readonly id: string;
  readonly guildId: string;
  readonly roleIds: readonly string[];
}

export interface MemberPort {
  find(
    guildId: string,
    userId: string,
    context?: PortContext,
  ): Promise<MemberSnapshot | null>;
  addRole(
    guildId: string,
    userId: string,
    roleId: string,
    context?: PortContext,
  ): Promise<MemberSnapshot>;
  removeRole(
    guildId: string,
    userId: string,
    roleId: string,
    context?: PortContext,
  ): Promise<MemberSnapshot>;
}

export interface CommerceRoleResolution {
  readonly productKey: string;
  readonly roleId: string;
  readonly role: RoleSnapshot;
}

export interface CommerceGrantInput {
  /** The stable event/order key. It is the idempotency boundary. */
  readonly idempotencyKey: string;
  readonly guildId: string;
  readonly userId: string;
  readonly productKey: string;
  readonly roleId?: string;
}

export type CommerceGrantOutcome =
  | 'granted'
  | 'already_granted'
  | 'pending_member'
  | 'role_not_found';

export interface CommerceGrantResult {
  readonly outcome: CommerceGrantOutcome;
  readonly idempotencyKey: string;
  readonly guildId: string;
  readonly userId: string;
  readonly roleId?: string;
  readonly member?: MemberSnapshot;
}

export interface CommercePort {
  resolveCustomerRole(
    guildId: string,
    productKey: string,
    context?: PortContext,
  ): Promise<RoleSnapshot | null>;
  grantCustomerRole(
    input: CommerceGrantInput,
    context?: PortContext,
  ): Promise<CommerceGrantResult>;
}

export interface DiscordPorts {
  readonly setup: SetupPort;
  readonly tickets: TicketPort;
  readonly members: MemberPort;
  readonly commerce: CommercePort;
}
