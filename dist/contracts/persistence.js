"use strict";
/**
 * Persistence contracts.
 *
 * Ownership: the persistence agent owns atomic writes, locking, backups, and
 * revision generation.  Consumers own only the meaning of the data payload.
 * A revision is an opaque compare-and-swap token; callers must not derive one
 * from a timestamp or expose it as a credential.  Updates carry the revision
 * they read, and a mismatch is reported as a conflict rather than silently
 * overwriting another writer.
 */
Object.defineProperty(exports, "__esModule", { value: true });
