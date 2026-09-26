import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Guild,
  ModalBuilder,
  type Message,
  PermissionFlagsBits,
  REST,
  Routes,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from './config';
import { commands } from './commands';
import {
  queueGuildSync,
  syncAllGuilds,
  ticketTypeFromId,
  ticketTypeFromIdLive,
  watchTemplateChanges,
} from './lib/guildSync';
import { getTemplate, REVIEW_DISPLAY_CHANNEL_NAME } from './botConfig';
import { buildTranscriptFile } from './lib/transcript';
import { getGuildSetup, type GuildSetup } from './store';
import { setBotClient, startDashboard } from './dashboard';
import {
  cacheGuildInvites,
  getMemberInviteStats,
  handleMemberJoinWithInvite,
  MIN_INVITES_TO_CLAIM,
  registerInviteTrackerEvents,
  REWARD_PER_INVITE_MILLIONS,
} from './lib/inviteTracker';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
registerInviteTrackerEvents(client);

/** Fetch the complete ticket history before its channel is deleted. */
async function fetchAllMessages(channel: TextChannel): Promise<Message[]> {
  const all: Message[] = [];
  let before: string | undefined;

  while (true) {
    const page = await channel.messages.fetch({ limit: 100, before });
    const messages = [...page.values()];
    all.push(...messages);
    if (messages.length < 100) break;

    const oldest = messages.reduce((candidate, message) => message.id < candidate.id ? message : candidate);
    if (!oldest || oldest.id === before) break;
    before = oldest.id;
  }

  return all;
}

type ReviewChannelState = {
  submitId?: string;
  display: TextChannel | null;
};

async function resolveReviewChannels(
  guild: Guild,
  setup: GuildSetup | null,
  sourceChannelId?: string | null,
): Promise<ReviewChannelState> {
  const submitId = setup?.channels?.review_submit ?? setup?.channels?.reviews ?? undefined;
  let displayId = setup?.channels?.review_display;

  // Never route a review back to the channel used to submit it. In particular,
  // the old `reviews` mapping is a legacy source channel, not a feed channel.
  if (!displayId || displayId === submitId || displayId === sourceChannelId) displayId = undefined;

  let display: TextChannel | null = null;
  if (displayId) {
    const cached = guild.channels.cache.get(displayId);
    const candidate = cached ?? (await guild.channels.fetch(displayId).catch(() => null));
    if (candidate?.isTextBased() && !candidate.isDMBased()) display = candidate as TextChannel;
  }

  // A name lookup is only a self-healing fallback for the actual feed. Do not
  // fall back to the submission channel's name when the mapping is stale.
  if (!display && !setup) {
    const candidate = guild.channels.cache.find(
      (c) =>
        'name' in c &&
        (c as any).name === REVIEW_DISPLAY_CHANNEL_NAME &&
        c.id !== submitId &&
        c.id !== sourceChannelId
    );
    if (candidate?.isTextBased() && !candidate.isDMBased()) display = candidate as TextChannel;
  }

  return { submitId, display };
}

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
    console.log('[deploy] Guild commands updated');
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('[deploy] Global commands updated (may take up to 1h to appear)');
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`[ready] Logged in as ${c.user.tag}`);
  for (const [, g] of c.guilds.cache) {
    cacheGuildInvites(g).catch(() => {});
  }
  syncAllGuilds(c, 'startup').catch((error) => {
    console.error('[sync] boot sync failed', error);
  });
});

client.on(Events.GuildCreate, (guild) => {
  cacheGuildInvites(guild).catch(() => {});
  // New guilds are reconciled only when they pass the configured allowlist.
  syncAllGuilds(client, 'guild joined').catch((error) => {
    console.error('[sync] guild-join sync failed', error);
  });
});

client.on(Events.GuildMemberAdd, async (member) => {
  await handleMemberJoinWithInvite(member);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Review stars select -> open modal for reason
    if (interaction.isStringSelectMenu() && interaction.customId === 'review_stars') {
      try {
        const rating = interaction.values[0] ?? '5';
        const modal = new ModalBuilder().setCustomId(`review_modal_${rating}`).setTitle(`Review — ${rating} star${rating === '1' ? '' : 's'}`);
        const why = new TextInputBuilder()
          .setCustomId('review_text')
          .setLabel('Why this rating? What do you think?')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('I bought ... delivery was fast because ...')
          .setMinLength(5)
          .setMaxLength(1000)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(why));
        await interaction.showModal(modal);
      } catch {
        // interaction expired (user waited too long) — safe to ignore
      }
      return;
    }
    // Review modal submit -> post to the dedicated display channel (Customer only)
    if (interaction.isModalSubmit() && interaction.customId.startsWith('review_modal_')) {
      const rating = interaction.customId.replace('review_modal_', '');
      const text = interaction.fields.getTextInputValue('review_text').trim();
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: '❌ Reviews can only be posted from a server.', ephemeral: true });
        return;
      }

      // Repairing a missing feed can take longer than Discord's initial reply
      // window, so defer before doing any setup work.
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch {
        return;
      }
      const reply = async (content: string) => {
        await interaction.editReply({ content }).catch(() => {});
      };

      const gm = await guild.members.fetch(interaction.user.id).catch(() => null);
      const hasCustomer = gm?.roles.cache.some((r) => r.name === 'Customer');
      if (!hasCustomer) {
        await reply('❌ Only **Customer** rank can review. Buy something first and ask staff for Customer.');
        return;
      }

      const stars = '⭐'.repeat(Math.max(1, Math.min(5, parseInt(rating) || 5)));
      const embed = new EmbedBuilder()
        .setTitle(`${stars} ${rating}/5 — ${interaction.user.username}`)
        .setColor(0xf1c40f)
        .setDescription(text)
        .setThumbnail(interaction.user.displayAvatarURL())
        .setFooter({ text: `Customer review • ${new Date().toLocaleDateString()}` });

      let setup = await getGuildSetup(guild.id).catch(() => null);
      let reviewState = await resolveReviewChannels(guild, setup, interaction.channelId);

      // If the old single-review setup is still in place, finish the migration
      // before publishing. The review is never posted through interaction.reply().
      if (!reviewState.display) {
        await queueGuildSync(guild, 'review feed self-heal');
        setup = await getGuildSetup(guild.id).catch(() => null);
        reviewState = await resolveReviewChannels(guild, setup, interaction.channelId);
      }

      const display = reviewState.display;
      if (!display) {
        await reply('⚠️ The review feed is not ready yet. Live sync will retry automatically; check the bot log for permission errors.');
        return;
      }

      try {
        await display.send({ embeds: [embed] });
        await reply(`✅ Thanks! Your review was posted in ${display}.`);
      } catch (error) {
        console.error('[review] destination send failed', error);
        await reply('⚠️ Your review could not be published. Please try again later.');
      }
      return;
    }
    // Ticket buttons
    if (interaction.isButton()) {
      if (interaction.customId === 'verify_click') {
        await interaction.reply({ content: 'Verify removed — you already have access.', ephemeral: true });
        return;
      }      if (interaction.customId.startsWith('ticket_') && interaction.customId !== 'ticket_close') {
        // Defer immediately — channel creation can exceed the 3s reply window
        try {
          await interaction.deferReply({ ephemeral: true });
        } catch {
          return; // interaction already expired
        }
        const type = (await ticketTypeFromIdLive(interaction.customId).catch(() => undefined)) ?? ticketTypeFromId(interaction.customId);
        if (!type) {
          await interaction.editReply({ content: '❌ Unknown ticket type.' }).catch(() => {});
          return;
        }
        const kind = interaction.customId.replace('ticket_', ''); // bug, claim, general...
        const setup = await getGuildSetup(interaction.guildId!);
        const guild = interaction.guild!;
        const topic = `ticket:${kind}:${interaction.user.id}`;
        const existing = guild.channels.cache.find(
          (c) => c.isTextBased() && !c.isDMBased() && (c as TextChannel).topic === topic
        );
        if (existing) {
          await interaction.editReply({ content: `You already have ${existing}` }).catch(() => {});
          return;
        }
        // Max 3 open tickets per user (all types combined)
        const MAX_TICKETS = 3;
        const userTickets = guild.channels.cache.filter(
          (c) =>
            c.isTextBased() &&
            !c.isDMBased() &&
            (c as TextChannel).topic?.startsWith('ticket:') &&
            (c as TextChannel).topic?.endsWith(`:${interaction.user.id}`)
        );
        if (userTickets.size >= MAX_TICKETS) {
          const list = [...userTickets.values()]
            .map((c) => `${c}`)
            .join(', ');
          await interaction
            .editReply({
              content: `❌ You already have ${userTickets.size} open tickets (${list}). Close one before opening another.`,
            })
            .catch(() => {});
          return;
        }
        const base = `ticket-${kind}-${interaction.user.username}-${interaction.user.id.slice(-4)}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
        // Staff Report tickets are private to senior staff only (Owner/Admin/Manager) so
        // reported Mod/Staff/Support cannot see them. All other ticket kinds -> all staff.
        const isStaffReport = kind === 'staff';
        const staffNames = isStaffReport
          ? ['Owner', 'Admin', 'Manager']
          : ['Owner', 'Admin', 'Manager', 'Dev', 'Moderator', 'Mod', 'Staff', 'Support'];
        const staffRoles = staffNames.map((n) => guild.roles.cache.find((r) => r.name === n)).filter(Boolean);
        const supportRole = isStaffReport
          ? (guild.roles.cache.find((r) => r.name === 'Admin') ?? guild.roles.cache.find((r) => r.name === 'Owner'))
          : (guild.roles.cache.find((r) => r.name === 'Support') ?? guild.roles.cache.find((r) => r.name === 'Staff'));
        const overwrites: any[] = [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ];
        for (const r of staffRoles) overwrites.push({ id: (r as any).id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });

        const channel = await guild.channels.create({
          name: base,
          type: ChannelType.GuildText,
          parent: setup?.ticketCategoryId ?? undefined,
          topic,
          permissionOverwrites: overwrites,
          reason: `${type.label} opened by ${interaction.user.tag}`,
        });
        const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
        );
        const tpl = await getTemplate().catch(() => null);
        const prompts: Record<string, string> = tpl?.ticketPrompts ?? {
          bug: 'Describe the bug + attach screenshots + order ID if purchase-related.',
          claim: 'Send your **order ID + username + proof of payment**. Staff will deliver here.',
          general: 'Describe your issue (payment, delivery, site).',
          staff: 'Staff report is **private to Admins**. Provide user, proof, what happened.',
          partner: 'Tell us about your server/store, members, what partnership you want.',
        };
        await channel.send({
          content: `${supportRole ?? 'Support'} — new ${type.label} ticket from **${interaction.user.username}**.`,
          embeds: [new EmbedBuilder().setTitle(`${type.emoji} ${type.label}`).setDescription(prompts[kind] ?? 'Describe your issue.').setColor(0xe67e22)],
          components: [closeRow],
        });
        // log to ticket-logs if exists (no pings — plain text so owner isn't pinged)
        if (setup) {
          const logCh = guild.channels.cache.get((setup.channels as any)['ticketlogs']) as TextChannel | undefined;
          if (logCh?.isTextBased()) {
            await logCh.send({ embeds: [new EmbedBuilder().setTitle('🎫 Ticket opened').setDescription(`#${channel.name} • ${type.label} • ${interaction.user.username}`).setColor(0x3498db)] }).catch(() => {});
          }
        }
        await interaction.editReply({ content: `Ticket created: ${channel}` }).catch(() => {});
        return;
      }
      if (interaction.customId === 'ticket_close') {
        if (!interaction.channel?.isTextBased() || interaction.channel.isDMBased()) return;
        const ch0 = interaction.channel as TextChannel;
        // Only work inside actual ticket channels — ignore Close pressed in the panel itself
        if (!ch0.name.startsWith('ticket-')) {
          await interaction.reply({ content: '❌ Use this button inside a ticket channel.', ephemeral: true }).catch(() => {});
          return;
        }
        let deferred = false;
        try {
          await interaction.deferReply({ ephemeral: true });
          deferred = true;
        } catch {
          // token expired — still log the transcript below, just no reply
        }
        const say = async (m: any) => {
          if (deferred) await interaction.editReply(m).catch(() => {});
        };
        try {
          const ch = interaction.channel as TextChannel;
          // Build one PDF transcript from the complete ticket history.
          const msgList = await fetchAllMessages(ch).catch(() => []);
          const setup = await getGuildSetup(interaction.guildId!).catch(() => null);
          const guild = interaction.guild!;
          const logCh = setup ? (guild.channels.cache.get((setup.channels as any)['ticketlogs']) as TextChannel | undefined) : undefined;

          if (logCh?.isTextBased()) {
            const closer = `${interaction.user.username}`;
            const embed = new EmbedBuilder()
              .setTitle(`🔒 Ticket closed: #${ch.name}`)
              .setColor(0x95a5a6)
              .setDescription(`Closed by ${closer}\nTicket: #${ch.name}\nMessages: ${msgList.length}`)
              .setTimestamp();
            await logCh.send({ embeds: [embed] }).catch((e) => console.error('[close] log embed fail', e.message));
            if (msgList.length > 0) {
              try {
                const roleMap = new Map<string, string>();
                for (const [, r] of guild.roles.cache) roleMap.set(r.id, (r as any).name);
                const chanMap = new Map<string, string>();
                for (const [, c] of guild.channels.cache) if ('name' in c) chanMap.set(c.id, (c as any).name);
                const openerId = (ch.topic ?? '').startsWith('ticket:') ? (ch.topic as string).split(':')[2] ?? '' : '';
                let openerTag = 'unknown';
                if (openerId) {
                  const om = await guild.members.fetch(openerId).catch(() => null);
                  if (om) openerTag = (om as any).user.username ?? (om as any).user.globalName ?? 'unknown';
                }
                const file = await buildTranscriptFile(
                  msgList,
                  { users: new Map(), roles: roleMap, channels: chanMap },
                  {
                    channelName: ch.name,
                    channelId: ch.id,
                    openedByTag: openerTag,
                    openedById: openerId || 'unknown',
                    closedByTag: interaction.user.username,
                    closedById: interaction.user.id,
                    closedAtHuman: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
                  }
                );
                await logCh
                  .send({ files: [{ attachment: file.data, name: file.name }] })
                  .catch((e) => console.error('[close] log file fail', e.message));
              } catch (e) {
                console.error('[close] transcript build fail', e);
              }
            }
          } else {
            // Log channel missing (deleted manually?): heal in background, still close the ticket.
            queueGuildSync(guild, 'ticket-log self-heal').catch((error) => {
              console.error('[sync] ticket-log self-heal failed', error);
            });
            await say({ content: '⚠️ No ticket-logs channel right now (auto-sync will recreate it). Deleting anyway in 3s...' });
          }
          await say({ content: 'Closing + logged. Deleting in 3s...' });
        } catch (e) {
          console.error('[close]', e);
          await say({ content: 'Error logging, deleting in 3s...' });
        }
        setTimeout(() => interaction.channel?.delete().catch(() => {}), 3000);
        return;
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
      await interaction.reply(`Pong! ${client.ws.ping}ms`);
      return;
    }

    if (interaction.commandName === 'invites') {
      if (!interaction.guildId) {
        await interaction.reply({ content: '❌ Use this command inside a server.', ephemeral: true });
        return;
      }
      const targetUser = interaction.options.getUser('user') ?? interaction.user;
      const stats = await getMemberInviteStats(interaction.guildId, targetUser.id);
      const setup = await getGuildSetup(interaction.guildId).catch(() => null);
      const rewardChId = setup?.channels?.['invite_reward'];
      const ticketChId = setup?.channels?.['tickets'];

      const statusLine = stats.canClaim
        ? `✅ **Ready to Claim!** Open an **📦 Item Claim** ticket${ticketChId ? ` in <#${ticketChId}>` : ''} to claim **${stats.rewardMillions}M Coins**! 🎉`
        : `⏳ Need **${stats.neededForClaim} more valid invite${stats.neededForClaim === 1 ? '' : 's'}** to reach the **${MIN_INVITES_TO_CLAIM} invite minimum** (**${MIN_INVITES_TO_CLAIM * REWARD_PER_INVITE_MILLIONS}M Coins**).`;

      const embed = new EmbedBuilder()
        .setTitle(`📊 Invite Tracker — ${targetUser.username}`)
        .setColor(stats.canClaim ? 0x2ecc71 : 0xf1c40f)
        .setThumbnail(targetUser.displayAvatarURL())
        .setDescription(
          [
            `👤 **User:** ${targetUser}`,
            `✅ **Valid Invites:** **${stats.valid}** (**${stats.rewardMillions}M Coins**)`,
            '',
            `• **Regular (Total):** ${stats.regular}`,
            `• **Fake (< 2mo old):** ${stats.fake}`,
            `• **Left Server:** ${stats.left}`,
            `• **Pending (< 2h in server):** ${stats.pending}`,
            '',
            statusLine,
            rewardChId ? `• **Reward Rules:** <#${rewardChId}>` : '',
          ]
            .filter(Boolean)
            .join('\n')
        );

      await interaction.reply({ embeds: [embed] });
      return;
    }

  } catch (e) {
    console.error('[interaction]', e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

async function main() {
  if (!config.token || !config.clientId) {
    console.error('Missing DISCORD_TOKEN / CLIENT_ID. Copy .env.example to .env first.');
    process.exit(1);
  }
  setBotClient(client);
  watchTemplateChanges(client);
  // Dashboard starts before login so admin UI works even while Discord reconnects.
  await startDashboard().catch((e) => console.error('[dashboard-failed]', e));
  await deployCommands().catch((e) => console.error('[deploy-failed]', e));
  await client.login(config.token);
}

main();

