/**
 * Compile-time contract checks.
 *
 * This file is intentionally type-only: it has no runtime imports, services,
 * filesystem access, Discord client, payment SDK, or network client.  A later
 * toolchain agent can run it with `tsc --noEmit` in a type-test job.
 */

import type {
  AllGuildSyncResult,
  ApiErrorResponse,
  API_ERROR_CODES,
  ChannelKey,
  CommerceFulfillmentRequest,
  CUSTOMER_ROLE_KEY,
  DiscordOperationResult,
  DiscordRetryAction,
  DiscordRetryClassification,
  FulfillmentRequest,
  FulfillmentRequestWithProductId,
  FulfillmentRequestWithTrustedProductId,
  FulfillmentResult,
  FulfillmentSuccessResult,
  GuildSyncResult,
  LEGACY_CHANNEL_ALIASES,
  LEGACY_CUSTOM_IDS,
  LEGACY_ROLE_ALIASES,
  LegacyChannelKey,
  PersistenceSnapshot,
  RevisionConflict,
  RoleKey,
  ROLE_KEYS,
  SafeGuildSetup,
  SemanticChannelKey,
  SetupStatusResult,
  SyncStatusSnapshot,
  TICKET_CLOSE_CUSTOM_ID,
  TicketCloseRequest,
  TicketDeleteDecision,
  TicketPanelCustomId,
  TicketRecord,
  TrustedProductId,
} from '../../src/contracts';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

type _RoleKeys = typeof ROLE_KEYS;
type _CustomerIsStable = Expect<Equal<Extract<_RoleKeys[number], 'customer'>, 'customer'>>;
type _LegacyCustomerRole = Expect<Equal<(typeof LEGACY_ROLE_ALIASES)['Customer'], 'customer'>>;
type _PrivilegedRolesAreExplicit = Expect<Equal<Extract<RoleKey, 'owner' | 'admin' | 'manager'>, 'owner' | 'admin' | 'manager'>>;
type _LegacyReviewIsSubmit = Expect<Equal<(typeof LEGACY_CHANNEL_ALIASES)['reviews'], 'review_submit'>>;
type _LegacyChannelCompatibility = Expect<Equal<Extract<LegacyChannelKey, 'reviews' | 'chat' | 'ticketlogs'>, 'reviews' | 'chat' | 'ticketlogs'>>;
type _SemanticChannelCompatibility = Expect<Equal<Extract<SemanticChannelKey, 'review_submit' | 'ticket_logs'>, 'review_submit' | 'ticket_logs'>>;
type _AllChannelsAcceptCompatibility = Expect<Equal<Extract<ChannelKey, 'general_chat' | 'chat' | 'reviews'>, 'general_chat' | 'chat' | 'reviews'>>;
type _RevisionErrorCodeIsStable = Expect<Equal<Extract<(typeof API_ERROR_CODES)[number], 'REVISION_CONFLICT'>, 'REVISION_CONFLICT'>>;
type _ErrorEnvelopeHasCode = Expect<Equal<ApiErrorResponse['error']['code'] extends string ? true : false, true>>;

type _SnapshotData = Expect<Equal<PersistenceSnapshot<{ value: number }>['data']['value'], number>>;
type _ConflictExpectedRevision = Expect<Equal<RevisionConflict['expectedRevision'], string | null>>;
type _ConflictCurrentRevision = Expect<Equal<RevisionConflict['currentRevision'], string>>;
type _SetupStatus = Expect<Equal<SafeGuildSetup['status'], SetupStatusResult['status']>>;
type _GuildSyncStatus = Expect<Equal<GuildSyncResult['status'], 'applied' | 'partial' | 'failed' | 'skipped'>>;
type _AggregateSyncStatus = Expect<Equal<AllGuildSyncResult['status'], 'applied' | 'partial' | 'failed' | 'skipped'>>;
type _StatusCountsAreIntegers = Expect<Equal<SyncStatusSnapshot['appliedCount'], number>>;
type _DiscordOperationStatus = Expect<Equal<DiscordOperationResult<unknown>['status'], 'succeeded' | 'failed' | 'cancelled'>>;
type _RetryMetadataIsTyped = Expect<Equal<DiscordRetryClassification['action'], DiscordRetryAction>>;
type _RetryRateLimitIsStable = Expect<Equal<Extract<DiscordRetryClassification['class'], 'rate_limited'>, 'rate_limited'>>;

type _TicketState = Expect<Equal<TicketRecord['state'], 'requested' | 'creating' | 'open' | 'closing' | 'closed' | 'archived' | 'close_failed' | 'deleted'>>;
type _CloseCustomIdIsStable = Expect<Equal<typeof TICKET_CLOSE_CUSTOM_ID, typeof LEGACY_CUSTOM_IDS.ticketClose>>;
type _CloseIsNotPanelType = Expect<Equal<Extract<TicketPanelCustomId, 'ticket_close'>, never>>;
type _DurableDeleteIsExplicit = Expect<Equal<Extract<TicketDeleteDecision, { allowed: true }>['evidence'], 'durable'>>;
type _CloseRequestUsesChannel = Expect<Equal<TicketCloseRequest['channelId'], string>>;

type _FulfillmentFields = Expect<Equal<FulfillmentRequest['eventId'], string>>;
type _FulfillmentOrderId = Expect<Equal<FulfillmentRequest['orderId'], string>>;
type _FulfillmentIssuedAt = Expect<Equal<FulfillmentRequest['issuedAt'], string>>;
type _FulfillmentNonce = Expect<Equal<FulfillmentRequest['nonce'], string>>;
type _FulfillmentDiscordUser = Expect<Equal<FulfillmentRequest['discordUserId'], string>>;
type _FulfillmentSignature = Expect<Equal<FulfillmentRequest['signature']['algorithm'] extends string ? true : false, true>>;
type _TrustedProductAlias = Expect<Equal<FulfillmentRequestWithTrustedProductId['trustedProductId'], TrustedProductId>>;
type _ProductIdAlias = Expect<Equal<FulfillmentRequestWithProductId['productId'], TrustedProductId>>;
type _CommerceRequestAlias = Expect<Equal<CommerceFulfillmentRequest, FulfillmentRequest>>;
type _SuccessRoleIsCustomerOnly = Expect<Equal<FulfillmentSuccessResult['roleKey'], typeof CUSTOMER_ROLE_KEY>>;
type _SuccessCannotGrantOwner = Expect<Equal<Extract<FulfillmentSuccessResult['roleKey'], 'owner' | 'admin'>, never>>;
type _ResultStatus = Expect<Equal<FulfillmentResult['status'], 'fulfilled' | 'already_fulfilled' | 'pending_member' | 'rejected' | 'failed'>>;

export type ContractAssertions = [
  _RoleKeys,
  _CustomerIsStable,
  _LegacyCustomerRole,
  _PrivilegedRolesAreExplicit,
  _LegacyReviewIsSubmit,
  _LegacyChannelCompatibility,
  _SemanticChannelCompatibility,
  _AllChannelsAcceptCompatibility,
  _RevisionErrorCodeIsStable,
  _ErrorEnvelopeHasCode,
  _SnapshotData,
  _ConflictExpectedRevision,
  _ConflictCurrentRevision,
  _SetupStatus,
  _GuildSyncStatus,
  _AggregateSyncStatus,
  _StatusCountsAreIntegers,
  _DiscordOperationStatus,
  _RetryMetadataIsTyped,
  _RetryRateLimitIsStable,
  _TicketState,
  _CloseCustomIdIsStable,
  _CloseIsNotPanelType,
  _DurableDeleteIsExplicit,
  _CloseRequestUsesChannel,
  _FulfillmentFields,
  _FulfillmentOrderId,
  _FulfillmentIssuedAt,
  _FulfillmentNonce,
  _FulfillmentDiscordUser,
  _FulfillmentSignature,
  _TrustedProductAlias,
  _ProductIdAlias,
  _CommerceRequestAlias,
  _SuccessRoleIsCustomerOnly,
  _SuccessCannotGrantOwner,
  _ResultStatus,
];

export type ContractTypeTests = ContractAssertions;
