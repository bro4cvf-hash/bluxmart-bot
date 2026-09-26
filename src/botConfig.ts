import { promises as fs } from 'fs';
import path from 'path';

export interface BotRoleDef {
  name: string;
  color: number;
  perms: string[];
}

// Keep the legacy/default review channel names in one place so routing and
// self-healing never accidentally treat the submission channel as the feed.
export const REVIEW_SUBMIT_CHANNEL_NAME = '⭐・leave-a-review';
export const REVIEW_DISPLAY_CHANNEL_NAME = '🌟・reviews';

export interface TicketTypeDef {
  id: string;
  label: string;
  emoji: string;
  style: 'Primary' | 'Secondary' | 'Success' | 'Danger';
}

export interface ChannelDef {
  key: string;
  name: string;
  type: 'text' | 'voice';
  topic?: string;
}

export interface CategoryBlock {
  category: string;
  channels: ChannelDef[];
}

export interface BotTemplate {
  roles: BotRoleDef[];
  ticketTypes: TicketTypeDef[];
  structure: CategoryBlock[];
  ticketPrompts: Record<string, string>;
  panels: {
    rulesTitle: string;
    rulesDescription: string;
    faqTitle: string;
    faqDescription: string;
    welcomeTitle: string;
    welcomeDescription: string;
    reviewsTitle: string;
    reviewsDescription: string;
    ticketsTitle: string;
    ticketsDescription: string;
    partnershipTitle: string;
    partnershipDescription: string;
    inviteRewardTitle?: string;
    inviteRewardDescription?: string;
    websiteTitle?: string;
    websiteDescription?: string;
  };
}

const DATA_DIR = path.join(process.cwd(), 'data');
const TEMPLATE_FILE = path.join(DATA_DIR, 'bot-config.json');

export const DEFAULT_TEMPLATE: BotTemplate = {
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
        { key: 'welcome', name: '👋・welcome', type: 'text', topic: 'Welcome to Bluxmart! Live Invite Tracker & New Members' },
        { key: 'invite_reward', name: '🎁・invite-reward', type: 'text', topic: '💰 3M Per Invite — Minimum 5 Invites to Claim! 🔥' },
        { key: 'rules', name: '📜・rules', type: 'text', topic: 'Bluxmart rules - read first' },
        { key: 'partnership', name: '🤝・partnership', type: 'text', topic: 'Bluxmart Sponsorship Agreement' },
        { key: 'announcements', name: '📢・announcements', type: 'text', topic: 'Store updates & restocks' },
        { key: 'faq', name: '❓・faq', type: 'text', topic: 'Frequently asked questions' },
      ],
    },
    {
      category: '🛒 SHOP',
      channels: [
        { key: 'website', name: '🌐・website', type: 'text', topic: 'Official Bluxmart Website — https://bluxmart.com/' },
      ],
    },
    {
      category: '💬 CHAT',
      channels: [
        { key: 'chat', name: '💬・general-chat', type: 'text', topic: 'General discussion' },
        { key: 'review_submit', name: REVIEW_SUBMIT_CHANNEL_NAME, type: 'text', topic: 'Pick stars to leave a review' },
        { key: 'review_display', name: REVIEW_DISPLAY_CHANNEL_NAME, type: 'text', topic: 'Customer reviews feed' },
        { key: 'giveaways', name: '🎁・giveaways', type: 'text', topic: 'Giveaways & drops' },
        { key: 'bot', name: '🤖・bot-commands', type: 'text', topic: 'Bot commands' },
        { key: 'media', name: '🎬・media', type: 'text', topic: 'DonutSMP videos & clips' },
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
    claim: 'Send your **order ID + username + proof of payment** (or your **Invite Reward claim + Minecraft IGN** if claiming 5+ invites). Staff will deliver here.',
    general: 'Describe your issue (payment, delivery, site).',
    staff: 'Staff report is **private to Admins**. Provide user, proof, what happened.',
    partner: 'Tell us about your server/store, members, what partnership you want.',
  },
  panels: {
    rulesTitle: '📜 Bluxmart — Rules',
    rulesDescription:
      '1. Be respectful — no spam or scams.\n2. All deals in tickets only — staff never DM first.\n3. No leaking = ban + blacklist.\n4. Item Claim requires proof (order ID / screenshot).\n5. Follow Discord ToS.',
    faqTitle: '❓ Bluxmart FAQ',
    faqDescription:
      "**How to buy?** Visit https://bluxmart.com/ or open 📦 Item Claim / ❓ General ticket.\n**Didn't receive item?** Open 🐛 Bug Report with order ID.\n**How do Invite Rewards work?** Earn 💰 **3M per invite** (minimum 5 invites to claim) — check 🎁・invite-reward!\n**Report staff?** Open 🚨 Staff Report (only admins see).\n**Partner?** Open 🤝 Partnership.",
    welcomeTitle: '👋 Welcome to Bluxmart',
    welcomeDescription:
      'Welcome to the official Bluxmart Discord. New member joins and invites are tracked here.',
    reviewsTitle: '⭐ Bluxmart Reviews',
    reviewsDescription:
      'Bought something? Leave a review!\n\n**Only Customer rank can review.**\nPick 1-5 stars below, then tell us why — what do you think about Bluxmart?',
    ticketsTitle: '🎫 Bluxmart Support',
    ticketsDescription:
      'Pick a ticket type:\n🐛 **Bug Report** — broken item / site bug\n📦 **Item Claim** — claim purchase or 5+ Invite Reward (send order ID / IGN)\n❓ **General Issue** — questions, payments\n🚨 **Staff Report** — report staff (private)\n🤝 **Partnership** — work with bluxmart',
    partnershipTitle: '🤝 Bluxmart Sponsorship Agreement',
    partnershipDescription:
      'This agreement is between Bluxmart and the Creator.\n\n📌 **Sponsorship Requirements**\nCreator agrees to post a minimum of 2 sponsored videos per week on TikTok and/or YouTube Shorts 📱🎬.\n\nAll sponsored content must be related to DonutSMP 🍩⛏️.\n\n🎟️ Sponsor will provide the Creator with a unique promo code that gives customers 10% off.\n\n💰 **Payment**\n💵 Creator will be paid $1.00 per 1,000 views (48h views, weekly cap applies).\n\n🗓️ Payments are calculated and paid weekly.',
    inviteRewardTitle: '🎁 Invite Rewards',
    inviteRewardDescription:
      '💰 **3M per invite** — Minimum **5 invites** to claim (**15M**)\n\n• **1 Invite** = 3M\n• **5 Invites** = 15M *(Minimum to claim)*\n• **10 Invites** = 30M\n\n⚠️ **Requirements**\n• Invited account must be at least **2 months old**\n• Invited member must stay in the server for at least **2 hours**\n• Fake / alt accounts or members who leave do **not** count',
    websiteTitle: '🌐 Bluxmart Official Store',
    websiteDescription:
      'Shop DonutSMP coins, spawners, elytras, and items with 24/7 instant delivery.\n\n🔗 https://bluxmart.com/',
  },
};

function ensureStructureChannels(structure: CategoryBlock[]): CategoryBlock[] {
  const copy = structure.map((b) => ({
    category: b.category,
    channels: [...b.channels],
  }));
  const allKeys = new Set(copy.flatMap((b) => b.channels.map((c) => c.key)));

  if (!allKeys.has('invite_reward')) {
    const infoBlock = copy.find((b) => b.category.toUpperCase().includes('INFO')) ?? copy[0];
    if (infoBlock) {
      const welcomeIdx = infoBlock.channels.findIndex((c) => c.key === 'welcome');
      const item: ChannelDef = {
        key: 'invite_reward',
        name: '🎁・invite-reward',
        type: 'text',
        topic: '💰 3M Per Invite — Minimum 5 Invites to Claim! 🔥',
      };
      if (welcomeIdx >= 0) {
        infoBlock.channels.splice(welcomeIdx + 1, 0, item);
      } else {
        infoBlock.channels.unshift(item);
      }
    }
  }

  if (!allKeys.has('website')) {
    let shopBlock = copy.find((b) => b.category.toUpperCase().includes('SHOP'));
    const websiteCh: ChannelDef = {
      key: 'website',
      name: '🌐・website',
      type: 'text',
      topic: 'Official Bluxmart Website — https://bluxmart.com/',
    };
    if (shopBlock) {
      shopBlock.channels.unshift(websiteCh);
    } else {
      const infoIdx = copy.findIndex((b) => b.category.toUpperCase().includes('INFO'));
      const newBlock: CategoryBlock = {
        category: '🛒 SHOP',
        channels: [websiteCh],
      };
      if (infoIdx >= 0) {
        copy.splice(infoIdx + 1, 0, newBlock);
      } else {
        copy.unshift(newBlock);
      }
    }
  }

  return copy;
}

export async function getTemplate(): Promise<BotTemplate> {
  try {
    const raw = await fs.readFile(TEMPLATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BotTemplate>;
    const baseStructure =
      Array.isArray(parsed.structure) && parsed.structure.length > 0
        ? parsed.structure
        : DEFAULT_TEMPLATE.structure;
    return {
      roles: Array.isArray(parsed.roles) && parsed.roles.length > 0 ? parsed.roles : DEFAULT_TEMPLATE.roles,
      ticketTypes:
        Array.isArray(parsed.ticketTypes) && parsed.ticketTypes.length > 0
          ? parsed.ticketTypes
          : DEFAULT_TEMPLATE.ticketTypes,
      structure: ensureStructureChannels(baseStructure),
      ticketPrompts: { ...DEFAULT_TEMPLATE.ticketPrompts, ...(parsed.ticketPrompts ?? {}) },
      panels: { ...DEFAULT_TEMPLATE.panels, ...(parsed.panels ?? {}) },
    };
  } catch {
    return DEFAULT_TEMPLATE;
  }
}

export function validateTemplate(t: unknown): { ok: boolean; error?: string } {
  if (typeof t !== 'object' || t === null) return { ok: false, error: 'Template must be an object.' };
  const o = t as Record<string, unknown>;
  if (!Array.isArray(o.roles) || o.roles.length === 0 || o.roles.length > 50)
    return { ok: false, error: 'roles must be a list of 1-50 entries.' };
  for (const r of o.roles as Record<string, unknown>[]) {
    if (typeof r.name !== 'string' || r.name.trim().length === 0 || r.name.length > 32)
      return { ok: false, error: 'Each role needs a name (1-32 chars).' };
    if (typeof r.color !== 'number' || r.color < 0 || r.color > 0xffffff)
      return { ok: false, error: `Role "${r.name}": color must be 0-16777215.` };
    if (!Array.isArray(r.perms) || (r.perms as unknown[]).some((p) => typeof p !== 'string'))
      return { ok: false, error: `Role "${r.name}": perms must be string list.` };
  }
  if (!Array.isArray(o.ticketTypes) || (o.ticketTypes as unknown[]).length === 0 || (o.ticketTypes as unknown[]).length > 10)
    return { ok: false, error: 'ticketTypes must be 1-10 entries.' };
  for (const tt of o.ticketTypes as Record<string, unknown>[]) {
    if (typeof tt.id !== 'string' || !/^ticket_[a-z0-9_]{1,30}$/.test(tt.id))
      return { ok: false, error: 'Each ticket type id must look like ticket_name.' };
    if (typeof tt.label !== 'string' || tt.label.length === 0 || tt.label.length > 40)
      return { ok: false, error: 'Each ticket type needs a label (1-40 chars).' };
    if (typeof tt.emoji !== 'string' || tt.emoji.length === 0 || tt.emoji.length > 16)
      return { ok: false, error: `Ticket "${tt.id}": emoji required.` };
    if (!['Primary', 'Secondary', 'Success', 'Danger'].includes(tt.style as string))
      return { ok: false, error: `Ticket "${tt.id}": invalid style.` };
  }
  if (!Array.isArray(o.structure) || (o.structure as unknown[]).length === 0 || (o.structure as unknown[]).length > 12)
    return { ok: false, error: 'structure must be 1-12 categories.' };
  const keys = new Set<string>();
  for (const b of o.structure as Record<string, unknown>[]) {
    if (typeof b.category !== 'string' || b.category.length === 0 || b.category.length > 60)
      return { ok: false, error: 'Each category needs a name (1-60 chars).' };
    if (!Array.isArray(b.channels) || (b.channels as unknown[]).length === 0 || (b.channels as unknown[]).length > 25)
      return { ok: false, error: `Category "${b.category}": 1-25 channels.` };
    for (const c of b.channels as Record<string, unknown>[]) {
      if (typeof c.key !== 'string' || !/^[a-z0-9_]{1,30}$/.test(c.key))
        return { ok: false, error: 'Each channel needs a key (a-z, 0-9, _).' };
      if (keys.has(c.key)) return { ok: false, error: `Duplicate channel key: ${c.key}.` };
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

export async function saveTemplate(t: BotTemplate): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TEMPLATE_FILE, JSON.stringify(t, null, 2), 'utf-8');
}
