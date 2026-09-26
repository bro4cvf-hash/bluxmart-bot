"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEMANTIC_CHANNEL_NAMES = exports.SEMANTIC_CHANNEL_TO_LEGACY_KEY = exports.LEGACY_CHANNEL_TO_SEMANTIC_KEY = exports.CHANNEL_KEY_ALIASES = exports.LEGACY_CHANNEL_ALIASES = exports.LEGACY_CHANNEL_KEYS = exports.PERSISTED_CHANNEL_KEYS = exports.CHANNEL_KEYS = exports.CANONICAL_CHANNEL_KEYS = exports.SEMANTIC_CHANNEL_KEYS = exports.CATEGORY_SHORT_NAME_ALIASES = exports.LEGACY_CATEGORY_NAME_TO_KEY = exports.LEGACY_CATEGORY_ALIASES = exports.CATEGORY_KEY_TO_NAME = exports.CATEGORY_NAMES = exports.CANONICAL_CATEGORY_KEYS = exports.SEMANTIC_CATEGORY_KEYS = exports.CATEGORY_KEYS = exports.LEGACY_ROLE_NAME_TO_KEY = exports.LEGACY_ROLE_ALIASES = exports.ROLE_KEY_TO_NAME = exports.ROLE_NAMES = exports.CANONICAL_ROLE_KEYS = exports.SEMANTIC_ROLE_KEYS = exports.ROLE_KEYS = void 0;
/** Managed role keys, ordered from highest to lowest privilege in the current layout. */
exports.ROLE_KEYS = [
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
];
exports.SEMANTIC_ROLE_KEYS = exports.ROLE_KEYS;
exports.CANONICAL_ROLE_KEYS = exports.ROLE_KEYS;
exports.ROLE_NAMES = {
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
};
exports.ROLE_KEY_TO_NAME = exports.ROLE_NAMES;
/** Current persisted/state role names map to the stable semantic key. */
exports.LEGACY_ROLE_ALIASES = {
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
};
/** Alias with a more explicit name for migration code. */
exports.LEGACY_ROLE_NAME_TO_KEY = exports.LEGACY_ROLE_ALIASES;
/** Canonical category keys.  The current display labels are mapped below. */
exports.CATEGORY_KEYS = ['info', 'chat', 'voice', 'tickets', 'staff'];
exports.SEMANTIC_CATEGORY_KEYS = exports.CATEGORY_KEYS;
exports.CANONICAL_CATEGORY_KEYS = exports.CATEGORY_KEYS;
exports.CATEGORY_NAMES = {
    info: '📌 INFO',
    chat: '💬 CHAT',
    voice: '🔊 VOICE',
    tickets: '🎫 TICKETS',
    staff: '🛡️ STAFF',
};
exports.CATEGORY_KEY_TO_NAME = exports.CATEGORY_NAMES;
/** Names persisted by the pre-contract template/state and live reconciler. */
exports.LEGACY_CATEGORY_ALIASES = {
    '📌 INFO': 'info',
    '💬 CHAT': 'chat',
    '🔊 VOICE': 'voice',
    '🎫 TICKETS': 'tickets',
    '🛡️ STAFF': 'staff',
};
exports.LEGACY_CATEGORY_NAME_TO_KEY = exports.LEGACY_CATEGORY_ALIASES;
exports.CATEGORY_SHORT_NAME_ALIASES = {
    INFO: 'info',
    CHAT: 'chat',
    VOICE: 'voice',
    TICKETS: 'tickets',
    STAFF: 'staff',
};
/**
 * Preferred semantic channel keys.  These names describe purpose rather than
 * the current display label.  They are suitable for new state and interfaces.
 */
exports.SEMANTIC_CHANNEL_KEYS = [
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
];
exports.CANONICAL_CHANNEL_KEYS = exports.SEMANTIC_CHANNEL_KEYS;
/**
 * The short keys used by the current `bot-config.json` and `guilds.json`
 * records.  They are compatibility keys, not a new naming scheme.  A migration
 * may normalize them to `SemanticChannelKey` without changing a Discord ID.
 */
exports.CHANNEL_KEYS = [
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
];
exports.PERSISTED_CHANNEL_KEYS = exports.CHANNEL_KEYS;
exports.LEGACY_CHANNEL_KEYS = [
    ...exports.CHANNEL_KEYS,
    'reviews',
];
/**
 * Normalization table for the old persisted keys.  `reviews` was the original
 * single review/submission channel; it is intentionally mapped to the submit
 * side, never to the display feed.
 */
exports.LEGACY_CHANNEL_ALIASES = {
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
};
exports.CHANNEL_KEY_ALIASES = exports.LEGACY_CHANNEL_ALIASES;
exports.LEGACY_CHANNEL_TO_SEMANTIC_KEY = exports.LEGACY_CHANNEL_ALIASES;
/** Reverse mapping for adapters that must keep writing the current short keys. */
exports.SEMANTIC_CHANNEL_TO_LEGACY_KEY = {
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
};
/** Current display names for the semantic channel keys. */
exports.SEMANTIC_CHANNEL_NAMES = {
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
};
