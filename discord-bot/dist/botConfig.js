"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TEMPLATE = exports.REVIEW_DISPLAY_CHANNEL_NAME = exports.REVIEW_SUBMIT_CHANNEL_NAME = void 0;
exports.getTemplate = getTemplate;
exports.validateTemplate = validateTemplate;
exports.saveTemplate = saveTemplate;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
// Keep the legacy/default review channel names in one place so routing and
// self-healing never accidentally treat the submission channel as the feed.
exports.REVIEW_SUBMIT_CHANNEL_NAME = '⭐・leave-a-review';
exports.REVIEW_DISPLAY_CHANNEL_NAME = '🌟・reviews';
const DATA_DIR = path_1.default.join(process.cwd(), 'data');
const TEMPLATE_FILE = path_1.default.join(DATA_DIR, 'bot-config.json');
exports.DEFAULT_TEMPLATE = {
    // Canonical hierarchy, top -> bottom:
    // Owner > Admin > Manager > Dev > Moderator > Mod > Staff > Support >
    // Bot > Media > VIP > Customer > Member > Muted (@everyone is below Muted).
    // Every role has a DISTINCT color so the member list is readable.
    roles: [
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
    ],
    ticketTypes: [
        { id: 'ticket_bug', label: 'Bug Report', emoji: '🐛', style: 'Danger' },
        { id: 'ticket_claim', label: 'Item Claim', emoji: '📦', style: 'Success' },
        { id: 'ticket_general', label: 'General Issue', emoji: '❓', style: 'Primary' },
        { id: 'ticket_staff', label: 'Staff Report', emoji: '🚨', style: 'Secondary' },
        { id: 'ticket_partner', label: 'Partnership', emoji: '🤝', style: 'Secondary' },
    ],
    structure: [
        {
            category: '📌 INFO',
            channels: [
                { key: 'welcome', name: '👋・welcome', type: 'text', topic: 'Welcome to Bluxmart!' },
                { key: 'rules', name: '📜・rules', type: 'text', topic: 'Bluxmart rules - read first' },
                { key: 'partnership', name: '🤝・partnership', type: 'text', topic: 'Bluxmart Sponsorship Agreement' },
                { key: 'announcements', name: '📢・announcements', type: 'text', topic: 'Store updates & restocks' },
                { key: 'faq', name: '❓・faq', type: 'text', topic: 'Frequently asked questions' },
            ],
        },
        {
            category: '💬 CHAT',
            channels: [
                { key: 'chat', name: '💬・general-chat', type: 'text', topic: 'General discussion' },
                { key: 'review_submit', name: exports.REVIEW_SUBMIT_CHANNEL_NAME, type: 'text', topic: 'Pick stars to leave a review' },
                { key: 'review_display', name: exports.REVIEW_DISPLAY_CHANNEL_NAME, type: 'text', topic: 'Customer reviews feed' },
                { key: 'giveaways', name: '🎁・giveaways', type: 'text', topic: 'Giveaways & drops' },
                { key: 'bot', name: '🤖・bot-commands', type: 'text', topic: 'Bot commands' },
            ],
        },
        {
            category: '🔊 VOICE',
            channels: [
                { key: 'lounge', name: '☕ Lounge', type: 'voice' },
                { key: 'support1', name: '🎧 Support 1', type: 'voice' },
                { key: 'support2', name: '🎧 Support 2', type: 'voice' },
            ],
        },
        {
            category: '🎫 TICKETS',
            channels: [
                { key: 'tickets', name: '🎫・create-ticket', type: 'text', topic: 'Pick a ticket type below' },
                { key: 'ticketlogs', name: '📝・ticket-logs', type: 'text', topic: 'Ticket transcripts / logs' },
            ],
        },
        {
            category: '🛡️ STAFF',
            channels: [
                { key: 'modlog', name: '📝・mod-logs', type: 'text', topic: 'Moderation + bot logs' },
                { key: 'staff', name: '🛡️・staff-chat', type: 'text', topic: 'Staff only' },
                { key: 'stock', name: '📦・stock', type: 'text', topic: 'Stock management (staff)' },
            ],
        },
    ],
    ticketPrompts: {
        bug: 'Describe the bug + attach screenshots + order ID if purchase-related.',
        claim: 'Send your **order ID + username + proof of payment**. Staff will deliver here.',
        general: 'Describe your issue (payment, delivery, site).',
        staff: 'Staff report is **private to Admins**. Provide user, proof, what happened.',
        partner: 'Tell us about your server/store, members, what partnership you want.',
    },
    panels: {
        rulesTitle: '📜 Bluxmart — Rules',
        rulesDescription: '1. Be respectful — no spam or scams.\n2. All deals in tickets only — staff never DM first.\n3. No leaking = ban + blacklist.\n4. Item Claim requires proof (order ID / screenshot).\n5. Follow Discord ToS.',
        faqTitle: '❓ Bluxmart FAQ',
        faqDescription: "**How to buy?** Open 📦 Item Claim / ❓ General ticket.\n**Didn't receive item?** Open 🐛 Bug Report with order ID.\n**Report staff?** Open 🚨 Staff Report (only admins see).\n**Partner?** Open 🤝 Partnership.",
        welcomeTitle: 'Welcome to Bluxmart! 🛒',
        welcomeDescription: 'Thanks for joining. Read the rules, chat with the community, and open a ticket if you need help.',
        reviewsTitle: '⭐ Bluxmart Reviews',
        reviewsDescription: 'Bought something? Leave a review!\n\n**Only Customer rank can review.**\nPick 1-5 stars below, then tell us why — what do you think about Bluxmart?',
        ticketsTitle: '🎫 Bluxmart Support',
        ticketsDescription: 'Pick a ticket type:\n🐛 **Bug Report** — broken item / site bug\n📦 **Item Claim** — claim purchase (send order ID)\n❓ **General Issue** — questions, payments\n🚨 **Staff Report** — report staff (private)\n🤝 **Partnership** — work with bluxmart',
        partnershipTitle: '🤝 Bluxmart Sponsorship Agreement',
        partnershipDescription: 'This agreement is between Bluxmart and the Creator.\n\n📌 **Sponsorship Requirements**\nCreator agrees to post a minimum of 2 sponsored videos per week on TikTok and/or YouTube Shorts 📱🎬.\n\nAll sponsored content must be related to DonutSMP 🍩⛏️.\n\n🎟️ Sponsor will provide the Creator with a unique promo code that gives customers 10% off.\n\n💰 **Payment**\n💵 Creator will be paid $1.00 per 1,000 views (48h views, weekly cap applies).\n\n🗓️ Payments are calculated and paid weekly.',
    },
};
async function getTemplate() {
    try {
        const raw = await fs_1.promises.readFile(TEMPLATE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            roles: Array.isArray(parsed.roles) && parsed.roles.length > 0 ? parsed.roles : exports.DEFAULT_TEMPLATE.roles,
            ticketTypes: Array.isArray(parsed.ticketTypes) && parsed.ticketTypes.length > 0
                ? parsed.ticketTypes
                : exports.DEFAULT_TEMPLATE.ticketTypes,
            structure: Array.isArray(parsed.structure) && parsed.structure.length > 0
                ? parsed.structure
                : exports.DEFAULT_TEMPLATE.structure,
            ticketPrompts: parsed.ticketPrompts ?? exports.DEFAULT_TEMPLATE.ticketPrompts,
            panels: { ...exports.DEFAULT_TEMPLATE.panels, ...(parsed.panels ?? {}) },
        };
    }
    catch {
        return exports.DEFAULT_TEMPLATE;
    }
}
function validateTemplate(t) {
    if (typeof t !== 'object' || t === null)
        return { ok: false, error: 'Template must be an object.' };
    const o = t;
    if (!Array.isArray(o.roles) || o.roles.length === 0 || o.roles.length > 50)
        return { ok: false, error: 'roles must be a list of 1-50 entries.' };
    for (const r of o.roles) {
        if (typeof r.name !== 'string' || r.name.trim().length === 0 || r.name.length > 32)
            return { ok: false, error: 'Each role needs a name (1-32 chars).' };
        if (typeof r.color !== 'number' || r.color < 0 || r.color > 0xffffff)
            return { ok: false, error: `Role "${r.name}": color must be 0-16777215.` };
        if (!Array.isArray(r.perms) || r.perms.some((p) => typeof p !== 'string'))
            return { ok: false, error: `Role "${r.name}": perms must be string list.` };
    }
    if (!Array.isArray(o.ticketTypes) || o.ticketTypes.length === 0 || o.ticketTypes.length > 10)
        return { ok: false, error: 'ticketTypes must be 1-10 entries.' };
    for (const tt of o.ticketTypes) {
        if (typeof tt.id !== 'string' || !/^ticket_[a-z0-9_]{1,30}$/.test(tt.id))
            return { ok: false, error: 'Each ticket type id must look like ticket_name.' };
        if (typeof tt.label !== 'string' || tt.label.length === 0 || tt.label.length > 40)
            return { ok: false, error: 'Each ticket type needs a label (1-40 chars).' };
        if (typeof tt.emoji !== 'string' || tt.emoji.length === 0 || tt.emoji.length > 16)
            return { ok: false, error: `Ticket "${tt.id}": emoji required.` };
        if (!['Primary', 'Secondary', 'Success', 'Danger'].includes(tt.style))
            return { ok: false, error: `Ticket "${tt.id}": invalid style.` };
    }
    if (!Array.isArray(o.structure) || o.structure.length === 0 || o.structure.length > 12)
        return { ok: false, error: 'structure must be 1-12 categories.' };
    const keys = new Set();
    for (const b of o.structure) {
        if (typeof b.category !== 'string' || b.category.length === 0 || b.category.length > 60)
            return { ok: false, error: 'Each category needs a name (1-60 chars).' };
        if (!Array.isArray(b.channels) || b.channels.length === 0 || b.channels.length > 25)
            return { ok: false, error: `Category "${b.category}": 1-25 channels.` };
        for (const c of b.channels) {
            if (typeof c.key !== 'string' || !/^[a-z0-9_]{1,30}$/.test(c.key))
                return { ok: false, error: 'Each channel needs a key (a-z, 0-9, _).' };
            if (keys.has(c.key))
                return { ok: false, error: `Duplicate channel key: ${c.key}.` };
            keys.add(c.key);
            if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 60)
                return { ok: false, error: `Channel "${c.key}": name 1-60 chars.` };
            if (c.type !== 'text' && c.type !== 'voice')
                return { ok: false, error: `Channel "${c.key}": type must be text or voice.` };
            if (c.topic !== undefined && (typeof c.topic !== 'string' || c.topic.length > 200))
                return { ok: false, error: `Channel "${c.key}": topic max 200 chars.` };
        }
    }
    if (typeof o.ticketPrompts !== 'object' || o.ticketPrompts === null)
        return { ok: false, error: 'ticketPrompts must be an object.' };
    if (typeof o.panels !== 'object' || o.panels === null)
        return { ok: false, error: 'panels must be an object.' };
    return { ok: true };
}
async function saveTemplate(t) {
    await fs_1.promises.mkdir(DATA_DIR, { recursive: true });
    await fs_1.promises.writeFile(TEMPLATE_FILE, JSON.stringify(t, null, 2), 'utf-8');
}
