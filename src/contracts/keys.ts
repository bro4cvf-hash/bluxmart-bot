/**
 * Stable semantic keys for the live-sync layout.
 *
 * Ownership: A02 owns these identifiers; the template/reconciler and dashboard
 * consume them.  Raw Discord snowflakes do not belong here; display labels
 * appear only in the explicit legacy maps below. Semantic keys are lower-case
 * and are the preferred key for new persistence
 * and contracts.  The legacy maps below are intentionally retained so existing
 * `data/guilds.json` records and the current template continue to work without
 * renaming managed resources.
 */

import type { CategoryId, ChannelId, RoleId } from './primitives';

/** Managed role keys, ordered from highest to lowest privilege in the current layout. */
export const ROLE_KEYS = [
  'owner',
  'admin',
  'manager',
  'dev',
  'moderator',
  'mod',
  'staff',
  'support',
  'bot',
  'media',
  'vip',
  'customer',
  'member',
  'muted',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
/** Explicit semantic name retained for consumers that want to document intent. */
export type SemanticRoleKey = RoleKey;
/** Compatibility alias used by newer callers. */
export type ManagedRoleKey = RoleKey;
export const SEMANTIC_ROLE_KEYS = ROLE_KEYS;
export const CANONICAL_ROLE_KEYS = ROLE_KEYS;

export const ROLE_NAMES = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  dev: 'Dev',
  moderator: 'Moderator',
  mod: 'Mod',
  staff: 'Staff',
  support: 'Support',
  bot: 'Bot',
  media: 'Media',
  vip: 'VIP',
  customer: 'Customer',
  member: 'Member',
  muted: 'Muted',
} as const satisfies Record<RoleKey, string>;

export type LegacyRoleName = (typeof ROLE_NAMES)[RoleKey];
export type RoleName = LegacyRoleName;
export type RoleKeyLike = RoleKey | LegacyRoleName;
export const ROLE_KEY_TO_NAME = ROLE_NAMES;

/** Current persisted/state role names map to the stable semantic key. */
export const LEGACY_ROLE_ALIASES = {
  Owner: 'owner',
  Admin: 'admin',
  Manager: 'manager',
  Dev: 'dev',
  Moderator: 'moderator',
  Mod: 'mod',
  Staff: 'staff',
  Support: 'support',
  Bot: 'bot',
  Media: 'media',
  VIP: 'vip',
  Customer: 'customer',
  Member: 'member',
  Muted: 'muted',
} as const satisfies Record<LegacyRoleName, RoleKey>;

/** Alias with a more explicit name for migration code. */
export const LEGACY_ROLE_NAME_TO_KEY = LEGACY_ROLE_ALIASES;

/** Canonical category keys.  The current display labels are mapped below. */
export const CATEGORY_KEYS = ['info', 'chat', 'voice', 'tickets', 'staff'] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];
export type SemanticCategoryKey = CategoryKey;
export type ManagedCategoryKey = CategoryKey;
export const SEMANTIC_CATEGORY_KEYS = CATEGORY_KEYS;
export const CANONICAL_CATEGORY_KEYS = CATEGORY_KEYS;

export const CATEGORY_NAMES = {
  info: '📌 INFO',
  chat: '💬 CHAT',
  voice: '🔊 VOICE',
  tickets: '🎫 TICKETS',
  staff: '🛡️ STAFF',
} as const satisfies Record<CategoryKey, string>;

export type LegacyCategoryName = (typeof CATEGORY_NAMES)[CategoryKey];
export type CategoryName = LegacyCategoryName;
export type CategoryKeyLike = CategoryKey | LegacyCategoryName | LegacyCategoryShortName;
export const CATEGORY_KEY_TO_NAME = CATEGORY_NAMES;

/** Names persisted by the pre-contract template/state and live reconciler. */
export const LEGACY_CATEGORY_ALIASES = {
  '📌 INFO': 'info',
  '💬 CHAT': 'chat',
  '🔊 VOICE': 'voice',
  '🎫 TICKETS': 'tickets',
  '🛡️ STAFF': 'staff',
} as const satisfies Record<LegacyCategoryName, CategoryKey>;

export const LEGACY_CATEGORY_NAME_TO_KEY = LEGACY_CATEGORY_ALIASES;
export const CATEGORY_SHORT_NAME_ALIASES = {
  INFO: 'info',
  CHAT: 'chat',
  VOICE: 'voice',
  TICKETS: 'tickets',
  STAFF: 'staff',
} as const satisfies Record<string, CategoryKey>;
export type LegacyCategoryShortName = keyof typeof CATEGORY_SHORT_NAME_ALIASES;

/**
 * Preferred semantic channel keys.  These names describe purpose rather than
 * the current display label.  They are suitable for new state and interfaces.
 */
export const SEMANTIC_CHANNEL_KEYS = [
  'welcome',
  'rules',
  'partnership',
  'announcements',
  'faq',
  'general_chat',
  'review_submit',
  'review_display',
  'giveaways',
  'bot_commands',
  'lounge',
  'support_1',
  'support_2',
  'create_ticket',
  'ticket_logs',
  'mod_logs',
  'staff_chat',
  'stock',
] as const;
export type SemanticChannelKey = (typeof SEMANTIC_CHANNEL_KEYS)[number];
export type ManagedChannelKey = SemanticChannelKey;
export const CANONICAL_CHANNEL_KEYS = SEMANTIC_CHANNEL_KEYS;

/**
 * The short keys used by the current `bot-config.json` and `guilds.json`
 * records.  They are compatibility keys, not a new naming scheme.  A migration
 * may normalize them to `SemanticChannelKey` without changing a Discord ID.
 */
export const CHANNEL_KEYS = [
  'welcome',
  'rules',
  'partnership',
  'announcements',
  'faq',
  'chat',
  'review_submit',
  'review_display',
  'giveaways',
  'bot',
  'lounge',
  'support1',
  'support2',
  'tickets',
  'ticketlogs',
  'modlog',
  'staff',
  'stock',
] as const;
export const PERSISTED_CHANNEL_KEYS = CHANNEL_KEYS;

export const LEGACY_CHANNEL_KEYS = [
  ...CHANNEL_KEYS,
  'reviews',
] as const;
/** Includes the old single-review `reviews` key as well as current short keys. */
export type LegacyChannelKey = (typeof LEGACY_CHANNEL_KEYS)[number];
export type LegacyChannelKeyOrAlias = LegacyChannelKey;

/** All keys accepted at a compatibility boundary, including `reviews`. */
export type ChannelKey = SemanticChannelKey | LegacyChannelKeyOrAlias;

/**
 * Normalization table for the old persisted keys.  `reviews` was the original
 * single review/submission channel; it is intentionally mapped to the submit
 * side, never to the display feed.
 */
export const LEGACY_CHANNEL_ALIASES = {
  welcome: 'welcome',
  rules: 'rules',
  partnership: 'partnership',
  announcements: 'announcements',
  faq: 'faq',
  chat: 'general_chat',
  review_submit: 'review_submit',
  review_display: 'review_display',
  giveaways: 'giveaways',
  bot: 'bot_commands',
  lounge: 'lounge',
  support1: 'support_1',
  support2: 'support_2',
  tickets: 'create_ticket',
  ticketlogs: 'ticket_logs',
  modlog: 'mod_logs',
  staff: 'staff_chat',
  stock: 'stock',
  reviews: 'review_submit',
} as const satisfies Record<LegacyChannelKeyOrAlias, SemanticChannelKey>;

export const CHANNEL_KEY_ALIASES = LEGACY_CHANNEL_ALIASES;
export const LEGACY_CHANNEL_TO_SEMANTIC_KEY = LEGACY_CHANNEL_ALIASES;

export type PersistedChannelKey = (typeof CHANNEL_KEYS)[number];

/** Reverse mapping for adapters that must keep writing the current short keys. */
export const SEMANTIC_CHANNEL_TO_LEGACY_KEY = {
  welcome: 'welcome',
  rules: 'rules',
  partnership: 'partnership',
  announcements: 'announcements',
  faq: 'faq',
  general_chat: 'chat',
  review_submit: 'review_submit',
  review_display: 'review_display',
  giveaways: 'giveaways',
  bot_commands: 'bot',
  lounge: 'lounge',
  support_1: 'support1',
  support_2: 'support2',
  create_ticket: 'tickets',
  ticket_logs: 'ticketlogs',
  mod_logs: 'modlog',
  staff_chat: 'staff',
  stock: 'stock',
} as const satisfies Record<SemanticChannelKey, PersistedChannelKey>;

/** Current display names for the semantic channel keys. */
export const SEMANTIC_CHANNEL_NAMES = {
  welcome: '👋・welcome',
  rules: '📜・rules',
  partnership: '🤝・partnership',
  announcements: '📢・announcements',
  faq: '❓・faq',
  general_chat: '💬・general-chat',
  review_submit: '⭐・leave-a-review',
  review_display: '🌟・reviews',
  giveaways: '🎁・giveaways',
  bot_commands: '🤖・bot-commands',
  lounge: '☕ Lounge',
  support_1: '🎧 Support 1',
  support_2: '🎧 Support 2',
  create_ticket: '🎫・create-ticket',
  ticket_logs: '📝・ticket-logs',
  mod_logs: '📝・mod-logs',
  staff_chat: '🛡️・staff-chat',
  stock: '📦・stock',
} as const satisfies Record<SemanticChannelKey, string>;

/**
 * Maps accepted at persistence boundaries may still contain custom template
 * keys.  The broad map is intentional; normalization/validation belongs to the
 * template and persistence owners, not to this contract.
 */
export type RoleIdMap = Readonly<Record<string, RoleId>>;
export type SemanticRoleIdMap = Readonly<Partial<Record<SemanticRoleKey, RoleId>>>;
export type ChannelIdMap = Readonly<Record<string, ChannelId>>;
export type SemanticChannelIdMap = Readonly<Partial<Record<SemanticChannelKey, ChannelId>>>;
export type CategoryIdMap = Readonly<Record<string, CategoryId>>;
export type SemanticCategoryIdMap = Readonly<Partial<Record<SemanticCategoryKey, CategoryId>>>;
