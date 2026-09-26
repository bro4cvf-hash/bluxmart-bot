/**
 * Ticket lifecycle contracts.
 *
 * Ownership: the ticket feature agents own channel creation, close
 * authorization, transcript delivery, and durable evidence.  This contract
 * keeps the current custom IDs and `ticket:<kind>:<userId>` topic shape
 * readable by legacy messages while defining a safe lifecycle.  In particular,
 * a ticket may not be deleted until its evidence is durable and its log has
 * been delivered (or an explicitly authorized force path is used).
 */

import type { ChannelId, GuildId, IsoTimestamp, RoleId, UserId } from './primitives';
import type { RoleKey } from './keys';

export const TICKET_TYPE_IDS = [
  'ticket_bug',
  'ticket_claim',
  'ticket_general',
  'ticket_staff',
  'ticket_partner',
] as const;
export type BuiltinTicketTypeId = (typeof TICKET_TYPE_IDS)[number];
/**
 * The live template has historically allowed additional `ticket_...` IDs.
 * Keep that wire compatibility; the template owner must validate the suffix
 * against the configured allow-list before creating a ticket.
 */
export type TicketTypeId = BuiltinTicketTypeId | `ticket_${string}`;
export type TicketTypeKey = TicketTypeId;

export const TICKET_KINDS = ['bug', 'claim', 'general', 'staff', 'partner'] as const;
export type BuiltinTicketKind = (typeof TICKET_KINDS)[number];
/** Custom template types may use another kind; validate it at runtime. */
export type TicketKind = BuiltinTicketKind | (string & {});

/** Custom IDs currently emitted by the live ticket panel. */
export const TICKET_CLOSE_CUSTOM_ID = 'ticket_close' as const;
export const TICKET_PANEL_CUSTOM_ID_PREFIX = 'ticket_' as const;
/** `ticket_close` is a control ID, never a ticket type accepted by creation. */
export type TicketPanelCustomId = Exclude<TicketTypeId, typeof TICKET_CLOSE_CUSTOM_ID>;
export type TicketCustomId = TicketPanelCustomId | typeof TICKET_CLOSE_CUSTOM_ID;
export type TicketCloseCustomId = typeof TICKET_CLOSE_CUSTOM_ID;

export type TicketLifecycleState =
  | 'requested'
  | 'creating'
  | 'open'
  | 'closing'
  | 'closed'
  | 'archived'
  | 'close_failed'
  | 'deleted';

export type TicketStatus = TicketLifecycleState;
export type SimpleTicketStatus = 'open' | 'closed' | 'archived';
export type LegacyTicketStatus = SimpleTicketStatus;
export type TicketEvidenceState = 'not_started' | 'collecting' | 'captured' | 'durable' | 'failed';
export type TicketLogState = 'not_started' | 'queued' | 'delivered' | 'failed' | 'not_configured';

export type TicketErrorCode =
  | 'unknown_type'
  | 'already_exists'
  | 'rate_limited'
  | 'permission_denied'
  | 'not_in_guild'
  | 'ticket_not_found'
  | 'not_authorized'
  | 'limit_reached'
  | 'invalid_state'
  | 'transcript_failed'
  | 'log_delivery_failed'
  | 'persistence_failure'
  | 'cancelled'
  | 'unknown';

/** The current topic format is retained as a compatibility alias. */
export type LegacyTicketTopic = `ticket:${string}:${string}`;
export const LEGACY_TICKET_TOPIC_PREFIX = 'ticket:' as const;

export interface LegacyTicketContext {
  readonly customId: TicketCustomId;
  readonly topic?: LegacyTicketTopic;
  readonly kind?: TicketKind;
  readonly openerId?: UserId;
}

export interface TicketRecord {
  /** Durable application ticket ID; it need not equal the Discord channel ID. */
  readonly ticketId: string;
  readonly guildId: GuildId;
  readonly channelId?: ChannelId;
  readonly openerId: UserId;
  readonly type: TicketPanelCustomId;
  readonly state: TicketLifecycleState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly closedAt?: IsoTimestamp;
  readonly closedBy?: UserId;
  readonly closeReason?: string;
  readonly evidence?: TicketEvidenceState;
  readonly logState?: TicketLogState;
  /** Optional opaque reference to durable evidence; never a local secret/path. */
  readonly durableReference?: string;
  readonly legacy?: LegacyTicketContext;
}

export type TicketLifecycleEvent =
  | 'requested'
  | 'created'
  | 'opened'
  | 'close_requested'
  | 'closed'
  | 'archived'
  | 'close_failed'
  | 'deleted';

export interface TicketLifecycleTransition {
  readonly ticketId: string;
  readonly from: TicketLifecycleState;
  readonly to: TicketLifecycleState;
  readonly event: TicketLifecycleEvent;
  readonly actorId: UserId;
  readonly occurredAt: IsoTimestamp;
  readonly reasonCode?: TicketErrorCode;
}

export type TicketLifecycle = TicketLifecycleTransition;

export interface TicketCreationRequest {
  readonly guildId: GuildId;
  readonly openerId: UserId;
  readonly type: TicketPanelCustomId;
  /** Idempotency key for retries of the same interaction. */
  readonly idempotencyKey?: string;
  readonly sourceCustomId?: TicketPanelCustomId;
  readonly createdAt?: IsoTimestamp;
}

export type TicketCreationResult =
  | {
      readonly status: 'created';
      readonly ticket: TicketRecord;
    }
  | {
      readonly status: 'already_exists';
      readonly ticket: TicketRecord;
    }
  | {
      readonly status: 'rejected';
      readonly code: TicketErrorCode;
      readonly message: string;
      readonly existing?: TicketRecord;
    }
  | {
      readonly status: 'failed';
      readonly code: TicketErrorCode;
      readonly message: string;
      readonly retryable: boolean;
    };

export type TicketOpenResult = TicketCreationResult;

export interface TicketCloseRequest {
  readonly guildId: GuildId;
  readonly channelId: ChannelId;
  readonly requestedBy: UserId;
  readonly ticketId?: string;
  readonly reason?: string;
  /** Force is an explicit operator override, never an implicit fallback. */
  readonly force?: boolean;
  readonly idempotencyKey?: string;
}

export interface TicketCloseAuthorization {
  readonly actorId: UserId;
  readonly actorRoleKeys: readonly RoleKey[];
  readonly canClose: boolean;
  readonly canForce: boolean;
  readonly managedRoleIds?: readonly RoleId[];
}

export type TicketDeleteReason =
  | 'evidence_not_durable'
  | 'log_not_delivered'
  | 'not_authorized'
  | 'already_deleted'
  | 'invalid_state'
  | 'unknown';

/** Deletion is a separate decision so a close failure cannot become a false success. */
export type TicketDeleteDecision =
  | {
      readonly allowed: true;
      readonly deleted: true;
      readonly ticketId: string;
      readonly evidence: 'durable';
      readonly logDelivered: true;
      readonly deleteAfterEvidenceAt: IsoTimestamp;
    }
  | {
      readonly allowed: false;
      readonly deleted: false;
      readonly ticketId?: string;
      readonly reason: TicketDeleteReason;
    };

export type TicketCloseResult =
  | {
      readonly status: 'closed';
      readonly ticket: TicketRecord;
      readonly decision: TicketDeleteDecision;
    }
  | {
      readonly status: 'already_closed';
      readonly ticket: TicketRecord;
      readonly decision: Extract<TicketDeleteDecision, { allowed: false }>;
    }
  | {
      readonly status: 'blocked';
      readonly code: TicketErrorCode;
      readonly message: string;
      readonly decision: Extract<TicketDeleteDecision, { allowed: false }>;
    }
  | {
      readonly status: 'failed';
      readonly code: TicketErrorCode;
      readonly message: string;
      readonly retryable: boolean;
      readonly decision: Extract<TicketDeleteDecision, { allowed: false }>;
    };

export interface TicketCloseProgress {
  readonly ticketId: string;
  readonly state: TicketLifecycleState;
  readonly messageCount?: number;
  readonly evidence: TicketEvidenceState;
  readonly log: TicketLogState;
  readonly failure?: {
    readonly code: TicketErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type TicketArchiveProgress = TicketCloseProgress;
export type TicketOperationResult = TicketCreationResult | TicketCloseResult;
