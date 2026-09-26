import { promises as fs } from 'fs';
import path from 'path';
import {
  Client,
  EmbedBuilder,
  Events,
  Guild,
  GuildMember,
  Invite,
  PartialGuildMember,
  TextChannel,
} from 'discord.js';
import { getGuildSetup } from '../store';

export interface InviteSnapshot {
  code: string;
  uses: number;
  inviterId: string | null;
  inviterTag: string | null;
}

export interface MemberJoinRecord {
  memberId: string;
  memberTag: string;
  inviterId: string | null;
  inviterTag: string | null;
  code: string | null;
  joinedAt: string;
  accountCreatedAt?: string;
  accountAgeDays?: number;
  fake?: boolean;
  fakeReason?: string;
  left?: boolean;
}

export interface GuildInviteStore {
  /** Base uses seeded from Discord's active invite list per inviterId */
  seededUses: Record<string, { count: number; tag: string }>;
  /** Tracked joins while the bot is running (memberId -> record) */
  joins: Record<string, MemberJoinRecord>;
  /** Optional bonus adjustments per userId */
  bonus: Record<string, number>;
}

export interface InviterStats {
  userId: string;
  valid: number;
  regular: number;
  total: number;
  fake: number;
  left: number;
  pending: number;
  bonus: number;
  rewardMillions: number;
  canClaim: boolean;
  neededForClaim: number;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');

export const REWARD_PER_INVITE_MILLIONS = 3;
export const MIN_INVITES_TO_CLAIM = 5;
export const MIN_ACCOUNT_AGE_DAYS = 60; // 2 months
export const MIN_SERVER_STAY_MS = 2 * 60 * 60 * 1000; // 2 hours

// In-memory cache of active invites per guild: guildId -> (code -> InviteSnapshot)
const guildInviteCache = new Map<string, Map<string, InviteSnapshot>>();

async function readAllInviteStores(): Promise<Record<string, GuildInviteStore>> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(INVITES_FILE, 'utf-8');
    return JSON.parse(raw) as Record<string, GuildInviteStore>;
  } catch {
    return {};
  }
}

async function writeAllInviteStores(data: Record<string, GuildInviteStore>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(INVITES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function ensureGuildRecord(all: Record<string, GuildInviteStore>, guildId: string): GuildInviteStore {
  if (!all[guildId]) {
    all[guildId] = {
      seededUses: {},
      joins: {},
      bonus: {},
    };
  }
  all[guildId].seededUses ??= {};
  all[guildId].joins ??= {};
  all[guildId].bonus ??= {};
  return all[guildId];
}

export function calculateInviterStats(store: GuildInviteStore, userId: string): InviterStats {
  const now = Date.now();
  const trackedJoins = Object.values(store.joins).filter((j) => j.inviterId === userId);
  const trackedTotal = trackedJoins.length;
  const fake = trackedJoins.filter((j) => j.fake).length;
  const left = trackedJoins.filter((j) => !j.fake && j.left).length;
  const pending = trackedJoins.filter((j) => {
    if (j.fake || j.left) return false;
    const joinedMs = Date.parse(j.joinedAt) || 0;
    return joinedMs > 0 && now - joinedMs < MIN_SERVER_STAY_MS;
  }).length;

  const seeded = store.seededUses[userId]?.count ?? 0;
  const regular = Math.max(seeded, trackedTotal);
  const bonus = store.bonus[userId] ?? 0;
  const valid = Math.max(0, regular - fake - left - pending + bonus);
  const rewardMillions = valid * REWARD_PER_INVITE_MILLIONS;
  const canClaim = valid >= MIN_INVITES_TO_CLAIM;
  const neededForClaim = Math.max(0, MIN_INVITES_TO_CLAIM - valid);

  return {
    userId,
    valid,
    regular,
    total: regular,
    fake,
    left,
    pending,
    bonus,
    rewardMillions,
    canClaim,
    neededForClaim,
  };
}

export async function getMemberInviteStats(guildId: string, userId: string): Promise<InviterStats> {
  const all = await readAllInviteStores();
  const gStore = ensureGuildRecord(all, guildId);
  return calculateInviterStats(gStore, userId);
}

/**
 * Fetch and cache all current invites for a guild, and update the baseline seeded counts.
 */
export async function cacheGuildInvites(guild: Guild): Promise<void> {
  try {
    const invites = await guild.invites.fetch();
    const snapshotMap = new Map<string, InviteSnapshot>();
    const perInviterUses = new Map<string, { count: number; tag: string }>();

    for (const [, inv] of invites) {
      const uses = inv.uses ?? 0;
      const inviterId = inv.inviter?.id ?? null;
      const inviterTag = inv.inviter?.username ?? inv.inviter?.tag ?? null;
      snapshotMap.set(inv.code, {
        code: inv.code,
        uses,
        inviterId,
        inviterTag,
      });
      if (inviterId && uses > 0) {
        const prev = perInviterUses.get(inviterId) ?? { count: 0, tag: inviterTag ?? inviterId };
        prev.count += uses;
        perInviterUses.set(inviterId, prev);
      }
    }

    guildInviteCache.set(guild.id, snapshotMap);

    const all = await readAllInviteStores();
    const gStore = ensureGuildRecord(all, guild.id);
    let changed = false;
    for (const [inviterId, info] of perInviterUses.entries()) {
      const prev = gStore.seededUses[inviterId]?.count ?? 0;
      if (info.count > prev) {
        gStore.seededUses[inviterId] = { count: info.count, tag: info.tag };
        changed = true;
      }
    }
    if (changed) {
      await writeAllInviteStores(all);
    }
    console.log(`[invites] cached ${snapshotMap.size} invite(s) for ${guild.name}`);
  } catch (err) {
    console.warn(`[invites] could not fetch invites for ${guild.name}:`, (err as Error).message);
  }
}

export function handleInviteCreate(invite: Invite): void {
  const guildId = invite.guild?.id;
  if (!guildId) return;
  let map = guildInviteCache.get(guildId);
  if (!map) {
    map = new Map();
    guildInviteCache.set(guildId, map);
  }
  map.set(invite.code, {
    code: invite.code,
    uses: invite.uses ?? 0,
    inviterId: invite.inviter?.id ?? null,
    inviterTag: invite.inviter?.username ?? invite.inviter?.tag ?? null,
  });
}

export function handleInviteDelete(invite: Invite): void {
  const guildId = invite.guild?.id;
  if (!guildId) return;
  guildInviteCache.get(guildId)?.delete(invite.code);
}

/**
 * Detect which invite was used by comparing current guild invites with cached snapshot,
 * evaluate fake/account-age & 2-hour stay rules, and post the tracker card in #welcome.
 */
export async function handleMemberJoinWithInvite(member: GuildMember): Promise<void> {
  const guild = member.guild;
  const prevCache = guildInviteCache.get(guild.id) ?? new Map<string, InviteSnapshot>();
  let usedInvite: InviteSnapshot | null = null;

  try {
    const currentInvites = await guild.invites.fetch();
    const nextCache = new Map<string, InviteSnapshot>();
    const perInviterUses = new Map<string, { count: number; tag: string }>();

    for (const [, inv] of currentInvites) {
      const uses = inv.uses ?? 0;
      const inviterId = inv.inviter?.id ?? null;
      const inviterTag = inv.inviter?.username ?? inv.inviter?.tag ?? null;
      const snap: InviteSnapshot = {
        code: inv.code,
        uses,
        inviterId,
        inviterTag,
      };
      nextCache.set(inv.code, snap);

      const prev = prevCache.get(inv.code);
      if (!usedInvite) {
        if (prev && uses > prev.uses) {
          usedInvite = snap;
        } else if (!prev && uses > 0) {
          usedInvite = snap;
        }
      }

      if (inviterId && uses > 0) {
        const agg = perInviterUses.get(inviterId) ?? { count: 0, tag: inviterTag ?? inviterId };
        agg.count += uses;
        perInviterUses.set(inviterId, agg);
      }
    }

    guildInviteCache.set(guild.id, nextCache);

    const all = await readAllInviteStores();
    const gStore = ensureGuildRecord(all, guild.id);
    for (const [inviterId, info] of perInviterUses.entries()) {
      gStore.seededUses[inviterId] = { count: info.count, tag: info.tag };
    }

    const createdMs = member.user.createdTimestamp || Date.now();
    const accountAgeDays = Math.floor((Date.now() - createdMs) / (1000 * 60 * 60 * 24));
    const isSelfInvite = usedInvite?.inviterId === member.id;
    const isTooYoung = accountAgeDays < MIN_ACCOUNT_AGE_DAYS;
    const isFake = isSelfInvite || isTooYoung;
    const fakeReason = isSelfInvite
      ? 'Self-invite'
      : isTooYoung
        ? `Account age (${accountAgeDays}d < 60d required)`
        : undefined;

    const inviterId = usedInvite?.inviterId ?? null;
    const inviterTag = usedInvite?.inviterTag ?? null;

    gStore.joins[member.id] = {
      memberId: member.id,
      memberTag: member.user.username,
      inviterId,
      inviterTag,
      code: usedInvite?.code ?? null,
      joinedAt: new Date().toISOString(),
      accountCreatedAt: new Date(createdMs).toISOString(),
      accountAgeDays,
      fake: isFake,
      fakeReason,
      left: false,
    };
    await writeAllInviteStores(all);

    const setup = await getGuildSetup(guild.id).catch(() => null);
    if (setup?.autoRoleId) {
      await member.roles.add(setup.autoRoleId).catch(() => {});
    }

    const welcomeId =
      setup?.welcomeChannelId ||
      setup?.channels?.['welcome'] ||
      guild.channels.cache.find((c: any) => 'name' in c && c.name.includes('welcome'))?.id;
    const inviteRewardId =
      setup?.channels?.['invite_reward'] ||
      guild.channels.cache.find((c: any) => 'name' in c && c.name.includes('invite-reward'))?.id;

    const welcomeCh = welcomeId ? (guild.channels.cache.get(welcomeId) as TextChannel | undefined) : undefined;
    if (welcomeCh?.isTextBased()) {
      const s = inviterId ? calculateInviterStats(gStore, inviterId) : null;
      const statusBadge = isFake
        ? `⚠️ **Fake Invite** (${fakeReason})`
        : `⏳ **Valid after 2h in server** (Account age: ${accountAgeDays}d ✅)`;

      const inviterLine = inviterId && s
        ? `• **Invited by:** <@${inviterId}> (**${s.valid} valid** — \`${s.regular} regular • ${s.fake} fake • ${s.left} left • ${s.pending} pending\`)`
        : `• **Invited by:** Direct / Vanity Link`;

      const embed = new EmbedBuilder()
        .setTitle(`👋 Welcome, ${member.user.username}!`)
        .setColor(isFake ? 0xe67e22 : 0x2ecc71)
        .setDescription(
          [
            `Welcome ${member} to **Bluxmart** (Member **#${guild.memberCount}**).`,
            '',
            inviterLine,
            `• **Status:** ${statusBadge}`,
            inviteRewardId ? `• **Rewards:** <#${inviteRewardId}> (3M/invite • min 5)` : '',
          ]
            .filter(Boolean)
            .join('\n')
        )
        .setThumbnail(member.user.displayAvatarURL());

      const mentionContent = inviterId
        ? `Welcome ${member} — invited by <@${inviterId}>`
        : `Welcome ${member}`;

      await welcomeCh.send({ content: mentionContent, embeds: [embed] }).catch(() => {});
    }
  } catch (err) {
    console.error('[invites] join handler error:', err);
  }
}

export async function handleMemberLeaveWithInvite(member: GuildMember | PartialGuildMember): Promise<void> {
  try {
    const all = await readAllInviteStores();
    const gStore = all[member.guild.id];
    if (!gStore || !gStore.joins[member.id]) return;
    const rec = gStore.joins[member.id];
    rec.left = true;
    await writeAllInviteStores(all);

    const setup = await getGuildSetup(member.guild.id).catch(() => null);
    const welcomeId =
      setup?.welcomeChannelId ||
      setup?.channels?.['welcome'] ||
      member.guild.channels.cache.find((c: any) => 'name' in c && c.name.includes('welcome'))?.id;
    const welcomeCh = welcomeId ? (member.guild.channels.cache.get(welcomeId) as TextChannel | undefined) : undefined;
    if (welcomeCh?.isTextBased() && rec.inviterId) {
      const s = calculateInviterStats(gStore, rec.inviterId);
      await welcomeCh
        .send({
          content: `📤 **${rec.memberTag}** left the server — invited by <@${rec.inviterId}> (**${s.valid} valid** — \`${s.regular} regular • ${s.fake} fake • ${s.left} left\`).`,
        })
        .catch(() => {});
    }
  } catch {}
}

export function registerInviteTrackerEvents(client: Client): void {
  client.on(Events.InviteCreate, (invite: Invite) => {
    handleInviteCreate(invite);
  });
  client.on(Events.InviteDelete, (invite: Invite) => {
    handleInviteDelete(invite);
  });
  client.on(Events.GuildMemberRemove, (member: GuildMember | PartialGuildMember) => {
    handleMemberLeaveWithInvite(member).catch(() => {});
  });
}
