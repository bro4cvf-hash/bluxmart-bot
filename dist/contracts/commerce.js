"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CUSTOMER_ROLE_KEY = void 0;
exports.CUSTOMER_ROLE_KEY = 'customer';
