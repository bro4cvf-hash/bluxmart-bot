/**
 * Small, transport-neutral primitives shared by the contract modules.
 *
 * Ownership: this module owns names for opaque identifiers and safe transport
 * values only.  It deliberately has no Discord, HTTP framework, filesystem, or
 * commerce-provider dependency.  Implementations must validate the formats of
 * these strings at their boundaries rather than relying on TypeScript types at
 * runtime.
 */

/** An opaque Discord snowflake.  It is not a secret and must not be logged wholesale. */
export type DiscordId = string;
export type GuildId = DiscordId;
export type ChannelId = DiscordId;
export type CategoryId = DiscordId;
export type RoleId = DiscordId;
export type UserId = DiscordId;
export type MessageId = DiscordId;

/** RFC 3339/ISO-8601 UTC timestamp, for example `2026-09-24T12:00:00.000Z`. */
export type IsoTimestamp = string;

/** A millisecond duration or a Unix millisecond instant, as appropriate for the consumer. */
export type DurationMs = number;
export type UnixMillis = number;

/** A request/operation correlation value.  It is an identifier, not a credential. */
export type CorrelationId = string;

/** A deliberately small allow-list of values that may be returned in a public error. */
export type SafeMetadataValue = string | number | boolean | null;
export type SafeDetails = Readonly<Record<string, SafeMetadataValue>>;

/** A message that has been sanitized for transport to an untrusted caller. */
export type SafeMessage = string;

/**
 * A common result shape for ports owned by other agents.  `ok` is the
 * discriminant; callers must not infer success from the presence of a value.
 */
export type ContractResult<TValue, TError> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

/** A read-only string map suitable for JSON snapshots. */
export type StringMap = Readonly<Record<string, string>>;
