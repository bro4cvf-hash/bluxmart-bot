"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEGACY_TICKET_TOPIC_PREFIX = exports.TICKET_PANEL_CUSTOM_ID_PREFIX = exports.TICKET_CLOSE_CUSTOM_ID = exports.TICKET_KINDS = exports.TICKET_TYPE_IDS = void 0;
exports.TICKET_TYPE_IDS = [
    'ticket_bug',
    'ticket_claim',
    'ticket_general',
    'ticket_staff',
    'ticket_partner',
];
exports.TICKET_KINDS = ['bug', 'claim', 'general', 'staff', 'partner'];
/** Custom IDs currently emitted by the live ticket panel. */
exports.TICKET_CLOSE_CUSTOM_ID = 'ticket_close';
exports.TICKET_PANEL_CUSTOM_ID_PREFIX = 'ticket_';
exports.LEGACY_TICKET_TOPIC_PREFIX = 'ticket:';
