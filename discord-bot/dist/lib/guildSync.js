"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TICKET_TYPES = exports.ROLE_ORDER_TOP_FIRST = void 0;
exports.ticketTypeFromId = ticketTypeFromId;
exports.ticketTypeFromIdLive = ticketTypeFromIdLive;
exports.syncGuild = syncGuild;
exports.queueGuildSync = queueGuildSync;
exports.syncAllGuilds = syncAllGuilds;
exports.requestTemplateSync = requestTemplateSync;
exports.watchTemplateChanges = watchTemplateChanges;
const discord_js_1 = require("discord.js");
const fs_1 = require("fs");
const promises_1 = require("fs/promises");
const crypto_1 = require("crypto");
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const store_1 = require("../store");
const botConfig_1 = require("../botConfig");
// Permission name (dashboard-editable) -> discord.js bit
const PERM_MAP = {
    Administrator: discord_js_1.PermissionFlagsBits.Administrator,
    ManageGuild: discord_js_1.PermissionFlagsBits.ManageGuild,
    ManageRoles: discord_js_1.PermissionFlagsBits.ManageRoles,
    ManageChannels: discord_js_1.PermissionFlagsBits.ManageChannels,
    ManageMessages: discord_js_1.PermissionFlagsBits.ManageMessages,
    KickMembers: discord_js_1.PermissionFlagsBits.KickMembers,
    BanMembers: discord_js_1.PermissionFlagsBits.BanMembers,
    ModerateMembers: discord_js_1.PermissionFlagsBits.ModerateMembers,
    ManageNicknames: discord_js_1.PermissionFlagsBits.ManageNicknames,
    ViewAuditLog: discord_js_1.PermissionFlagsBits.ViewAuditLog,
    ViewChannel: discord_js_1.PermissionFlagsBits.ViewChannel,
    SendMessages: discord_js_1.PermissionFlagsBits.SendMessages,
    ReadMessageHistory: discord_js_1.PermissionFlagsBits.ReadMessageHistory,
    Connect: discord_js_1.PermissionFlagsBits.Connect,
    Speak: discord_js_1.PermissionFlagsBits.Speak,
};
// Canonical role hierarchy, top -> bottom. Single source of truth for
// ordering, sidebar display (hoist) and channel access tiers.
exports.ROLE_ORDER_TOP_FIRST = [
    'Owner',
    'Admin',
    'Manager',
    'Dev',
    'Moderator',
    'Mod',
    'Staff',
    'Support',
    'Bot',
    'Media',
    'VIP',
    'Customer',
    'Member',
    'Muted',
];
// Hoisted (separate sidebar groups). Muted is NEVER hoisted.
const MUTED_TEXT_DENY = [
    discord_js_1.PermissionFlagsBits.SendMessages,
    discord_js_1.PermissionFlagsBits.AddReactions,
    discord_js_1.PermissionFlagsBits.CreatePublicThreads,
    discord_js_1.PermissionFlagsBits.CreatePrivateThreads,
    discord_js_1.PermissionFlagsBits.SendMessagesInThreads,
];
const HOIST_NAMES = [
    'Owner',
    'Admin',
    'Manager',
    'Dev',
    'Moderator',
    'Mod',
    'Staff',
    'Support',
    'Bot',
    'Media',
    'VIP',
    'Customer',
    'Member',
];
// Human staff (sees mod-logs / staff-chat / stock + normal tickets).
const STAFF_NAMES = ['Owner', 'Admin', 'Manager', 'Dev', 'Moderator', 'Mod', 'Staff', 'Support'];
// Senior staff only (sees ticket-logs + Staff Report tickets).
const SENIOR_NAMES = ['Owner', 'Admin', 'Manager'];
function permsToBits(names) {
    return names.map((n) => PERM_MAP[n]).filter((b) => typeof b === 'bigint');
}
// --- Incremental sync helpers: only touch Discord when drift is detected ---
// This keeps re-runs / boot auto-sync fast and avoids hammering rate limits.
function resolveBits(list) {
    if (list == null)
        return 0n;
    const arr = Array.isArray(list) ? list : [list];
    let bits = 0n;
    for (const b of arr) {
        try {
            bits |= typeof b === 'bigint' ? b : BigInt(b);
        }
        catch { }
    }
    return bits;
}
function overwritesMatch(channel, desired) {
    try {
        const cache = channel.permissionOverwrites.cache;
        if (cache.size !== desired.length)
            return false;
        for (const d of desired) {
            const cur = cache.get(d.id);
            if (!cur)
                return false;
            if (cur.allow.bitfield !== resolveBits(d.allow))
                return false;
            if (cur.deny.bitfield !== resolveBits(d.deny))
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function rolePermsMatch(existing, want) {
    let wantBits = 0n;
    for (const b of want)
        wantBits |= b;
    try {
        return existing.permissions.bitfield === wantBits;
    }
    catch {
        return false;
    }
}
function componentsSignature(components) {
    try {
        if (!components || components.length === 0)
            return 'none';
        const norm = components.map((row) => {
            const j = typeof row?.toJSON === 'function' ? row.toJSON() : row;
            const comps = (j?.components ?? []).map((c) => ({
                id: c.custom_id ?? c.customId ?? '',
                opts: (c.options ?? []).map((o) => o.value ?? o.label ?? '').join(','),
                label: c.label ?? '',
            }));
            return JSON.stringify(comps);
        });
        return norm.join('|');
    }
    catch {
        return 'unknown';
    }
}
function existingComponentsSignature(msg) {
    try {
        const comps = (msg.components ?? []).map((row) => {
            const inner = (row.components ?? []).map((c) => ({
                id: c.customId ?? '',
                opts: (c.options ?? []).map((o) => o.value ?? '').join(','),
                label: c.label ?? '',
            }));
            return JSON.stringify(inner);
        });
        return comps.length > 0 ? comps.join('|') : 'none';
    }
    catch {
        return 'unknown';
    }
}
function panelMatches(msg, embeds, components) {
    try {
        const e = (msg.embeds ?? [])[0];
        if (!e)
            return false;
        const want = embeds[0]?.toJSON();
        if (!want)
            return false;
        if ((e.title ?? '') !== (want.title ?? ''))
            return false;
        if ((e.description ?? '') !== (want.description ?? ''))
            return false;
        return existingComponentsSignature(msg) === componentsSignature(components);
    }
    catch {
        return false;
    }
}
function styleFromName(s) {
    switch (s) {
        case 'Primary':
            return discord_js_1.ButtonStyle.Primary;
        case 'Secondary':
            return discord_js_1.ButtonStyle.Secondary;
        case 'Success':
            return discord_js_1.ButtonStyle.Success;
        case 'Danger':
        default:
            return discord_js_1.ButtonStyle.Danger;
    }
}
// Dashboard-editable template (data/bot-config.json) with built-in fallback.
// Kept as static fallback so the bot still works if the config file is missing.
// Colors are all DISTINCT; hierarchy is Owner > Admin > Manager > Dev >
// Moderator > Mod > Staff > Support > Bot > Media > VIP > Customer > Member > Muted.
const FALLBACK_ROLES = [
    { name: 'Owner', color: 0x93c5fd, perms: ['Administrator'] },
    { name: 'Admin', color: 0xff6b6b, perms: ['Administrator'] },
    { name: 'Manager', color: 0x991b1b, perms: ['ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog', 'ManageNicknames'] },
    { name: 'Dev', color: 0x2ecc71, perms: ['ManageChannels', 'ManageMessages', 'ViewAuditLog'] },
    { name: 'Moderator', color: 0xe67e22, perms: ['ManageMessages', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageNicknames', 'ViewAuditLog'] },
    { name: 'Mod', color: 0x8b5cf6, perms: ['ManageMessages', 'KickMembers', 'ModerateMembers', 'ManageNicknames'] },
    { name: 'Staff', color: 0x14b8a6, perms: ['ManageMessages', 'ModerateMembers'] },
    { name: 'Support', color: 0x38bdf8, perms: ['ManageMessages'] },
    { name: 'Bot', color: 0x5865f2, perms: [] },
    { name: 'Media', color: 0xec4899, perms: [] },
    { name: 'VIP', color: 0xf1c40f, perms: [] },
    { name: 'Customer', color: 0x1e40af, perms: [] },
    { name: 'Member', color: 0xb8c0cc, perms: [] },
    { name: 'Muted', color: 0x4b5563, perms: [] },
];
exports.TICKET_TYPES = [
    { id: 'ticket_bug', label: 'Bug Report', emoji: '🐛', style: discord_js_1.ButtonStyle.Danger },
    { id: 'ticket_claim', label: 'Item Claim', emoji: '📦', style: discord_js_1.ButtonStyle.Success },
    { id: 'ticket_general', label: 'General Issue', emoji: '❓', style: discord_js_1.ButtonStyle.Primary },
    { id: 'ticket_staff', label: 'Staff Report', emoji: '🚨', style: discord_js_1.ButtonStyle.Secondary },
    { id: 'ticket_partner', label: 'Partnership', emoji: '🤝', style: discord_js_1.ButtonStyle.Secondary },
];
async function findOrCreateRole(guild, name, color, perms, managedId, allowNameFallback = false) {
    // Once a guild has persisted state, managed IDs are authoritative. This avoids
    // adopting and mutating an unrelated role that happens to have the same name.
    const managed = managedId ? guild.roles.cache.get(managedId) : undefined;
    const existing = managed ?? (allowNameFallback ? guild.roles.cache.find((r) => r.name === name) : undefined);
    if (existing) {
        const nameOk = existing.name === name;
        const colorOk = existing.color === color;
        const permsOk = rolePermsMatch(existing, perms);
        if (!nameOk || !colorOk || !permsOk) {
            await existing.edit({ name, color, permissions: perms });
        }
        return guild.roles.cache.get(existing.id) ?? existing;
    }
    return guild.roles.create({ name, color, permissions: perms, reason: 'BluxBot live sync: create role' });
}
function ticketTypeFromId(id) {
    return exports.TICKET_TYPES.find((t) => t.id === id);
}
async function ticketTypeFromIdLive(id) {
    try {
        const t = await (0, botConfig_1.getTemplate)();
        const found = t.ticketTypes.find((x) => x.id === id);
        if (!found)
            return undefined;
        return { id: found.id, label: found.label, emoji: found.emoji, style: styleFromName(found.style) };
    }
    catch {
        return ticketTypeFromId(id);
    }
}
async function syncGuild(guild) {
    let tpl;
    try {
        tpl = await (0, botConfig_1.getTemplate)();
    }
    catch {
        tpl = {
            roles: FALLBACK_ROLES,
            ticketTypes: [],
            structure: [],
            ticketPrompts: {},
            panels: {
                rulesTitle: 'Rules',
                rulesDescription: '',
                faqTitle: 'FAQ',
                faqDescription: '',
                welcomeTitle: 'Welcome',
                welcomeDescription: '',
                reviewsTitle: 'Reviews',
                reviewsDescription: '',
                ticketsTitle: 'Support',
                ticketsDescription: '',
                partnershipTitle: 'Partnership',
                partnershipDescription: '',
            },
        };
    }
    const roleDefs = tpl.roles.length > 0 ? tpl.roles : FALLBACK_ROLES;
    // Persisted IDs are authoritative after the first sync. Name-based discovery is
    // reserved for a guild's initial adoption so unrelated resources are never mutated.
    const prevSetup = await (0, store_1.getGuildSetup)(guild.id).catch(() => null);
    const hasManagedState = prevSetup !== null;
    const prevChannels = prevSetup?.channels ?? {};
    const prevRoles = prevSetup?.roles ?? {};
    let createdCount = 0;
    let repairedCount = 0;
    const markRepaired = () => {
        repairedCount++;
    };
    const throttleWrite = async () => {
        // Only pause when we actually wrote — keeps steady runs fast, still safe on bursts.
        await new Promise((r) => setTimeout(r, 400));
    };
    // 1. Roles
    console.log(`[sync] roles: ${guild.name ?? guild.id}`);
    const roleIds = {};
    for (const r of roleDefs) {
        const role = await findOrCreateRole(guild, r.name, r.color, permsToBits(r.perms ?? []), prevRoles[r.name], !hasManagedState);
        roleIds[r.name] = role.id;
    }
    const getRole = (n) => guild.roles.cache.get(roleIds[n]);
    // Hoist display roles so sidebar splits into separate groups (not just Online).
    // Muted is NEVER hoisted (muted users stay hidden in Online).
    for (const n of HOIST_NAMES) {
        const r = guild.roles.cache.get(roleIds[n]);
        if (r && !r.hoist)
            await r.edit({ hoist: true }).catch(() => { });
    }
    // Muted must never hoist.
    try {
        const mutedHoist = guild.roles.cache.get(roleIds['Muted']);
        if (mutedHoist?.hoist)
            await mutedHoist.edit({ hoist: false }).catch(() => { });
    }
    catch { }
    // Sidebar order top->bottom (canonical hierarchy):
    // Owner > Admin > Manager > Dev > Moderator > Mod > Staff > Support >
    // Bot > Media > VIP > Customer > Member > Muted
    // Incremental: only call setPositions when the order actually drifted.
    try {
        const orderTopFirst = exports.ROLE_ORDER_TOP_FIRST;
        await guild.roles.fetch();
        const botTop = guild.members.me?.roles.highest.position ?? 999;
        // Current relative order of our managed roles (higher position = higher in list).
        const managed = orderTopFirst
            .map((n) => guild.roles.cache.find((x) => x.name === n))
            .filter(Boolean);
        let orderOk = true;
        for (let i = 0; i + 1 < managed.length; i++) {
            if (managed[i].position <= managed[i + 1].position) {
                orderOk = false;
                break;
            }
        }
        if (!orderOk) {
            // assign positions bottom-up starting above @everyone (Muted=1 ... Owner=N)
            let pos = 1;
            const posMap = [];
            for (let i = orderTopFirst.length - 1; i >= 0; i--) {
                const r = guild.roles.cache.find((x) => x.name === orderTopFirst[i]);
                if (r) {
                    const target = Math.min(pos, botTop - 1);
                    if (r.position !== target)
                        posMap.push({ role: r.id, position: target });
                    pos++;
                }
            }
            if (posMap.length > 0) {
                await guild.roles.setPositions(posMap).catch(() => { });
                markRepaired();
            }
            await guild.roles.fetch();
        }
    }
    catch { }
    console.log(`[sync] roles reconciled: ${Object.keys(roleIds).length}`);
    const memberRole = guild.roles.cache.get(roleIds['Member']) ??
        guild.roles.cache.get(roleIds['Customer']) ??
        guild.roles.cache.get(Object.values(roleIds)[0] ?? '');
    const mutedRole = guild.roles.cache.get(roleIds['Muted']);
    const staffAllow = STAFF_NAMES.map(getRole).filter(Boolean);
    // ticket-logs holds transcripts + staff reports -> senior staff only.
    // (Support/Staff/Mod must NOT see Staff Reports about themselves.)
    const seniorOnly = SENIOR_NAMES.map(getRole).filter(Boolean);
    // 2. Categories + channels
    console.log(`[sync] categories/channels: ${guild.name ?? guild.id}`);
    const everyone = guild.roles.everyone;
    const botWriterRoles = [...(guild.members.me?.roles.cache.values() ?? [])].filter((r) => r.id !== everyone.id && r.id !== mutedRole?.id && !staffAllow.some((staff) => staff.id === r.id));
    const channelIds = {};
    let ticketCategoryId = '';
    let welcomeChannelId = '';
    let logChannelId = '';
    let reviewParent;
    const structure = tpl.structure.length > 0 ? tpl.structure : [];
    const categoryIds = {};
    for (const block of structure) {
        console.log(`[sync] category: ${block.category}`);
        const blockKeys = new Set(block.channels.map((channel) => channel.key));
        const priorCategoryFromChildren = Object.entries(prevChannels).find(([key, id]) => {
            if (!blockKeys.has(key))
                return false;
            const channel = guild.channels.cache.get(id);
            return !!(channel && 'parentId' in channel && channel.parentId);
        });
        const priorChild = priorCategoryFromChildren
            ? guild.channels.cache.get(priorCategoryFromChildren[1])
            : undefined;
        const priorCategoryId = prevSetup?.categoryIds?.[block.category] ??
            (priorChild && 'parentId' in priorChild ? priorChild.parentId : undefined);
        let category = priorCategoryId
            ? guild.channels.cache.get(priorCategoryId) ??
                await guild.channels.fetch(priorCategoryId).catch(() => null)
            : undefined;
        category ??= !hasManagedState
            ? guild.channels.cache.find((c) => c.type === discord_js_1.ChannelType.GuildCategory && c.name === block.category)
            : undefined;
        // Rename legacy MARKET only during initial adoption. Managed categories are
        // renamed in place through their persisted/derived IDs.
        if (!category && !hasManagedState && block.category.includes('CHAT')) {
            const old = guild.channels.cache.find((c) => c.type === discord_js_1.ChannelType.GuildCategory && c.name.includes('MARKET'));
            if (old) {
                category = old;
            }
        }
        if (!category) {
            category = await guild.channels.create({ name: block.category, type: discord_js_1.ChannelType.GuildCategory });
            createdCount++;
        }
        else if (category.name !== block.category) {
            await category.setName(block.category);
            markRepaired();
        }
        categoryIds[block.category] = category.id;
        if (block.channels.some((c) => c.key === 'review_submit' || c.key === 'review_display' || c.key === 'reviews')) {
            reviewParent = category;
        }
        if (block.category.includes('TICKETS'))
            ticketCategoryId = category.id;
        // Lock STAFF category so normal members can't see it at all (only fix when drifted).
        if (block.category.includes('STAFF')) {
            const want = [
                { id: everyone.id, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] },
                ...staffAllow.map((r) => ({ id: r.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory] })),
            ];
            if (!overwritesMatch(category, want)) {
                await category.permissionOverwrites.set(want);
                markRepaired();
                await throttleWrite();
            }
        }
        else if (block.category.includes('INFO') || block.category.includes('CHAT') || block.category.includes('VOICE')) {
            // Public categories should inherit; only repair when an explicit deny exists.
            if (!overwritesMatch(category, [])) {
                await category.permissionOverwrites.set([]);
                markRepaired();
                await throttleWrite();
            }
        }
        for (const ch of block.channels) {
            console.log(`[sync] channel: ${ch.key}`);
            // ---- Channel access matrix (every role -> every channel) ----
            // seniorOnly : ticket-logs        -> @everyone DENY View, senior (Owner/Admin/Manager) ALLOW
            // staffOnly  : staff-chat/mod-logs/stock -> @everyone DENY View, all staff ALLOW
            // staffPost  : giveaways -> everyone can View/Read/React, but only staff + bot can Send
            // readonly   : welcome/rules/partnership/announcements/faq/reviews/create-ticket
            //              -> @everyone View ALLOW + Send DENY, staff ALLOW Send, Muted DENY Send
            // openText   : general-chat/bot-commands -> inherit (@everyone can View+Send), Muted DENY Send
            // openVoice  : Lounge/Support 1/2  -> @everyone ALLOW View+Connect+Speak, Muted DENY Connect+Speak
            // Normal roles (Bot/Media/VIP/Customer/Member) cannot see staff/senior channels.
            // Giveaway entries use reactions; normal member/customer/media roles cannot chat there.
            const isVoiceCh = ch.type === 'voice';
            const isSeniorOnly = ch.key === 'ticketlogs';
            const isStaffOnly = ch.key === 'staff' || ch.key === 'modlog' || ch.key === 'stock';
            const isStaffPostOnly = ch.key === 'giveaways';
            const isReadonly = ch.key === 'rules' ||
                ch.key === 'announcements' ||
                ch.key === 'welcome' ||
                ch.key === 'faq' ||
                ch.key === 'partnership' ||
                ch.key === 'reviews' ||
                ch.key === 'tickets' ||
                ch.key === 'review_submit' ||
                ch.key === 'review_display';
            const buildOverwrites = () => {
                if (isSeniorOnly) {
                    const ow = [
                        { id: everyone.id, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] },
                    ];
                    for (const r of seniorOnly) {
                        ow.push({ id: r.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory] });
                    }
                    if (mutedRole)
                        ow.push({ id: mutedRole.id, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] });
                    return ow;
                }
                if (isStaffOnly) {
                    const ow = [
                        { id: everyone.id, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] },
                    ];
                    for (const r of staffAllow) {
                        ow.push({ id: r.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory] });
                    }
                    if (mutedRole)
                        ow.push({ id: mutedRole.id, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] });
                    return ow;
                }
                if (isStaffPostOnly) {
                    const ow = [
                        {
                            id: everyone.id,
                            allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.ReadMessageHistory, discord_js_1.PermissionFlagsBits.AddReactions],
                            deny: [discord_js_1.PermissionFlagsBits.SendMessages],
                        },
                    ];
                    for (const r of staffAllow) {
                        ow.push({
                            id: r.id,
                            allow: [
                                discord_js_1.PermissionFlagsBits.ViewChannel,
                                discord_js_1.PermissionFlagsBits.SendMessages,
                                discord_js_1.PermissionFlagsBits.ReadMessageHistory,
                                discord_js_1.PermissionFlagsBits.AddReactions,
                            ],
                        });
                    }
                    for (const r of botWriterRoles) {
                        ow.push({ id: r.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory] });
                    }
                    if (mutedRole)
                        ow.push({ id: mutedRole.id, deny: MUTED_TEXT_DENY });
                    return ow;
                }
                if (isReadonly) {
                    const ow = [
                        {
                            id: everyone.id,
                            allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.ReadMessageHistory],
                            deny: [discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.AddReactions],
                        },
                    ];
                    // Staff can still post announcements / manage panels.
                    for (const r of staffAllow) {
                        ow.push({ id: r.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory] });
                    }
                    // Read-only channels still need an explicit allow for the bot role;
                    // otherwise a non-Administrator bot cannot publish the review feed.
                    for (const r of botWriterRoles) {
                        ow.push({ id: r.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory] });
                    }
                    if (mutedRole) {
                        ow.push({
                            id: mutedRole.id,
                            allow: [discord_js_1.PermissionFlagsBits.ViewChannel],
                            deny: MUTED_TEXT_DENY,
                        });
                    }
                    return ow;
                }
                if (isVoiceCh) {
                    const ow = [
                        {
                            id: everyone.id,
                            allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.Connect, discord_js_1.PermissionFlagsBits.Speak],
                        },
                    ];
                    if (mutedRole) {
                        ow.push({
                            id: mutedRole.id,
                            deny: [discord_js_1.PermissionFlagsBits.Connect, discord_js_1.PermissionFlagsBits.Speak],
                        });
                    }
                    return ow;
                }
                // public chat: inherit — @everyone/Member/Customer/VIP/Media/Bot can all use.
                return [];
            };
            // Managed IDs are authoritative once sync state exists. Name discovery is
            // only used for first-time adoption, so an unrelated same-named channel is
            // never adopted or edited.
            const desiredType = isVoiceCh ? discord_js_1.ChannelType.GuildVoice : discord_js_1.ChannelType.GuildText;
            let existing = prevChannels[ch.key]
                ? guild.channels.cache.get(prevChannels[ch.key])
                : hasManagedState
                    ? undefined
                    : guild.channels.cache.find((c) => 'name' in c && c.name === ch.name);
            if (existing && existing.type !== desiredType)
                existing = undefined;
            if (!existing && ch.key === 'review_submit') {
                const legacyById = prevChannels['reviews'] ? guild.channels.cache.get(prevChannels['reviews']) : undefined;
                const legacyByName = hasManagedState
                    ? undefined
                    : guild.channels.cache.find((c) => 'name' in c && c.name === '⭐・reviews');
                existing = legacyById?.type === desiredType ? legacyById : legacyByName;
            }
            if (existing) {
                channelIds[ch.key] = existing.id;
                if ('name' in existing && existing.name !== ch.name && 'setName' in existing) {
                    await existing.setName(ch.name);
                    markRepaired();
                }
                if ('permissionOverwrites' in existing) {
                    const want = buildOverwrites();
                    const isPublicText = !isSeniorOnly && !isStaffOnly && !isStaffPostOnly && !isReadonly && !isVoiceCh;
                    if (isPublicText) {
                        // Public text should inherit. Muted is handled separately below.
                        const cache = existing.permissionOverwrites.cache;
                        const hasDenyForEveryone = [...cache.values()].some((ow) => {
                            try {
                                return ow.id === everyone.id && ow.deny.bitfield !== 0n;
                            }
                            catch {
                                return false;
                            }
                        });
                        if (hasDenyForEveryone && !overwritesMatch(existing, want)) {
                            await existing.permissionOverwrites.set(want);
                            markRepaired();
                            await throttleWrite();
                        }
                    }
                    else if (!overwritesMatch(existing, want)) {
                        await existing.permissionOverwrites.set(want);
                        markRepaired();
                        await throttleWrite();
                    }
                }
                if ('parentId' in existing && existing.parentId !== category.id && 'setParent' in existing) {
                    await existing.setParent(category.id);
                    markRepaired();
                }
                if (!isVoiceCh && ch.topic !== undefined && 'topic' in existing && existing.topic !== ch.topic && 'setTopic' in existing) {
                    await existing.setTopic(ch.topic);
                    markRepaired();
                }
                continue;
            }
            const overwrites = buildOverwrites();
            let created;
            const isVoice = ch.type === 'voice';
            if (isVoice) {
                created = await guild.channels.create({
                    name: ch.name,
                    type: discord_js_1.ChannelType.GuildVoice,
                    parent: category.id,
                    permissionOverwrites: overwrites,
                    reason: 'BluxBot live sync',
                });
            }
            else {
                created = await guild.channels.create({
                    name: ch.name,
                    type: discord_js_1.ChannelType.GuildText,
                    parent: category.id,
                    topic: ch.topic,
                    permissionOverwrites: overwrites,
                    reason: 'BluxBot live sync',
                });
            }
            channelIds[ch.key] = created.id;
            createdCount++;
            // Small pacing only when we actually created something.
            await throttleWrite();
        }
    }
    // Keep the review submission channel and the review feed separate. This also
    // upgrades older guilds whose only mapping was `reviews`.
    if (channelIds['reviews'] && !channelIds['review_submit']) {
        channelIds['review_submit'] = channelIds['reviews'];
    }
    if (channelIds['review_submit'] && channelIds['review_display'] && channelIds['review_submit'] === channelIds['review_display']) {
        // Keep the old channel as the submission channel; the feed is created
        // below as a new channel instead of silently sharing the picker channel.
        delete channelIds['review_display'];
    }
    if (!reviewParent) {
        const fallbackBlock = structure.find((b) => b.category.includes('CHAT'));
        if (fallbackBlock) {
            reviewParent = guild.channels.cache.find((c) => c.type === discord_js_1.ChannelType.GuildCategory && c.name === fallbackBlock.category);
        }
    }
    const reviewReadonlyOverwrites = () => {
        const overwrites = [
            {
                id: everyone.id,
                allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.ReadMessageHistory],
                deny: [discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.AddReactions],
            },
        ];
        for (const r of staffAllow) {
            overwrites.push({
                id: r.id,
                allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory],
            });
        }
        if (mutedRole) {
            overwrites.push({
                id: mutedRole.id,
                allow: [discord_js_1.PermissionFlagsBits.ViewChannel],
                deny: MUTED_TEXT_DENY,
            });
        }
        // The bot may not have a staff role, but it must be able to publish to the
        // feed even when the feed is read-only for normal members.
        for (const r of botWriterRoles) {
            overwrites.push({
                id: r.id,
                allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory],
            });
        }
        return overwrites;
    };
    const textChannelById = async (id, excluded) => {
        if (!id || excluded.has(id))
            return undefined;
        const candidate = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
        if (!candidate || !candidate.isTextBased() || candidate.isDMBased())
            return undefined;
        return candidate;
    };
    const textChannelByName = (name, excluded) => {
        const candidate = guild.channels.cache.find((c) => {
            if (!('name' in c) || c.name !== name || excluded.has(c.id))
                return false;
            return c.isTextBased() && !c.isDMBased();
        });
        return candidate;
    };
    const ensureReviewChannel = async (key, name, excluded, topic, allowNameFallback) => {
        let channel = await textChannelById(channelIds[key], excluded);
        if (!channel && allowNameFallback)
            channel = textChannelByName(name, excluded);
        if (!channel) {
            const created = await guild.channels.create({
                name,
                type: discord_js_1.ChannelType.GuildText,
                parent: reviewParent?.id,
                topic,
                permissionOverwrites: reviewReadonlyOverwrites(),
                reason: `BluxBot live sync: create ${name}`,
            });
            channel = created;
            createdCount++;
            await throttleWrite();
        }
        else if (reviewParent && 'parentId' in channel && channel.parentId !== reviewParent.id && 'setParent' in channel) {
            await channel.setParent(reviewParent.id).catch(() => { });
            markRepaired();
        }
        channelIds[key] = channel.id;
    };
    const submitExcluded = new Set(Object.entries(channelIds)
        .filter(([key]) => key !== 'review_submit' && key !== 'reviews')
        .map(([, id]) => id));
    await ensureReviewChannel('review_submit', botConfig_1.REVIEW_SUBMIT_CHANNEL_NAME, submitExcluded, 'Pick stars to leave a review', !hasManagedState);
    const displayExcluded = new Set(Object.entries(channelIds)
        .filter(([key]) => key !== 'review_display')
        .map(([, id]) => id));
    await ensureReviewChannel('review_display', botConfig_1.REVIEW_DISPLAY_CHANNEL_NAME, displayExcluded, 'Customer reviews feed', !hasManagedState);
    welcomeChannelId = channelIds['welcome'] ?? '';
    logChannelId = channelIds['modlog'] ?? '';
    console.log(`[sync] channels reconciled: ${Object.keys(channelIds).length}`);
    // 3. Muted restrictions apply only to channels managed by this bot.
    if (mutedRole) {
        for (const channelId of Object.values(channelIds)) {
            const channel = guild.channels.cache.get(channelId);
            if (!channel)
                continue;
            const ow = channel.permissionOverwrites?.cache?.get(mutedRole.id);
            if (channel.type === discord_js_1.ChannelType.GuildVoice) {
                const deny = ow?.deny.bitfield ?? 0n;
                const needConnect = (deny & discord_js_1.PermissionFlagsBits.Connect) === 0n;
                const needSpeak = (deny & discord_js_1.PermissionFlagsBits.Speak) === 0n;
                if (!ow || needConnect || needSpeak) {
                    await channel.permissionOverwrites.edit(mutedRole, {
                        Connect: false,
                        Speak: false,
                    });
                    markRepaired();
                }
            }
            else if (channel.isTextBased() && !channel.isDMBased()) {
                const deny = ow?.deny.bitfield ?? 0n;
                const viewDenied = (deny & discord_js_1.PermissionFlagsBits.ViewChannel) !== 0n;
                if (!viewDenied) {
                    const needSend = (deny & discord_js_1.PermissionFlagsBits.SendMessages) === 0n;
                    const needReact = (deny & discord_js_1.PermissionFlagsBits.AddReactions) === 0n;
                    if (!ow || needSend || needReact) {
                        await channel.permissionOverwrites.edit(mutedRole, {
                            SendMessages: false,
                            AddReactions: false,
                            CreatePublicThreads: false,
                            CreatePrivateThreads: false,
                            SendMessagesInThreads: false,
                        });
                        markRepaired();
                    }
                }
            }
        }
    }
    console.log(`[sync] muted permissions checked`);
    // 4. Upsert panels in place. Messages are never deleted by routine sync.
    const botId = guild.members.me?.id;
    const refresh = async (channelId, data, options = {}) => {
        if (!channelId)
            return;
        const c = guild.channels.cache.get(channelId);
        if (!c || !c.isTextBased())
            return;
        const msgs = await c.messages.fetch({ limit: 10 }).catch(() => null);
        const botMsgs = msgs ? [...msgs.values()].filter((m) => botId && m.author.id === botId) : [];
        const matchingPanel = botMsgs.find((m) => panelMatches(m, data.embeds, data.components));
        if (matchingPanel)
            return;
        if (botMsgs.length > 0 && options.preserveBotMessages) {
            // The review feed also contains bot-authored reviews. Add the panel rather
            // than editing an arbitrary review message.
            await c.send({ embeds: data.embeds, components: data.components });
            markRepaired();
            return;
        }
        if (botMsgs.length > 0) {
            await botMsgs[0].edit({ embeds: data.embeds, components: data.components });
        }
        else {
            await c.send({ embeds: data.embeds, components: data.components });
        }
        markRepaired();
    };
    const panels = tpl.panels;
    const link = (key) => (channelIds[key] ? `<#${channelIds[key]}>` : `#${key}`);
    let rulesDesc = panels.rulesDescription || '';
    if (channelIds['tickets'] && !rulesDesc.includes('<#')) {
        rulesDesc += `\n\nOpen a ticket in ${link('tickets')} for help.`;
    }
    let welcomeDesc = panels.welcomeDescription || '';
    if (!welcomeDesc.includes('<#') && (channelIds['chat'] || channelIds['tickets'] || channelIds['rules'])) {
        const bits = [
            channelIds['chat'] ? `Chat: ${link('chat')}` : '',
            channelIds['tickets'] ? `Help: ${link('tickets')}` : '',
            channelIds['rules'] ? `Rules: ${link('rules')}` : '',
        ].filter(Boolean);
        if (bits.length > 0)
            welcomeDesc += (welcomeDesc ? '\n\n' : '') + bits.join('\n');
    }
    let partnershipDesc = panels.partnershipDescription || '';
    if (channelIds['tickets'] && !partnershipDesc.includes('<#')) {
        partnershipDesc += `\n\n🤝 **Apply now in ${link('tickets')} — open a Partnership ticket.**`;
    }
    await refresh(channelIds['rules'], {
        embeds: [
            new discord_js_1.EmbedBuilder()
                .setTitle(panels.rulesTitle || 'Rules')
                .setColor(0x5865f2)
                .setDescription(rulesDesc.slice(0, 4000) || 'No rules configured.')
                .setFooter({ text: 'bluxmart' }),
        ],
    });
    await refresh(channelIds['partnership'], {
        embeds: [
            new discord_js_1.EmbedBuilder()
                .setTitle(panels.partnershipTitle || 'Partnership')
                .setColor(0x5865f2)
                .setDescription(partnershipDesc.slice(0, 4000) || 'No partnership info configured.'),
        ],
    });
    await refresh(channelIds['faq'], {
        embeds: [
            new discord_js_1.EmbedBuilder()
                .setTitle(panels.faqTitle || 'FAQ')
                .setColor(0x3498db)
                .setDescription((panels.faqDescription || '').slice(0, 4000) || 'No FAQ configured.'),
        ],
    });
    await refresh(welcomeChannelId, {
        embeds: [
            new discord_js_1.EmbedBuilder()
                .setTitle(panels.welcomeTitle || 'Welcome')
                .setColor(0x2ecc71)
                .setDescription(welcomeDesc.slice(0, 4000) || 'Welcome!')
                .setThumbnail(guild.iconURL() ?? null),
        ],
    });
    // Reviews split: submit channel hosts the picker, display channel hosts the feed.
    // Legacy channels are preserved; only explicitly managed IDs are repaired.
    const reviewSubmitId = channelIds['review_submit'] ?? channelIds['reviews'];
    const reviewDisplayId = channelIds['review_display'] ?? undefined;
    await refresh(reviewSubmitId, {
        embeds: [
            new discord_js_1.EmbedBuilder()
                .setTitle(panels.reviewsTitle || 'Reviews')
                .setColor(0xf1c40f)
                .setDescription(((panels.reviewsDescription || '').slice(0, 4000) || 'Leave a review!') +
                (reviewDisplayId ? `\n\n✅ Reviews show up in <#${reviewDisplayId}>` : '')),
        ],
        components: [
            new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.StringSelectMenuBuilder()
                .setCustomId('review_stars')
                .setPlaceholder('Choose 1-5 stars...')
                .addOptions({ label: '5 stars — Excellent', value: '5', emoji: '⭐' }, { label: '4 stars — Great', value: '4', emoji: '⭐' }, { label: '3 stars — Okay', value: '3', emoji: '⭐' }, { label: '2 stars — Bad', value: '2', emoji: '⭐' }, { label: '1 star — Terrible', value: '1', emoji: '⭐' })),
        ],
    });
    await refresh(reviewDisplayId, {
        embeds: [
            new discord_js_1.EmbedBuilder()
                .setTitle('🌟 Customer Reviews')
                .setColor(0xf1c40f)
                .setDescription(`Verified reviews from **Customer** buyers appear here.\n\nLeave yours in ${reviewSubmitId ? `<#${reviewSubmitId}>` : 'the review-submit channel'} — pick 1-5 stars.`),
        ],
    }, { preserveBotMessages: true });
    // Ticket panel buttons come from the dashboard template (any count).
    const liveTypes = tpl.ticketTypes.length > 0 ? tpl.ticketTypes : [];
    // Ticket panel: only ticket-type buttons. Close lives inside each open ticket channel,
    // never on the create-ticket panel itself.
    const ticketRows = [];
    let cur = [];
    for (const tt of liveTypes.slice(0, 10)) {
        cur.push(new discord_js_1.ButtonBuilder().setCustomId(tt.id).setLabel(tt.label.slice(0, 80)).setStyle(styleFromName(tt.style)).setEmoji(tt.emoji));
        if (cur.length === 5) {
            ticketRows.push(new discord_js_1.ActionRowBuilder().addComponents(...cur));
            cur = [];
        }
    }
    if (cur.length > 0) {
        ticketRows.push(new discord_js_1.ActionRowBuilder().addComponents(...cur));
        cur = [];
    }
    await refresh(channelIds['tickets'], {
        embeds: [
            new discord_js_1.EmbedBuilder()
                .setTitle(panels.ticketsTitle || 'Support')
                .setColor(0xe67e22)
                .setDescription((panels.ticketsDescription || '').slice(0, 4000) || 'Open a ticket below.'),
        ],
        components: ticketRows.slice(0, 5),
    });
    console.log(`[sync] panels updated`);
    // 5. Persist managed IDs for the next in-place update.
    const state = {
        guildId: guild.id,
        roles: roleIds,
        channels: channelIds,
        categoryIds,
        welcomeChannelId,
        logChannelId,
        ticketCategoryId,
        autoRoleId: memberRole?.id,
        templateRevision: await templateRevision(),
        updatedAt: new Date().toISOString(),
    };
    await (0, store_1.saveGuildSetup)(state);
    const result = {
        guildId: guild.id,
        created: createdCount,
        repaired: repairedCount,
        roles: Object.keys(roleIds).length,
        channels: Object.keys(channelIds).length,
    };
    console.log(`[sync] ${guild.name ?? guild.id}: created=${result.created} repaired=${result.repaired} ` +
        `roles=${result.roles} channels=${result.channels}`);
    return result;
}
const guildQueues = new Map();
async function refreshWithTimeout(promise, label, timeoutMs = 8000) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    console.warn(`[sync] ${label} timed out after ${timeoutMs}ms; using cached state`);
                    resolve(null);
                }, timeoutMs);
            }),
        ]);
    }
    catch (error) {
        console.warn(`[sync] ${label} failed:`, error instanceof Error ? error.message : error);
        return null;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/** Serialize sync work per guild so boot, watcher, and self-heal cannot race. */
function queueGuildSync(guild, reason = 'scheduled') {
    const previous = guildQueues.get(guild.id) ?? Promise.resolve({ guildId: guild.id, created: 0, repaired: 0, roles: 0, channels: 0 });
    const run = previous
        .catch(() => ({ guildId: guild.id, created: 0, repaired: 0, roles: 0, channels: 0 }))
        .then(async () => {
        console.log(`[sync] queued for ${guild.name ?? guild.id} (${reason})`);
        if (guild.roles.cache.size === 0) {
            await refreshWithTimeout(guild.roles.fetch(), `role refresh for ${guild.id}`);
        }
        if (guild.channels.cache.size === 0) {
            await refreshWithTimeout(guild.channels.fetch(), `channel refresh for ${guild.id}`);
        }
        if (!guild.members.me) {
            await refreshWithTimeout(guild.members.fetchMe(), `member refresh for ${guild.id}`);
        }
        if (reason === 'startup') {
            try {
                const prevSetup = await (0, store_1.getGuildSetup)(guild.id).catch(() => null);
                if (prevSetup && prevSetup.roles && prevSetup.channels) {
                    const tpl = await (0, botConfig_1.getTemplate)().catch(() => null);
                    const currentRev = await templateRevision();
                    const roleDefs = (tpl?.roles && tpl.roles.length > 0) ? tpl.roles : exports.ROLE_ORDER_TOP_FIRST.map((n) => ({ name: n }));
                    const structure = (tpl?.structure && tpl.structure.length > 0) ? tpl.structure : [];
                    
                    const rolesOk = roleDefs.every((r) => {
                        const rid = prevSetup.roles[r.name];
                        return rid && guild.roles.cache.has(rid);
                    });
                    const channelsOk = structure.every((b) => (b.channels || []).every((ch) => {
                        const cid = prevSetup.channels[ch.key];
                        return cid && guild.channels.cache.has(cid);
                    }));

                    if (rolesOk && channelsOk) {
                        if (prevSetup.templateRevision !== currentRev) {
                            prevSetup.templateRevision = currentRev;
                            await (0, store_1.saveGuildSetup)(prevSetup).catch(() => {});
                        }
                        console.log(`[sync] ${guild.name ?? guild.id}: up-to-date (no changes detected, skipping startup sync)`);
                        return {
                            guildId: guild.id,
                            created: 0,
                            repaired: 0,
                            roles: Object.keys(prevSetup.roles).length,
                            channels: Object.keys(prevSetup.channels).length,
                        };
                    }
                }
            } catch (err) {
                console.warn('[sync] startup check warning:', err?.message || err);
            }
        }
        console.log(`[sync] reconciling ${guild.name ?? guild.id}`);
        const result = await refreshWithTimeout(syncGuild(guild), `reconciliation for ${guild.id}`, 60000);
        if (!result)
            throw new Error(`reconciliation for ${guild.id} timed out`);
        return result;
    });
    guildQueues.set(guild.id, run);
    const clean = () => {
        if (guildQueues.get(guild.id) === run)
            guildQueues.delete(guild.id);
    };
    run.then(clean, clean);
    return run;
}
/** If an allowlist is configured, only those servers are managed. */
async function syncAllGuilds(client, reason) {
    if (!client.isReady())
        return { applied: [], failed: [] };
    let guilds = [...client.guilds.cache.values()];
    const allowedGuildIds = config_1.config.allowedGuildIds?.length
        ? config_1.config.allowedGuildIds
        : config_1.config.guildId
            ? [config_1.config.guildId]
            : [];
    if (allowedGuildIds.length > 0) {
        guilds = (await Promise.all(allowedGuildIds.map(async (id) => client.guilds.cache.get(id) ?? await client.guilds.fetch(id).catch(() => null)))).filter((guild) => guild !== null);
    }
    const applied = [];
    const failed = [];
    for (const guild of guilds) {
        try {
            applied.push(await queueGuildSync(guild, reason));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failed.push({ guildId: guild.id, error: message });
            console.error(`[sync] failed for ${guild.id}:`, message);
        }
    }
    return { applied, failed };
}
const DATA_DIR = path_1.default.join(process.cwd(), 'data');
const TEMPLATE_FILE = path_1.default.join(DATA_DIR, 'bot-config.json');
let templateQueue = Promise.resolve();
let lastTemplateSync;
async function templateRevision() {
    try {
        const raw = await (0, promises_1.readFile)(TEMPLATE_FILE, 'utf-8');
        return (0, crypto_1.createHash)('sha256').update(raw).digest('hex');
    }
    catch {
        return 'built-in-defaults';
    }
}
/**
 * Apply a saved template immediately. Calls for the same file revision are
 * deduplicated, while a newer edit is always queued after the current sync.
 */
function requestTemplateSync(client, reason) {
    const run = templateQueue
        .catch(() => undefined)
        .then(async () => {
        const revision = await templateRevision();
        if (lastTemplateSync?.revision === revision)
            return lastTemplateSync.result;
        if (!client.isReady())
            return { revision, queued: true, applied: [], failed: [] };
        const result = await syncAllGuilds(client, reason);
        const full = { revision, queued: false, ...result };
        if (full.failed.length === 0) {
            lastTemplateSync = { revision, result: full };
        }
        console.log(`[sync] template ${revision.slice(0, 8)} applied to ${full.applied.length} server(s)`);
        return full;
    });
    templateQueue = run.catch(() => undefined);
    return run;
}
let templateWatcher;
let templateDebounce;
/** Watch dashboard/external template edits and reconcile without a process restart. */
function watchTemplateChanges(client) {
    if (templateWatcher)
        return;
    (0, fs_1.mkdirSync)(DATA_DIR, { recursive: true });
    templateWatcher = (0, fs_1.watch)(DATA_DIR, (_event, filename) => {
        if (filename && path_1.default.basename(filename.toString()) !== path_1.default.basename(TEMPLATE_FILE))
            return;
        if (templateDebounce)
            clearTimeout(templateDebounce);
        templateDebounce = setTimeout(() => {
            requestTemplateSync(client, 'data/bot-config.json changed').catch((error) => {
                console.error('[sync] template watcher failed:', error instanceof Error ? error.message : error);
            });
        }, 350);
    });
    templateWatcher.on('error', (error) => console.error('[sync] template watcher error:', error.message));
    console.log('[sync] live template watcher enabled');
}
