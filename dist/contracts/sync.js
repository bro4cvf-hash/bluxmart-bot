"use strict";
/**
 * Safe setup and live-sync status contracts.
 *
 * Ownership: A10 owns reconciliation and queueing; this module only describes
 * observable outcomes.  A failed guild must never turn a whole multi-guild
 * sync into a false success, and a result must never carry a raw exception,
 * filesystem path, or provider response.  Existing `created/repaired/roles/
 * channels` fields remain present for live-sync consumers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
