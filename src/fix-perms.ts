import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { config } from './config';

// Repair script: re-applies the canonical role -> channel matrix without
// re-creating anything. Run with: npx ts-node src/fix-perms.ts
// (requires DISCORD_TOKEN + GUILD_ID in .env)
//
// Matrix (mirrors src/lib/guildSync.ts):
// - ticket-logs              -> senior only (Owner/Admin/Manager)
// - mod-logs/staff-chat/stock (+ STAFF category) -> all staff
// - welcome/rules/partnership/announcements/faq/reviews/create-ticket (readonly)
//                            -> @everyone View ALLOW + Send DENY, staff ALLOW Send
// - general-chat/giveaways/bot-commands (open text) -> inherit (clear overwrites)
// - Lounge/Support 1/2 (voice) -> @everyone View+Connect+Speak, Muted DENY
// - Muted -> DENY Send/Reactions/Threads in every text channel, DENY Connect/Speak in voice
// - INFO/CHAT/VOICE categories -> cleared (public); STAFF category -> staff-only

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function overwritesMatch(ch: any, desired: { id: string; allow?: unknown; deny?: unknown }[]): boolean {
  try {
    const cache = ch.permissionOverwrites.cache as Map<string, { allow: { bitfield: bigint }; deny: { bitfield: bigint } }>;
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

const STAFF_NAMES = ['Owner', 'Admin', 'Manager', 'Dev', 'Moderator', 'Mod', 'Staff', 'Support'];
const SENIOR_NAMES = ['Owner', 'Admin', 'Manager'];

const READONLY_NAMES = new Set([
  '👋・welcome',
  '📜・rules',
  '🤝・partnership',
  '📢・announcements',
  '❓・faq',
  '⭐・reviews',
  '🌟・reviews',
  '⭐・leave-a-review',
  '🎫・create-ticket',
]);

const STAFF_ONLY_NAMES = new Set(['📝・mod-logs', '🛡️・staff-chat', '📦・stock']);
const SENIOR_ONLY_NAMES = new Set(['📝・ticket-logs']);
const VOICE_NAMES = new Set(['☕ Lounge', '🎧 Support 1', '🎧 Support 2']);

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once('clientReady', async () => {
    try {
      const guild: any = await client.guilds.fetch(config.guildId);
      await guild.roles.fetch();
      await guild.channels.fetch();
      const everyone = guild.roles.everyone;
      const R = (n: string) => guild.roles.cache.find((r: any) => r.name === n);
      const staff = STAFF_NAMES.map(R).filter(Boolean);
      const senior = SENIOR_NAMES.map(R).filter(Boolean);
      const muted = R('Muted');

      // 0. Role colors / hoist sanity report (live sync performs repairs).
      console.log('[fix] Role positions top->bottom (higher number = higher):');
      for (const [, r] of [...guild.roles.cache.values()].sort((a: any, b: any) => b.position - a.position)) {
        if (r.name === '@everyone') continue;
        console.log(`[fix]   pos=${String(r.position).padStart(3)} hoist=${r.hoist ? 'y' : '-'} #${r.color.toString(16).padStart(6, '0')} ${r.name}`);
      }

      // 1. Categories (incremental: skip when already correct)
      for (const [, c] of guild.channels.cache) {
        if (c.type !== ChannelType.GuildCategory) continue;
        try {
          if (c.name.includes('STAFF')) {
            const want: any[] = [
              { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
              ...staff.map((r: any) => ({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
            ];
            if (overwritesMatch(c, want)) {
              console.log(`[fix] SKIP category: ${c.name} (in sync)`);
              continue;
            }
            await c.permissionOverwrites.set(want);
            console.log(`[fix] OK category: ${c.name} (staff-only)`);
          } else if (c.name.includes('INFO') || c.name.includes('CHAT') || c.name.includes('VOICE') || c.name.includes('TICKETS')) {
            // TICKETS category itself stays public; ticket-logs channel inside stays senior-only.
            if (!c.name.includes('TICKETS')) {
              if (overwritesMatch(c, [])) {
                console.log(`[fix] SKIP category: ${c.name} (in sync)`);
                continue;
              }
              await c.permissionOverwrites.set([]);
              console.log(`[fix] OK category: ${c.name} (public)`);
            }
          }
        } catch (e: any) {
          console.log(`[fix] FAIL category ${c.name} — ${e.message}`);
        }
        await sleep(800);
      }

      // 2. Channels (incremental: skip when already correct)
      for (const [, ch] of guild.channels.cache) {
        if (!('name' in ch)) continue;
        const name = (ch as any).name as string;
        try {
          if (SENIOR_ONLY_NAMES.has(name)) {
            const ow: any[] = [
              { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
              ...senior.map((r: any) => ({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
            ];
            if (muted) ow.push({ id: muted.id, deny: [PermissionFlagsBits.ViewChannel] });
            if (overwritesMatch(ch, ow)) {
              console.log(`[fix] SKIP: ${name} (in sync)`);
              continue;
            }
            await ch.permissionOverwrites.set(ow);
            console.log(`[fix] OK: ${name} (senior-only)`);
          } else if (STAFF_ONLY_NAMES.has(name)) {
            const ow: any[] = [
              { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
              ...staff.map((r: any) => ({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
            ];
            if (muted) ow.push({ id: muted.id, deny: [PermissionFlagsBits.ViewChannel] });
            if (overwritesMatch(ch, ow)) {
              console.log(`[fix] SKIP: ${name} (in sync)`);
              continue;
            }
            await ch.permissionOverwrites.set(ow);
            console.log(`[fix] OK: ${name} (staff-only)`);
          } else if (READONLY_NAMES.has(name)) {
            const ow: any[] = [
              { id: everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions] },
              ...staff.map((r: any) => ({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
            ];
            if (muted) ow.push({ id: muted.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions] });
            if (overwritesMatch(ch, ow)) {
              console.log(`[fix] SKIP: ${name} (in sync)`);
              continue;
            }
            await ch.permissionOverwrites.set(ow);
            console.log(`[fix] OK: ${name} (readonly)`);
          } else if (VOICE_NAMES.has(name) || ch.type === ChannelType.GuildVoice) {
            const ow: any[] = [
              { id: everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
            ];
            if (muted) ow.push({ id: muted.id, deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] });
            if (overwritesMatch(ch, ow)) {
              console.log(`[fix] SKIP: ${name} (in sync)`);
              continue;
            }
            await ch.permissionOverwrites.set(ow);
            console.log(`[fix] OK: ${name} (voice)`);
          } else if (ch.type === ChannelType.GuildText) {
            // Open text channels (general-chat / giveaways / bot-commands / ticket-*):
            // clear to inherit, then re-apply Muted deny below.
            if (!(ch as any).topic?.startsWith?.('ticket:') && !(ch as any).name?.startsWith?.('ticket-')) {
              if (overwritesMatch(ch, [])) {
                console.log(`[fix] SKIP: ${name} (in sync)`);
                continue;
              }
              await ch.permissionOverwrites.set([]);
              console.log(`[fix] OK: ${name} (public text)`);
            }
          }
        } catch (e: any) {
          console.log(`[fix] FAIL: ${name} — ${e.message}`);
        }
        await sleep(1000); // avoid rate limits (only reached on writes/failures; skips continue above)
      }

      // 3. Muted deny everywhere (incremental: only fix channels missing the deny)
      if (muted) {
        let mutedFixed = 0;
        for (const [, ch] of guild.channels.cache) {
          try {
            const ow = (ch as any).permissionOverwrites?.cache?.get(muted.id);
            if (ch.type === ChannelType.GuildVoice) {
              const deny = (() => {
                try {
                  return ow?.deny.bitfield ?? 0n;
                } catch {
                  return 0n;
                }
              })();
              if (ow && (deny & PermissionFlagsBits.Connect) !== 0n && (deny & PermissionFlagsBits.Speak) !== 0n) continue;
              await (ch as any).permissionOverwrites.edit(muted, { Connect: false, Speak: false }).catch(() => {});
              mutedFixed++;
            } else if ((ch as any).isTextBased?.() && !(ch as any).isDMBased?.()) {
              const deny = (() => {
                try {
                  return ow?.deny.bitfield ?? 0n;
                } catch {
                  return 0n;
                }
              })();
              if (ow && (deny & PermissionFlagsBits.SendMessages) !== 0n) continue;
              await (ch as any).permissionOverwrites.edit(muted, {
                SendMessages: false,
                AddReactions: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                SendMessagesInThreads: false,
              }).catch(() => {});
              mutedFixed++;
            }
          } catch {}
        }
        console.log(`[fix] OK: Muted denies checked (fixed ${mutedFixed}, rest in sync)`);
      } else {
        console.log('[fix] WARN: Muted role not found');
      }

      console.log('[fix] DONE');
      process.exit(0);
    } catch (e) {
      console.error('[fix] FAILED', e);
      process.exit(1);
    }
  });
  await client.login(config.token);
}

main();
