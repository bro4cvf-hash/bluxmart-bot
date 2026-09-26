"use strict";
/**
 * Discord operation and retry contracts.
 *
 * Ownership: A11 owns the coordinator, timeouts, and retry implementation.  No
 * `discord.js` types or gateway objects appear here, so ports can be tested with
 * deterministic fakes.  The invariant is one serialized decision per logical
 * operation key; a retry may repeat an idempotent call but must never report a
 * successful create without the resulting resource ID.
 */
Object.defineProperty(exports, "__esModule", { value: true });
