/**
 * Provider-neutral commerce fulfillment contract.
 *
 * Ownership: the commerce producer owns the order/payment state machine and
 * the bot-side commerce service owns verification and role grants.  This file
 * intentionally has no Stripe SDK types and contains no secret, key material,
 * webhook payload, or browser-facing credential.  `productId` is an opaque
 * trusted product/price identifier; the verifier must resolve it through an
 * allow-list rather than trusting a display name.
 *
 * Invariants for the verifier:
 * - `eventId`, `orderId`, and `nonce` are replay/idempotency keys, not secrets.
 * - `issuedAt` is checked against a bounded clock window.
 * - The signature is verified over the producer's canonical request bytes
 *   before any order or Discord side effect occurs.
 * - The only grantable role key is `customer`; arbitrary role names/IDs are
 *   not accepted from the request.
 * - A valid member-less order becomes `pending_member` and may be retried when
 *   the member joins; it is not a successful grant.
 * - No result in this contract authorizes automatic role removal on refund;
 *   any revocation requires a separate audited policy.
 */

import type { GuildId, IsoTimestamp, RoleId, UserId } from './primitives';
import type { RoleKey } from './keys';

export type TrustedProductId = string;
export type FulfillmentProvider = string;
export type FulfillmentSignatureAlgorithm = 'hmac-sha256' | (string & {});
export type FulfillmentCanonicalization = 'json-canonical-v1' | (string & {});

export const CUSTOMER_ROLE_KEY = 'customer' as const satisfies RoleKey;
export type CustomerRoleKey = typeof CUSTOMER_ROLE_KEY;

/** A provider may use a key identifier so rotation does not require a code change. */
export type FulfillmentSignedField =
  | 'eventId'
  | 'orderId'
  | 'productId'
  | 'trustedProductId'
  | 'discordUserId'
  | 'issuedAt'
  | 'nonce'
  | 'guildId';

export interface FulfillmentSignatureMetadataBase {
  readonly algorithm: FulfillmentSignatureAlgorithm;
  readonly keyId: string;
  readonly canonicalization?: FulfillmentCanonicalization;
  readonly signedFields?: readonly FulfillmentSignedField[];
}

/**
 * `signature` is the preferred spelling; `value` is retained for producers
 * whose generic signer calls the bytes `value`. Exactly one is required. A
 * legacy producer that sends both must normalize them at the boundary.
 */
export type FulfillmentSignatureMetadata =
  | (FulfillmentSignatureMetadataBase & {
      readonly signature: string;
      readonly value?: never;
    })
  | (FulfillmentSignatureMetadataBase & {
      readonly signature?: never;
      readonly value: string;
    });

export type CommerceSignatureMetadata = FulfillmentSignatureMetadata;
export type SignatureMetadata = FulfillmentSignatureMetadata;

/**
 * Product identity accepts the concise `productId` spelling and the explicit
 * `trustedProductId` spelling. Exactly one is required. A legacy producer that
 * sends both fields must normalize them at the boundary; the contract does not
 * permit choosing between mismatched values.
 */
export type FulfillmentProductIdentity =
  | {
      readonly productId: TrustedProductId;
      readonly trustedProductId?: never;
    }
  | {
      readonly productId?: never;
      readonly trustedProductId: TrustedProductId;
    };

export interface FulfillmentRequestBase {
  /** Unique provider event identifier used for idempotency. */
  readonly eventId: string;
  /** Internal commerce order identifier. */
  readonly orderId: string;
  /** Discord account that should receive the Customer role. */
  readonly discordUserId: UserId;
  /** UTC RFC 3339 timestamp bounded by the verifier's replay window. */
  readonly issuedAt: IsoTimestamp;
  /** Single-use request nonce; the verifier records it with the event. */
  readonly nonce: string;
  /** Optional explicit guild; otherwise the bot's configured guild is the target. */
  readonly guildId?: GuildId;
  /** Optional producer/provider metadata; it is not a Stripe type. */
  readonly provider?: FulfillmentProvider;
  /** Optional schema marker for forward-compatible transport adapters. */
  readonly version?: 1;
  readonly correlationId?: string;
}

export type FulfillmentRequest = FulfillmentRequestBase &
  FulfillmentProductIdentity & {
    /** Metadata only; the key/secret itself is never part of the request. */
    readonly signature: FulfillmentSignatureMetadata;
  };

export type CommerceFulfillmentRequest = FulfillmentRequest;
export type FulfillmentRequestContract = FulfillmentRequest;
export type SignedFulfillmentRequest = FulfillmentRequest;
export type TrustedProductFulfillmentRequest = FulfillmentRequestWithTrustedProductId;
export type FulfillmentRequestWithProductId = Extract<FulfillmentRequest, { readonly productId: TrustedProductId }>;
export type FulfillmentRequestWithTrustedProductId = Extract<FulfillmentRequest, { readonly trustedProductId: TrustedProductId }>;
export type FulfillmentProductId = TrustedProductId;
export type CustomFulfillmentProductId = TrustedProductId;
export type FulfillmentSignature = FulfillmentSignatureMetadata;

export type CommerceOrderState =
  | 'pending_discord'
  | 'pending_payment'
  | 'paid'
  | 'pending_member'
  | 'fulfilled'
  | 'failed'
  | 'refunded'
  | 'revoked';

export type FulfillmentResultStatus =
  | 'fulfilled'
  | 'already_fulfilled'
  | 'pending_member'
  | 'rejected'
  | 'failed';

export type FulfillmentErrorCode =
  | 'invalid_request'
  | 'invalid_signature'
  | 'stale_timestamp'
  | 'replay_detected'
  | 'unknown_product'
  | 'cross_guild_forbidden'
  | 'user_not_in_guild'
  | 'role_not_managed'
  | 'privileged_role_forbidden'
  | 'duplicate_event'
  | 'persistence_failure'
  | 'discord_permission_denied'
  | 'discord_rate_limited'
  | 'cancelled'
  | 'internal_error';

export interface FulfillmentSuccessResult {
  readonly ok: true;
  readonly status: 'fulfilled' | 'already_fulfilled' | 'pending_member';
  readonly eventId: string;
  readonly orderId: string;
  readonly discordUserId: UserId;
  /** Resolved trusted product identifier echoed for audit correlation. */
  readonly productId: TrustedProductId;
  readonly trustedProductId?: TrustedProductId;
  /** Fixed semantic target; it cannot be overridden by request data. */
  readonly roleKey: CustomerRoleKey;
  /** Resolved managed role ID may be included for audit correlation, never as a request target. */
  readonly roleId?: RoleId;
  readonly granted: boolean;
  readonly idempotent: boolean;
  readonly orderState: CommerceOrderState;
  readonly processedAt: IsoTimestamp;
}

export interface FulfillmentFailureResult {
  readonly ok: false;
  readonly status: 'rejected' | 'failed';
  readonly eventId: string;
  readonly orderId: string;
  readonly discordUserId?: UserId;
  readonly code: FulfillmentErrorCode;
  /** Sanitized public/audit message; never include signature material or provider bodies. */
  readonly message: string;
  readonly retryable: boolean;
  readonly roleKey?: CustomerRoleKey;
  readonly processedAt: IsoTimestamp;
}

export type FulfillmentResult = FulfillmentSuccessResult | FulfillmentFailureResult;
export type CommerceFulfillmentResult = FulfillmentResult;
export type FulfillmentResponse = FulfillmentResult;
export type FulfillmentProcessingResult = FulfillmentResult;

/** Optional order projection for a commerce service; no provider SDK object is exposed. */
export interface CommerceOrderStatus {
  readonly orderId: string;
  readonly state: CommerceOrderState;
  readonly discordUserId?: UserId;
  readonly productId?: TrustedProductId;
  readonly lastEventId?: string;
  readonly updatedAt: IsoTimestamp;
}

export interface FulfillmentAuditEntry {
  readonly eventId: string;
  readonly orderId: string;
  readonly outcome: FulfillmentResultStatus;
  readonly roleKey?: CustomerRoleKey;
  readonly code?: FulfillmentErrorCode;
  readonly occurredAt: IsoTimestamp;
}

/** A transport adapter may wrap the request, but must preserve the contract fields. */
export interface FulfillmentRequestEnvelope {
  readonly request: FulfillmentRequest;
  readonly receivedAt?: IsoTimestamp;
}
