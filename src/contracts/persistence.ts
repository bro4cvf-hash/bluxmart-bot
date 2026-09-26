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

import type { IsoTimestamp } from './primitives';

export type PersistenceRevision = string;
export type SnapshotRevision = PersistenceRevision;
export type Revision = PersistenceRevision;
export type ETag = PersistenceRevision;

export type PersistenceResource =
  | 'guild_setup'
  | 'template'
  | 'fulfillment'
  | 'order'
  | 'ticket'
  | 'admin'
  | 'unknown';

export interface PersistenceSnapshot<TData> {
  /** Opaque CAS token assigned by the persistence owner. */
  readonly revision: PersistenceRevision;
  /** Schema version for migration code; it is not a Discord API version. */
  readonly schemaVersion: number;
  /** Time the snapshot was durably committed. */
  readonly updatedAt: IsoTimestamp;
  /** The validated, JSON-compatible payload. */
  readonly data: TData;
}

export type Snapshot<TData> = PersistenceSnapshot<TData>;

export type PersistenceErrorCode =
  | 'NOT_FOUND'
  | 'CORRUPT'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'LOCK_TIMEOUT'
  | 'VALIDATION_FAILED'
  | 'REVISION_CONFLICT'
  | 'CONCURRENT_WRITE'
  | 'BACKUP_FAILED'
  | 'INTERNAL_ERROR';

export interface PersistenceError {
  readonly code: PersistenceErrorCode;
  /** Sanitized summary; do not put a raw filesystem/provider error here. */
  readonly message: string;
  readonly retryable: boolean;
  readonly resource?: PersistenceResource;
  readonly resourceId?: string;
  readonly retryAfterMs?: number;
}

export interface RevisionConflict<TData = unknown> {
  readonly kind: 'conflict';
  readonly code: 'REVISION_CONFLICT';
  readonly resource: PersistenceResource;
  readonly resourceId: string;
  /** The revision supplied by the writer, or null for create-if-absent. */
  readonly expectedRevision: PersistenceRevision | null;
  /** The revision currently committed by the persistence owner. */
  readonly currentRevision: PersistenceRevision;
  /** Optional internal snapshot for a merge UI; never serialize secrets into it. */
  readonly current?: PersistenceSnapshot<TData>;
}

export type PersistenceConflict<TData = unknown> = RevisionConflict<TData>;

export interface PersistenceWriteRequest<TData> {
  /** Null means create only when the resource does not already exist. */
  readonly expectedRevision: PersistenceRevision | null;
  readonly data: TData;
}

export type PersistenceReadResult<TData> =
  | {
      readonly kind: 'found';
      readonly snapshot: PersistenceSnapshot<TData>;
    }
  | {
      readonly kind: 'missing';
      readonly resource: PersistenceResource;
      readonly resourceId: string;
    }
  | {
      readonly kind: 'corrupt';
      readonly resource: PersistenceResource;
      readonly resourceId: string;
      readonly error: PersistenceError;
      /** The owner may expose this boolean, never the raw file contents. */
      readonly backupAvailable: boolean;
    };

export type SnapshotReadResult<TData> = PersistenceReadResult<TData>;

export type PersistenceWriteResult<TData> =
  | {
      readonly kind: 'written';
      readonly ok: true;
      readonly snapshot: PersistenceSnapshot<TData>;
      readonly created: boolean;
    }
  | {
      readonly kind: 'conflict';
      readonly ok: false;
      readonly conflict: RevisionConflict<TData>;
    }
  | {
      readonly kind: 'error';
      readonly ok: false;
      readonly error: PersistenceError;
    };

export type SnapshotWriteResult<TData> = PersistenceWriteResult<TData>;

/** Minimal port shape; implementation details such as fs, locks, and backups stay private. */
export interface PersistenceRepository<TData> {
  read(resourceId: string): Promise<PersistenceReadResult<TData>>;
  write(
    resourceId: string,
    request: PersistenceWriteRequest<TData>,
  ): Promise<PersistenceWriteResult<TData>>;
}
