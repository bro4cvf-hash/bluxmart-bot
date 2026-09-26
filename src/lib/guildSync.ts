import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CategoryChannel,
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  OverwriteResolvable,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextChannel,
} from 'discord.js';
import { watch, mkdirSync, type FSWatcher } from 'fs';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { config } from '../config';
import { saveGuildSetup, getGuildSetup, GuildSetup } from '../store';
import {
  getTemplate,
  REVIEW_DISPLAY_CHANNEL_NAME,
  REVIEW_SUBMIT_CHANNEL_NAME,
  type BotTemplate,
} from '../botConfig';

// Permission name (dashboard-editable) -> discord.js bit
const PERM_MAP: Record<string, bigint> = {
  Administrator: PermissionFlagsBits.Administrator,
  ManageGuild: PermissionFlagsBits.ManageGuild,
  ManageRoles: PermissionFlagsBits.ManageRoles,
  ManageChannels: PermissionFlagsBits.ManageChannels,
  ManageMessages: PermissionFlagsBits.ManageMessages,
  KickMembers: PermissionFlagsBits.KickMembers,
  BanMembers: PermissionFlagsBits.BanMembers,
  ModerateMembers: PermissionFlagsBits.ModerateMembers,
  ManageNicknames: PermissionFlagsBits.ManageNicknames,
  ViewAuditLog: PermissionFlagsBits.ViewAuditLog,
  ViewChannel: PermissionFlagsBits.ViewChannel,
  SendMessages: PermissionFlagsBits.SendMessages,
  ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
  Connect: PermissionFlagsBits.Connect,
  Speak: PermissionFlagsBits.Speak,
};

// Canonical role hierarchy, top -> bottom. Single source of truth for
// ordering, sidebar display (hoist) and channel access tiers.
export const ROLE_ORDER_TOP_FIRST = [
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
] as const;

// Hoisted (separate sidebar groups). Muted is NEVER hoisted.
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

function permsToBits(names: string[]): bigint[] {
  return names.map((n) => PERM_MAP[n]).filter((b): b is bigint => typeof b === 'bigint');
}

// --- Incremental sync helpers: only touch Discord when drift is detected ---
// This keeps re-runs / boot auto-sync fast and avoids hammering rate limits.

function resolveBits(list: unknown): bigint {
  if (list == null) return 0n;
  const arr = Array.isArray(list) ? list : [list];
  let bits = 0n;
  for (const b of arr as unknown[]) {
    try {
      bits |= typeof b === 'bigint' ? b : BigInt(b as number);
    } catch {}
  }
  return bits;
}

type DesiredOverwrite = { id: string; allow?: unknown; deny?: unknown };

function overwritesMatch(
  channel: any,
  desired: DesiredOverwrite[]
): boolean {
  try {
    const cache = channel.permissionOverwrites.cache as Map<
      string,
      { allow: { bitfield: bigint }; deny: { bitfield: bigint } }
    >;
    if (cache.size !== desired.length) return false;
    for (const d of desired) {
      const cur = cache.get(d.id);
      if (!cur) return false;
      if (cur.allow.bitfield !== resolveBits(d.allow)) return false;
      if (cur.deny.bitfield !== resolveBits(d.deny)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function rolePermsMatch(existing: { permissions: { bitfield: bigint } }, want: bigint[]): boolean {
  let wantBits = 0n;
  for (const b of want) wantBits |= b;
  try {
    return existing.permissions.bitfield === wantBits;
  } catch {
    return false;
  }
}

function componentsSignature(components: any[] | undefined): string {
  try {
    if (!components || components.length === 0) return 'none';
    const norm = components.map((row: any) => {
      const j = typeof row?.toJSON === 'function' ? row.toJSON() : row;
      const comps = (j?.components ?? []).map((c: any) => ({
        id: c.custom_id ?? c.customId ?? '',
        opts: (c.options ?? []).map((o: any) => o.value ?? o.label ?? '').join(','),
        label: c.label ?? '',
      }));
      return JSON.stringify(comps);
    });
    return norm.join('|');
  } catch {
    return 'unknown';
  }
}

function existingComponentsSignature(msg: any): string {
  try {
    const comps = (msg.components ?? []).map((row: any) => {
      const inner = (row.components ?? []).map((c: any) => ({
        id: c.customId ?? '',
        opts: (c.options ?? []).map((o: any) => o.value ?? '').join(','),
        label: c.label ?? '',
      }));
      return JSON.stringify(inner);
    });
    return comps.length > 0 ? comps.join('|') : 'none';
  } catch {
    return 'unknown';
  }
}

function panelMatches(msg: any, embeds: EmbedBuilder[], components?: any[], content?: string): boolean {
  try {
    if (content !== undefined && (msg.content ?? '') !== content) return false;
    const e = (msg.embeds ?? [])[0];
    if (!e) return false;
    const want = embeds[0]?.toJSON() as any;
    if (!want) return false;
    if ((e.title ?? '') !== (want.title ?? '')) return false;
    if ((e.description ?? '') !== (want.description ?? '')) return false;
    return existingComponentsSignature(msg) === componentsSignature(components);
  } catch {
    return false;
  }
}

function styleFromName(s: string): ButtonStyle {
  switch (s) {
    case 'Primary':
      return ButtonStyle.Primary;
    case 'Secondary':
      return ButtonStyle.Secondary;
    case 'Success':
      return ButtonStyle.Success;
    case 'Danger':
    default:
      return ButtonStyle.Danger;
  }
}

// Dashboard-editable template (data/bot-config.json) with built-in fallback.
// Kept as static fallback so the bot still works if the config file is missing.
// Colors are all DISTINCT; hierarchy is Owner > Admin > Manager > Dev >
// Moderator > Mod > Staff > Support > Bot > Media > VIP > Customer > Member > Muted.
const FALLBACK_ROLES = [
  { name: 'Owner', color: 0x93c5fd as const, perms: ['Administrator'] },
  { name: 'Admin', color: 0xff6b6b as const, perms: ['Administrator'] },
  { name: 'Manager', color: 0x991b1b as const, perms: ['ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog', 'ManageNicknames'] },
  { name: 'Dev', color: 0x2ecc71 as const, perms: ['ManageChannels', 'ManageMessages', 'ViewAuditLog'] },
  { name: 'Moderator', color: 0xe67e22 as const, perms: ['ManageMessages', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageNicknames', 'ViewAuditLog'] },
  { name: 'Mod', color: 0x8b5cf6 as const, perms: ['ManageMessages', 'KickMembers', 'ModerateMembers', 'ManageNicknames'] },
  { name: 'Staff', color: 0x14b8a6 as const, perms: ['ManageMessages', 'ModerateMembers'] },
  { name: 'Support', color: 0x38bdf8 as const, perms: ['ManageMessages'] },
  { name: 'Bot', color: 0x5865f2 as const, perms: [] },
  { name: 'Media', color: 0xec4899 as const, perms: [] },
  { name: 'VIP', color: 0xf1c40f as const, perms: [] },
  { name: 'Customer', color: 0x1e40af as const, perms: [] },
  { name: 'Member', color: 0xb8c0cc as const, perms: [] },
  { name: 'Muted', color: 0x4b5563 as const, perms: [] },
];

export const TICKET_TYPES = [
  { id: 'ticket_bug', label: 'Bug Report', emoji: '🐛', style: ButtonStyle.Danger as const },
  { id: 'ticket_claim', label: 'Item Claim', emoji: '📦', style: ButtonStyle.Success as const },
  { id: 'ticket_general', label: 'General Issue', emoji: '❓', style: ButtonStyle.Primary as const },
  { id: 'ticket_staff', label: 'Staff Report', emoji: '🚨', style: ButtonStyle.Secondary as const },
  { id: 'ticket_partner', label: 'Partnership', emoji: '🤝', style: ButtonStyle.Secondary as const },
] as const;

export type TicketTypeId = (typeof TICKET_TYPES)[number]['id'];

async function findOrCreateRole(
  guild: Guild,
  name: string,
  color: number,
  perms: bigint[],
  managedId?: string,
  allowNameFallback = false,
) {
  // Once a guild has persisted state, managed IDs are authoritative. This avoids
  // adopting and mutating an unrelated role that happens to have the same name.
  const managed = managedId ? guild.roles.cache.get(managedId) : undefined;
  const existing = managed ?? (allowNameFallback ? guild.roles.cache.find((r) => r.name === name) : undefined);
  if (existing) {
    const nameOk = existing.name === name;
    const colorOk = existing.color === color;
    const permsOk = rolePermsMatch(existing as any, perms);
    if (!nameOk || !colorOk || !permsOk) {
      await existing.edit({ name, color, permissions: perms });
    }
    return guild.roles.cache.get(existing.id) ?? existing;
  }
  return guild.roles.create({ name, color, permissions: perms, reason: 'BluxBot live sync: create role' });
}

export function ticketTypeFromId(id: string) {
  return TICKET_TYPES.find((t) => t.id === id);
}

export async function ticketTypeFromIdLive(id: string): Promise<{ id: string; label: string; emoji: string; style: ButtonStyle } | undefined> {
  try {
    const t = await getTemplate();
    const found = t.ticketTypes.find((x) => x.id === id);
    if (!found) return undefined;
    return { id: found.id, label: found.label, emoji: found.emoji, style: styleFromName(found.style) };
  } catch {
    return ticketTypeFromId(id);
  }
}

export type GuildSyncResult = {
  guildId: string;
  created: number;
  repaired: number;
  roles: number;
  channels: number;
};

export async function syncGuild(guild: Guild): Promise<GuildSyncResult> {
  let tpl: BotTemplate;
  try {
    tpl = await getTemplate();
  } catch {
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
  const prevSetup = await getGuildSetup(guild.id).catch(() => null);
  const hasManagedState = prevSetup !== null;
  const prevChannels: Record<string, string> = (prevSetup?.channels as any) ?? {};
  const prevRoles: Record<string, string> = (prevSetup?.roles as any) ?? {};
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
  const roleIds: Record<string, string> = {};
  for (const r of roleDefs) {
    const role = await findOrCreateRole(
      guild,
      r.name,
      r.color,
      permsToBits(r.perms ?? []),
      prevRoles[r.name],
      !hasManagedState,
    );
    roleIds[r.name] = role.id;
  }
  const getRole = (n: string) => guild.roles.cache.get(roleIds[n]);
  // Hoist display roles so sidebar splits into separate groups (not just Online).
  // Muted is NEVER hoisted (muted users stay hidden in Online).
  for (const n of HOIST_NAMES) {
    const r = guild.roles.cache.get(roleIds[n]);
    if (r && !r.hoist) await r.edit({ hoist: true }).catch(() => {});
  }
  // Muted must never hoist.
  try {
    const mutedHoist = guild.roles.cache.get(roleIds['Muted']);
    if (mutedHoist?.hoist) await mutedHoist.edit({ hoist: false }).catch(() => {});
  } catch {}
  // Sidebar order top->bottom (canonical hierarchy):
  // Owner > Admin > Manager > Dev > Moderator > Mod > Staff > Support >
  // Bot > Media > VIP > Customer > Member > Muted
  // Incremental: only call setPositions when the order actually drifted.
  try {
    const orderTopFirst: readonly string[] = ROLE_ORDER_TOP_FIRST;
    await guild.roles.fetch();
    const botTop = guild.members.me?.roles.highest.position ?? 999;
    // Current relative order of our managed roles (higher position = higher in list).
    const managed = orderTopFirst
      .map((n) => guild.roles.cache.find((x) => x.name === n))
      .filter(Boolean) as NonNullable<ReturnType<typeof getRole>>[];
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
      const posMap: { role: string; position: number }[] = [];
      for (let i = orderTopFirst.length - 1; i >= 0; i--) {
        const r = guild.roles.cache.find((x) => x.name === orderTopFirst[i]);
        if (r) {
          const target = Math.min(pos, botTop - 1);
          if (r.position !== target) posMap.push({ role: r.id, position: target });
          pos++;
        }
      }
      if (posMap.length > 0) {
        await guild.roles.setPositions(posMap).catch(() => {});
        markRepaired();
      }
      await guild.roles.fetch();
    }
  } catch {}
  console.log(`[sync] roles reconciled: ${Object.keys(roleIds).length}`);
  const memberRole =
    guild.roles.cache.get(roleIds['Member']) ??
    guild.roles.cache.get(roleIds['Customer']) ??
    guild.roles.cache.get(Object.values(roleIds)[0] ?? '');
  const mutedRole = guild.roles.cache.get(roleIds['Muted']);

  const staffAllow = STAFF_NAMES.map(getRole).filter(Boolean) as NonNullable<ReturnType<typeof getRole>>[];
  // ticket-logs holds transcripts + staff reports -> senior staff only.
  // (Support/Staff/Mod must NOT see Staff Reports about themselves.)
  const seniorOnly = SENIOR_NAMES.map(getRole).filter(Boolean) as NonNullable<ReturnType<typeof getRole>>[];

  // 2. Categories + channels
  console.log(`[sync] categories/channels: ${guild.name ?? guild.id}`);
  const everyone = guild.roles.everyone;
  const botWriterRoles = [...(guild.members.me?.roles.cache.values() ?? [])].filter(
    (r) => r.id !== everyone.id && r.id !== mutedRole?.id && !staffAllow.some((staff) => staff.id === r.id),
  );
  const channelIds: Record<string, string> = {};
  let ticketCategoryId = '';
  let welcomeChannelId = '';
  let logChannelId = '';
  let reviewParent: CategoryChannel | undefined;

  const structure = tpl.structure.length > 0 ? tpl.structure : [];
  const categoryIds: Record<string, string> = {};
  for (const block of structure) {
    console.log(`[sync] category: ${block.category}`);
    const blockKeys = new Set(block.channels.map((channel) => channel.key));
    const priorCategoryFromChildren = Object.entries(prevChannels).find(([key, id]) => {
      if (!blockKeys.has(key)) return false;
      const channel = guild.channels.cache.get(id);
      return !!(channel && 'parentId' in channel && channel.parentId);
    });
    const priorChild = priorCategoryFromChildren
      ? guild.channels.cache.get(priorCategoryFromChildren[1])
      : undefined;
    const priorCategoryId =
      (prevSetup as any)?.categoryIds?.[block.category] ??
      (priorChild && 'parentId' in priorChild ? priorChild.parentId : undefined);

    let category = priorCategoryId
      ? (guild.channels.cache.get(priorCategoryId) as CategoryChannel | undefined) ??
        (await guild.channels.fetch(priorCategoryId).catch(() => null) as CategoryChannel | null)
      : undefined;
    category ??= !hasManagedState
      ? guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildCategory && c.name === block.category,
        ) as CategoryChannel | undefined
      : undefined;

    // Rename legacy MARKET only during initial adoption. Managed categories are
    // renamed in place through their persisted/derived IDs.
    if (!category && !hasManagedState && block.category.includes('CHAT')) {
      const old = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.includes('MARKET'),
      ) as CategoryChannel | undefined;
      if (old) {
        category = old;
      }
    }

    if (!category) {
      category = await guild.channels.create({ name: block.category, type: ChannelType.GuildCategory });
      createdCount++;
    } else if (category.name !== block.category) {
      await category.setName(block.category);
      markRepaired();
    }
    categoryIds[block.category] = category.id;
    if (block.channels.some((c) => c.key === 'review_submit' || c.key === 'review_display' || c.key === 'reviews')) {
      reviewParent = category;
    }
    if (block.category.includes('TICKETS')) ticketCategoryId = category.id;
    // Lock STAFF category so normal members can't see it at all (only fix when drifted).
    if (block.category.includes('STAFF')) {
      const want: DesiredOverwrite[] = [
        { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...staffAllow.map((r) => ({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
      ];
      if (!overwritesMatch(category as any, want)) {
        await category.permissionOverwrites.set(want as any);
        markRepaired();
        await throttleWrite();
      }
    } else if (
      block.category.includes('INFO') ||
      block.category.includes('SHOP') ||
      block.category.includes('CHAT') ||
      block.category.includes('VOICE')
    ) {
      // Public categories should inherit; only repair when an explicit deny exists.
      if (!overwritesMatch(category as any, [])) {
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
      // readonly   : welcome/invite_reward/website/rules/partnership/announcements/faq/reviews/create-ticket
      //              -> @everyone View ALLOW + Send DENY, staff ALLOW Send, Muted DENY Send
      // openText   : general-chat/bot-commands -> inherit (@everyone can View+Send), Muted DENY Send
      // openVoice  : Lounge/Support 1/2  -> @everyone ALLOW View+Connect+Speak, Muted DENY Connect+Speak
      // Normal roles (Bot/Media/VIP/Customer/Member) cannot see staff/senior channels.
      // Giveaway entries use reactions; normal member/customer/media roles cannot chat there.
      const isVoiceCh = (ch as { type: string }).type === 'voice';
      const isSeniorOnly = ch.key === 'ticketlogs';
      const isStaffOnly = ch.key === 'staff' || ch.key === 'modlog' || ch.key === 'stock';
      const isStaffPostOnly = ch.key === 'giveaways';
      const isReadonly =
        ch.key === 'rules' ||
        ch.key === 'announcements' ||
        ch.key === 'welcome' ||
        ch.key === 'invite_reward' ||
        ch.key === 'website' ||
        ch.key === 'faq' ||
        ch.key === 'partnership' ||
        ch.key === 'reviews' ||
        ch.key === 'tickets' ||
        ch.key === 'review_submit' ||
        ch.key === 'review_display';
      const buildOverwrites = (): OverwriteResolvable[] => {
        if (isSeniorOnly) {
          const ow: OverwriteResolvable[] = [
            { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          ];
          for (const r of seniorOnly) {
            ow.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          }
          if (mutedRole) ow.push({ id: mutedRole.id, deny: [PermissionFlagsBits.ViewChannel] });
          return ow;
        }
        if (isStaffOnly) {
          const ow: OverwriteResolvable[] = [
            { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          ];
          for (const r of staffAllow) {
            ow.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          }
          if (mutedRole) ow.push({ id: mutedRole.id, deny: [PermissionFlagsBits.ViewChannel] });
          return ow;
        }
        if (isStaffPostOnly) {
          const ow: OverwriteResolvable[] = [
            {
              id: everyone.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions],
              deny: [PermissionFlagsBits.SendMessages],
            },
          ];
          for (const r of staffAllow) {
            ow.push({
              id: r.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AddReactions,
              ],
            });
          }
          for (const r of botWriterRoles) {
            ow.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          }
          if (mutedRole) ow.push({ id: mutedRole.id, deny: [PermissionFlagsBits.SendMessages] });
          return ow;
        }
        if (isReadonly) {
          const ow: OverwriteResolvable[] = [
            {
              id: everyone.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
              deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions],
            },
          ];
          // Staff can still post announcements / manage panels.
          for (const r of staffAllow) {
            ow.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          }
          // Read-only channels still need an explicit allow for the bot role;
          // otherwise a non-Administrator bot cannot publish the review feed.
          for (const r of botWriterRoles) {
            ow.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          }
          if (mutedRole) {
            ow.push({
              id: mutedRole.id,
              allow: [PermissionFlagsBits.ViewChannel],
              deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions],
            });
          }
          return ow;
        }
        if (isVoiceCh) {
          const ow: OverwriteResolvable[] = [
            {
              id: everyone.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
            },
          ];
          if (mutedRole) {
            ow.push({
              id: mutedRole.id,
              deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
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
      const desiredType = isVoiceCh ? ChannelType.GuildVoice : ChannelType.GuildText;
      let existing: any = prevChannels[ch.key]
        ? guild.channels.cache.get(prevChannels[ch.key])
        : hasManagedState
          ? undefined
          : guild.channels.cache.find((c) => 'name' in c && (c as any).name === ch.name);

      if (existing && existing.type !== desiredType) existing = undefined;

      if (!existing && ch.key === 'review_submit') {
        const legacyById = prevChannels['reviews'] ? guild.channels.cache.get(prevChannels['reviews']) : undefined;
        const legacyByName = hasManagedState
          ? undefined
          : guild.channels.cache.find((c) => 'name' in c && (c as any).name === '⭐・reviews');
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
            const cache = (existing as any).permissionOverwrites.cache;
            const hasDenyForEveryone = [...cache.values()].some((ow: any) => {
              try {
                return ow.id === everyone.id && ow.deny.bitfield !== 0n;
              } catch {
                return false;
              }
            });
            if (hasDenyForEveryone && !overwritesMatch(existing as any, want as unknown as DesiredOverwrite[])) {
              await (existing as any).permissionOverwrites.set(want);
              markRepaired();
              await throttleWrite();
            }
          } else if (!overwritesMatch(existing as any, want as DesiredOverwrite[])) {
            await (existing as any).permissionOverwrites.set(want);
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

      const overwrites: OverwriteResolvable[] = buildOverwrites();

      let created;
      const isVoice = (ch as { type: string }).type === 'voice';
      if (isVoice) {
        created = await guild.channels.create({
          name: ch.name,
          type: ChannelType.GuildVoice,
          parent: category.id,
          permissionOverwrites: overwrites,
          reason: 'BluxBot live sync',
        });
      } else {
        created = await guild.channels.create({
          name: ch.name,
          type: ChannelType.GuildText,
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
      reviewParent = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === fallbackBlock.category
      ) as CategoryChannel | undefined;
    }
  }

  const reviewReadonlyOverwrites = (): OverwriteResolvable[] => {
    const overwrites: OverwriteResolvable[] = [
      {
        id: everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions],
      },
    ];
    for (const r of staffAllow) {
      overwrites.push({
        id: r.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      });
    }
    if (mutedRole) {
      overwrites.push({
        id: mutedRole.id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions],
      });
    }
    // The bot may not have a staff role, but it must be able to publish to the
    // feed even when the feed is read-only for normal members.
    for (const r of botWriterRoles) {
      overwrites.push({
        id: r.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      });
    }
    return overwrites;
  };

  const textChannelById = async (id: string | undefined, excluded: Set<string>): Promise<TextChannel | undefined> => {
    if (!id || excluded.has(id)) return undefined;
    const candidate = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
    if (!candidate || !candidate.isTextBased() || candidate.isDMBased()) return undefined;
    return candidate as TextChannel;
  };

  const textChannelByName = (name: string, excluded: Set<string>): TextChannel | undefined => {
    const candidate = guild.channels.cache.find((c) => {
      if (!('name' in c) || (c as any).name !== name || excluded.has(c.id)) return false;
      return c.isTextBased() && !c.isDMBased();
    });
    return candidate as TextChannel | undefined;
  };

  const ensureReviewChannel = async (
    key: 'review_submit' | 'review_display',
    name: string,
    excluded: Set<string>,
    topic: string,
    allowNameFallback: boolean,
  ): Promise<void> => {
    let channel = await textChannelById(channelIds[key], excluded);
    if (!channel && allowNameFallback) channel = textChannelByName(name, excluded);
    if (!channel) {
      const created = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: reviewParent?.id,
        topic,
        permissionOverwrites: reviewReadonlyOverwrites(),
        reason: `BluxBot live sync: create ${name}`,
      });
      channel = created as TextChannel;
      createdCount++;
      await throttleWrite();
    } else if (reviewParent && 'parentId' in channel && channel.parentId !== reviewParent.id && 'setParent' in channel) {
      await channel.setParent(reviewParent.id).catch(() => {});
      markRepaired();
    }
    channelIds[key] = channel.id;
  };

  const submitExcluded = new Set(
    Object.entries(channelIds)
      .filter(([key]) => key !== 'review_submit' && key !== 'reviews')
      .map(([, id]) => id),
  );
  await ensureReviewChannel(
    'review_submit',
    REVIEW_SUBMIT_CHANNEL_NAME,
    submitExcluded,
    'Pick stars to leave a review',
    !hasManagedState,
  );

  const displayExcluded = new Set(
    Object.entries(channelIds)
      .filter(([key]) => key !== 'review_display')
      .map(([, id]) => id),
  );
  await ensureReviewChannel(
    'review_display',
    REVIEW_DISPLAY_CHANNEL_NAME,
    displayExcluded,
    'Customer reviews feed',
    !hasManagedState,
  );

  welcomeChannelId = channelIds['welcome'] ?? '';
  logChannelId = channelIds['modlog'] ?? '';

  console.log(`[sync] channels reconciled: ${Object.keys(channelIds).length}`);
  // 3. Muted restrictions apply only to channels managed by this bot.
  if (mutedRole) {
    for (const channelId of Object.values(channelIds)) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) continue;
      const ow = (channel as any).permissionOverwrites?.cache?.get(mutedRole.id);
      if (channel.type === ChannelType.GuildVoice) {
        const deny = ow?.deny.bitfield ?? 0n;
        const needConnect = (deny & PermissionFlagsBits.Connect) === 0n;
        const needSpeak = (deny & PermissionFlagsBits.Speak) === 0n;
        if (!ow || needConnect || needSpeak) {
          await (channel as any).permissionOverwrites.edit(mutedRole, {
            Connect: false,
            Speak: false,
          });
          markRepaired();
        }
      } else if (channel.isTextBased() && !channel.isDMBased()) {
        const deny = ow?.deny.bitfield ?? 0n;
        const needSend = (deny & PermissionFlagsBits.SendMessages) === 0n;
        if (!ow || needSend) {
          await (channel as TextChannel).permissionOverwrites.edit(mutedRole, {
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

  // Ensure category ordering matches template order (📌 INFO -> 🛒 SHOP -> 💬 CHAT -> ...)
  try {
    let catPos = 0;
    for (const block of structure) {
      const catId = categoryIds[block.category];
      const cat = catId ? (guild.channels.cache.get(catId) as CategoryChannel | undefined) : undefined;
      if (cat && cat.position !== catPos) {
        await cat.setPosition(catPos).catch(() => {});
      }
      catPos++;
    }
  } catch {}

  console.log(`[sync] muted permissions checked`);
  // 4. Upsert panels in place. Messages are never deleted by routine sync.
  const botId = guild.members.me?.id;
  const refresh = async (
    channelId: string | undefined,
    data: { content?: string; embeds: EmbedBuilder[]; components?: any[] },
    options: { preserveBotMessages?: boolean } = {},
  ) => {
    if (!channelId) return;
    const c = guild.channels.cache.get(channelId) as TextChannel | undefined;
    if (!c || !c.isTextBased()) return;
    const msgs = await c.messages.fetch({ limit: 15 }).catch(() => null);
    const botMsgs = msgs ? [...msgs.values()].filter((m) => botId && m.author.id === botId) : [];
    const matchingPanel = botMsgs.find((m) => panelMatches(m, data.embeds, data.components, data.content));
    if (matchingPanel) return;

    const wantTitle = (data.embeds[0]?.toJSON() as any)?.title ?? '';
    const sameTitleMsg = wantTitle
      ? botMsgs.find((m) => ((m.embeds ?? [])[0]?.title ?? '') === wantTitle)
      : undefined;

    if (sameTitleMsg) {
      await sameTitleMsg.edit({
        content: data.content ?? null,
        embeds: data.embeds,
        components: (data.components ?? []) as any,
      });
      markRepaired();
      return;
    }

    if (botMsgs.length > 0 && options.preserveBotMessages) {
      // Channels like the review feed and welcome feed contain bot-authored
      // feed messages. Add the panel rather than overwriting a feed message.
      await c.send({
        content: data.content,
        embeds: data.embeds,
        components: data.components as any,
      });
      markRepaired();
      return;
    }
    if (botMsgs.length > 0) {
      await botMsgs[0].edit({
        content: data.content ?? null,
        embeds: data.embeds,
        components: (data.components ?? []) as any,
      });
    } else {
      await c.send({
        content: data.content,
        embeds: data.embeds,
        components: data.components as any,
      });
    }
    markRepaired();
  };

  const panels = tpl.panels;
  const link = (key: string) => (channelIds[key] ? `<#${channelIds[key]}>` : `#${key}`);
  let rulesDesc = panels.rulesDescription || '';
  if (channelIds['tickets'] && !rulesDesc.includes('<#')) {
    rulesDesc += `\n\nOpen a ticket in ${link('tickets')} for help.`;
  }
  let welcomeDesc = panels.welcomeDescription || '';
  if (!welcomeDesc.includes('<#') && (channelIds['chat'] || channelIds['tickets'] || channelIds['rules'] || channelIds['invite_reward'] || channelIds['website'])) {
    const bits = [
      channelIds['website'] ? `• **Store:** ${link('website')}` : '',
      channelIds['invite_reward'] ? `• **Invite Rewards:** ${link('invite_reward')}` : '',
      channelIds['tickets'] ? `• **Support & Claims:** ${link('tickets')}` : '',
      channelIds['rules'] ? `• **Rules:** ${link('rules')}` : '',
    ].filter(Boolean);
    if (bits.length > 0) welcomeDesc += (welcomeDesc ? '\n\n' : '') + bits.join('\n');
  }
  let partnershipDesc = panels.partnershipDescription || '';
  if (channelIds['tickets'] && !partnershipDesc.includes('<#')) {
    partnershipDesc += `\n\n🤝 **Apply now in ${link('tickets')} — open a Partnership ticket.**`;
  }

  let inviteRewardDesc =
    panels.inviteRewardDescription ||
    '💰 **3M per invite** — Minimum **5 invites** to claim (**15M**)\n\n• **1 Invite** = 3M\n• **5 Invites** = 15M *(Minimum to claim)*\n• **10 Invites** = 30M\n\n⚠️ **Requirements**\n• Invited account must be at least **2 months old**\n• Invited member must stay in the server for at least **2 hours**\n• Fake / alt accounts or members who leave do **not** count';
  if (!inviteRewardDesc.includes('<#')) {
    const trackerRef = channelIds['welcome'] ? link('welcome') : '`#welcome`';
    const ticketRef = channelIds['tickets'] ? link('tickets') : '`#create-ticket`';
    inviteRewardDesc += `\n\n📌 **How to Claim**\nTrack your invites in ${trackerRef} or with \`/invites\`, then open a ticket in ${ticketRef} once you reach **5+ invites**.`;
  }

  const websiteDesc =
    panels.websiteDescription ||
    'Shop DonutSMP coins, spawners, elytras, and items with 24/7 instant delivery.\n\n🔗 https://bluxmart.com/';

  await refresh(channelIds['rules'], {
    embeds: [
      new EmbedBuilder()
        .setTitle(panels.rulesTitle || 'Rules')
        .setColor(0x5865f2)
        .setDescription(rulesDesc.slice(0, 4000) || 'No rules configured.')
        .setFooter({ text: 'bluxmart' }),
    ],
  });

  await refresh(channelIds['partnership'], {
    embeds: [
      new EmbedBuilder()
        .setTitle(panels.partnershipTitle || 'Partnership')
        .setColor(0x5865f2)
        .setDescription(partnershipDesc.slice(0, 4000) || 'No partnership info configured.'),
    ],
  });

  await refresh(channelIds['faq'], {
    embeds: [
      new EmbedBuilder()
        .setTitle(panels.faqTitle || 'FAQ')
        .setColor(0x3498db)
        .setDescription((panels.faqDescription || '').slice(0, 4000) || 'No FAQ configured.'),
    ],
  });

  await refresh(channelIds['invite_reward'], {
    embeds: [
      new EmbedBuilder()
        .setTitle(panels.inviteRewardTitle || '🎁 Invite Rewards')
        .setColor(0xf1c40f)
        .setDescription(inviteRewardDesc.slice(0, 4000)),
    ],
  });

  await refresh(channelIds['website'], {
    content: 'https://bluxmart.com/',
    embeds: [
      new EmbedBuilder()
        .setTitle(panels.websiteTitle || '🌐 Bluxmart Official Store')
        .setURL('https://bluxmart.com/')
        .setColor(0x2ecc71)
        .setDescription(websiteDesc.slice(0, 4000)),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel('Visit Bluxmart.com')
          .setStyle(ButtonStyle.Link)
          .setURL('https://bluxmart.com/')
      ),
    ],
  });

  await refresh(
    welcomeChannelId,
    {
      embeds: [
        new EmbedBuilder()
          .setTitle(panels.welcomeTitle || '👋 Welcome to Bluxmart')
          .setColor(0x2ecc71)
          .setDescription(welcomeDesc.slice(0, 4000) || 'Welcome!')
          .setThumbnail(guild.iconURL() ?? null),
      ],
    },
    { preserveBotMessages: true },
  );

  // Reviews split: submit channel hosts the picker, display channel hosts the feed.
  // Legacy channels are preserved; only explicitly managed IDs are repaired.

  const reviewSubmitId = channelIds['review_submit'] ?? channelIds['reviews'];
  const reviewDisplayId = channelIds['review_display'] ?? undefined;

  await refresh(reviewSubmitId, {
    embeds: [
      new EmbedBuilder()
        .setTitle(panels.reviewsTitle || 'Reviews')
        .setColor(0xf1c40f)
        .setDescription(
          ((panels.reviewsDescription || '').slice(0, 4000) || 'Leave a review!') +
            (reviewDisplayId ? `\n\n✅ Reviews show up in <#${reviewDisplayId}>` : '')
        ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('review_stars')
          .setPlaceholder('Choose 1-5 stars...')
          .addOptions(
            { label: '5 stars — Excellent', value: '5', emoji: '⭐' },
            { label: '4 stars — Great', value: '4', emoji: '⭐' },
            { label: '3 stars — Okay', value: '3', emoji: '⭐' },
            { label: '2 stars — Bad', value: '2', emoji: '⭐' },
            { label: '1 star — Terrible', value: '1', emoji: '⭐' },
          )
      ),
    ],
  });

  await refresh(
    reviewDisplayId,
    {
      embeds: [
        new EmbedBuilder()
          .setTitle('🌟 Customer Reviews')
          .setColor(0xf1c40f)
          .setDescription(
            `Verified reviews from **Customer** buyers appear here.\n\nLeave yours in ${
              reviewSubmitId ? `<#${reviewSubmitId}>` : 'the review-submit channel'
            } — pick 1-5 stars.`
          ),
      ],
    },
    { preserveBotMessages: true },
  );

  // Ticket panel buttons come from the dashboard template (any count).
  const liveTypes = tpl.ticketTypes.length > 0 ? tpl.ticketTypes : [];
  // Ticket panel: only ticket-type buttons. Close lives inside each open ticket channel,
  // never on the create-ticket panel itself.
  const ticketRows: ActionRowBuilder<ButtonBuilder>[] = [];
  let cur: ButtonBuilder[] = [];
  for (const tt of liveTypes.slice(0, 10)) {
    cur.push(
      new ButtonBuilder().setCustomId(tt.id).setLabel(tt.label.slice(0, 80)).setStyle(styleFromName(tt.style)).setEmoji(tt.emoji)
    );
    if (cur.length === 5) {
      ticketRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...cur));
      cur = [];
    }
  }
  if (cur.length > 0) {
    ticketRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...cur));
    cur = [];
  }

  await refresh(channelIds['tickets'], {
    embeds: [
      new EmbedBuilder()
        .setTitle(panels.ticketsTitle || 'Support')
        .setColor(0xe67e22)
        .setDescription((panels.ticketsDescription || '').slice(0, 4000) || 'Open a ticket below.'),
    ],
    components: ticketRows.slice(0, 5),
  });

  console.log(`[sync] panels updated`);
  // 5. Persist managed IDs for the next in-place update.
  const state: GuildSetup = {
    guildId: guild.id,
    roles: roleIds,
    channels: channelIds,
    categoryIds,
    welcomeChannelId,
    logChannelId,
    ticketCategoryId,
    autoRoleId: memberRole?.id,
    updatedAt: new Date().toISOString(),
  };
  await saveGuildSetup(state);

  const result: GuildSyncResult = {
    guildId: guild.id,
    created: createdCount,
    repaired: repairedCount,
    roles: Object.keys(roleIds).length,
    channels: Object.keys(channelIds).length,
  };
  console.log(
    `[sync] ${guild.name ?? guild.id}: created=${result.created} repaired=${result.repaired} ` +
      `roles=${result.roles} channels=${result.channels}`,
  );

  return result;
}

const guildQueues = new Map<string, Promise<GuildSyncResult>>();

async function refreshWithTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 8000): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[sync] ${label} timed out after ${timeoutMs}ms; using cached state`);
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn(`[sync] ${label} failed:`, error instanceof Error ? error.message : error);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Serialize sync work per guild so boot, watcher, and self-heal cannot race. */
export function queueGuildSync(guild: Guild, reason = 'scheduled'): Promise<GuildSyncResult> {
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
      console.log(`[sync] reconciling ${guild.name ?? guild.id}`);
      const result = await refreshWithTimeout(syncGuild(guild), `reconciliation for ${guild.id}`, 60000);
      if (!result) throw new Error(`reconciliation for ${guild.id} timed out`);
      return result;
    });
  guildQueues.set(guild.id, run);
  const clean = () => {
    if (guildQueues.get(guild.id) === run) guildQueues.delete(guild.id);
  };
  run.then(clean, clean);
  return run;
}

export type AllGuildSyncResult = {
  applied: GuildSyncResult[];
  failed: Array<{ guildId: string; error: string }>;
};

/** If an allowlist is configured, only those servers are managed. */
export async function syncAllGuilds(client: Client, reason: string): Promise<AllGuildSyncResult> {
  if (!client.isReady()) return { applied: [], failed: [] };

  let guilds = [...client.guilds.cache.values()];
  const allowedGuildIds = config.allowedGuildIds?.length
    ? config.allowedGuildIds
    : config.guildId
      ? [config.guildId]
      : [];
  if (allowedGuildIds.length > 0) {
    guilds = (
      await Promise.all(
        allowedGuildIds.map(async (id) => client.guilds.cache.get(id) ?? await client.guilds.fetch(id).catch(() => null)),
      )
    ).filter((guild): guild is NonNullable<typeof guild> => guild !== null);
  }

  const applied: GuildSyncResult[] = [];
  const failed: Array<{ guildId: string; error: string }> = [];
  for (const guild of guilds) {
    try {
      applied.push(await queueGuildSync(guild, reason));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ guildId: guild.id, error: message });
      console.error(`[sync] failed for ${guild.id}:`, message);
    }
  }
  return { applied, failed };
}

export type TemplateSyncResult = AllGuildSyncResult & {
  revision: string;
  queued: boolean;
};

const DATA_DIR = path.join(process.cwd(), 'data');
const TEMPLATE_FILE = path.join(DATA_DIR, 'bot-config.json');
let templateQueue: Promise<unknown> = Promise.resolve();
let lastTemplateSync: { revision: string; result: TemplateSyncResult } | undefined;

async function templateRevision(): Promise<string> {
  try {
    const raw = await readFile(TEMPLATE_FILE, 'utf-8');
    return createHash('sha256').update(raw).digest('hex');
  } catch {
    return 'built-in-defaults';
  }
}

/**
 * Apply a saved template immediately. Calls for the same file revision are
 * deduplicated, while a newer edit is always queued after the current sync.
 */
export function requestTemplateSync(client: Client, reason: string): Promise<TemplateSyncResult> {
  const run = templateQueue
    .catch(() => undefined)
    .then(async (): Promise<TemplateSyncResult> => {
      const revision = await templateRevision();
      if (lastTemplateSync?.revision === revision) return lastTemplateSync.result;
      if (!client.isReady()) return { revision, queued: true, applied: [], failed: [] };

      const result = await syncAllGuilds(client, reason);
      const full: TemplateSyncResult = { revision, queued: false, ...result };
      if (full.failed.length === 0) {
        lastTemplateSync = { revision, result: full };
      }
      console.log(`[sync] template ${revision.slice(0, 8)} applied to ${full.applied.length} server(s)`);
      return full;
    });
  templateQueue = run.catch(() => undefined);
  return run;
}

let templateWatcher: FSWatcher | undefined;
let templateDebounce: NodeJS.Timeout | undefined;

/** Watch dashboard/external template edits and reconcile without a process restart. */
export function watchTemplateChanges(client: Client): void {
  if (templateWatcher) return;
  mkdirSync(DATA_DIR, { recursive: true });
  templateWatcher = watch(DATA_DIR, (_event, filename) => {
    if (filename && path.basename(filename.toString()) !== path.basename(TEMPLATE_FILE)) return;
    if (templateDebounce) clearTimeout(templateDebounce);
    templateDebounce = setTimeout(() => {
      requestTemplateSync(client, 'data/bot-config.json changed').catch((error) => {
        console.error('[sync] template watcher failed:', error instanceof Error ? error.message : error);
      });
    }, 350);
  });
  templateWatcher.on('error', (error) => console.error('[sync] template watcher error:', error.message));
  console.log('[sync] live template watcher enabled');
}

