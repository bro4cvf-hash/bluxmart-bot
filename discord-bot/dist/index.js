"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const config_1 = require("./config");
const commands_1 = require("./commands");
const guildSync_1 = require("./lib/guildSync");
const botConfig_1 = require("./botConfig");
const transcript_1 = require("./lib/transcript");
const store_1 = require("./store");
const dashboard_1 = require("./dashboard");
const client = new discord_js_1.Client({
    intents: [discord_js_1.GatewayIntentBits.Guilds, discord_js_1.GatewayIntentBits.GuildMessages, discord_js_1.GatewayIntentBits.MessageContent],
});
/** Fetch the complete ticket history before its channel is deleted. */
async function fetchAllMessages(channel) {
    const all = [];
    let before;
    while (true) {
        const page = await channel.messages.fetch({ limit: 100, before });
        const messages = [...page.values()];
        all.push(...messages);
        if (messages.length < 100)
            break;
        const oldest = messages.reduce((candidate, message) => message.id < candidate.id ? message : candidate);
        if (!oldest || oldest.id === before)
            break;
        before = oldest.id;
    }
    return all;
}
async function resolveReviewChannels(guild, setup, sourceChannelId) {
    const submitId = setup?.channels?.review_submit ?? setup?.channels?.reviews ?? undefined;
    let displayId = setup?.channels?.review_display;
    // Never route a review back to the channel used to submit it. In particular,
    // the old `reviews` mapping is a legacy source channel, not a feed channel.
    if (!displayId || displayId === submitId || displayId === sourceChannelId)
        displayId = undefined;
    let display = null;
    if (displayId) {
        const cached = guild.channels.cache.get(displayId);
        const candidate = cached ?? (await guild.channels.fetch(displayId).catch(() => null));
        if (candidate?.isTextBased() && !candidate.isDMBased())
            display = candidate;
    }
    // A name lookup is only a self-healing fallback for the actual feed. Do not
    // fall back to the submission channel's name when the mapping is stale.
    if (!display && !setup) {
        const candidate = guild.channels.cache.find((c) => 'name' in c &&
            c.name === botConfig_1.REVIEW_DISPLAY_CHANNEL_NAME &&
            c.id !== submitId &&
            c.id !== sourceChannelId);
        if (candidate?.isTextBased() && !candidate.isDMBased())
            display = candidate;
    }
    return { submitId, display };
}
async function deployCommands() {
    const rest = new discord_js_1.REST({ version: '10' }).setToken(config_1.config.token);
    if (config_1.config.guildId) {
        await rest.put(discord_js_1.Routes.applicationGuildCommands(config_1.config.clientId, config_1.config.guildId), { body: commands_1.commands });
        console.log('[deploy] Guild commands updated');
    }
    else {
        await rest.put(discord_js_1.Routes.applicationCommands(config_1.config.clientId), { body: commands_1.commands });
        console.log('[deploy] Global commands updated (may take up to 1h to appear)');
    }
}
client.once(discord_js_1.Events.ClientReady, (c) => {
    console.log(`[ready] Logged in as ${c.user.tag}`);
    (0, guildSync_1.syncAllGuilds)(c, 'startup').catch((error) => {
        console.error('[sync] boot sync failed', error);
    });
});
client.on(discord_js_1.Events.GuildCreate, () => {
    // New guilds are reconciled only when they pass the configured allowlist.
    (0, guildSync_1.syncAllGuilds)(client, 'guild joined').catch((error) => {
        console.error('[sync] guild-join sync failed', error);
    });
});
client.on(discord_js_1.Events.GuildMemberAdd, async (member) => {
    const setup = await (0, store_1.getGuildSetup)(member.guild.id).catch(() => null);
    if (!setup)
        return;
    try {
        if (setup.autoRoleId)
            await member.roles.add(setup.autoRoleId).catch(() => { });
        // Member only (you removed Customer from verify)
        const ch = member.guild.channels.cache.get(setup.welcomeChannelId ?? '');
        if (ch?.isTextBased()) {
            const e = new discord_js_1.EmbedBuilder()
                .setTitle(`Welcome ${member.user.username}! 👋`)
                .setColor(0x5865f2)
                .setDescription(`You're member **#${member.guild.memberCount}**. Check rules and say hi!`)
                .setThumbnail(member.user.displayAvatarURL());
            await ch.send({ content: `${member}`, embeds: [e] }).catch(() => { });
        }
    }
    catch (e) {
        console.error('[welcome]', e);
    }
});
client.on(discord_js_1.Events.InteractionCreate, async (interaction) => {
    try {
        // Review stars select -> open modal for reason
        if (interaction.isStringSelectMenu() && interaction.customId === 'review_stars') {
            try {
                const rating = interaction.values[0] ?? '5';
                const modal = new discord_js_1.ModalBuilder().setCustomId(`review_modal_${rating}`).setTitle(`Review — ${rating} star${rating === '1' ? '' : 's'}`);
                const why = new discord_js_1.TextInputBuilder()
                    .setCustomId('review_text')
                    .setLabel('Why this rating? What do you think?')
                    .setStyle(discord_js_1.TextInputStyle.Paragraph)
                    .setPlaceholder('I bought ... delivery was fast because ...')
                    .setMinLength(5)
                    .setMaxLength(1000)
                    .setRequired(true);
                modal.addComponents(new discord_js_1.ActionRowBuilder().addComponents(why));
                await interaction.showModal(modal);
            }
            catch {
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
            }
            catch {
                return;
            }
            const reply = async (content) => {
                await interaction.editReply({ content }).catch(() => { });
            };
            const gm = await guild.members.fetch(interaction.user.id).catch(() => null);
            const hasCustomer = gm?.roles.cache.some((r) => r.name === 'Customer');
            if (!hasCustomer) {
                await reply('❌ Only **Customer** rank can review. Buy something first and ask staff for Customer.');
                return;
            }
            const stars = '⭐'.repeat(Math.max(1, Math.min(5, parseInt(rating) || 5)));
            const embed = new discord_js_1.EmbedBuilder()
                .setTitle(`${stars} ${rating}/5 — ${interaction.user.username}`)
                .setColor(0xf1c40f)
                .setDescription(text)
                .setThumbnail(interaction.user.displayAvatarURL())
                .setFooter({ text: `Customer review • ${new Date().toLocaleDateString()}` });
            let setup = await (0, store_1.getGuildSetup)(guild.id).catch(() => null);
            let reviewState = await resolveReviewChannels(guild, setup, interaction.channelId);
            // If the old single-review setup is still in place, finish the migration
            // before publishing. The review is never posted through interaction.reply().
            if (!reviewState.display) {
                await (0, guildSync_1.queueGuildSync)(guild, 'review feed self-heal');
                setup = await (0, store_1.getGuildSetup)(guild.id).catch(() => null);
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
            }
            catch (error) {
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
            }
            if (interaction.customId.startsWith('ticket_') && interaction.customId !== 'ticket_close') {
                // Defer immediately — channel creation can exceed the 3s reply window
                try {
                    await interaction.deferReply({ ephemeral: true });
                }
                catch {
                    return; // interaction already expired
                }
                const type = (await (0, guildSync_1.ticketTypeFromIdLive)(interaction.customId).catch(() => undefined)) ?? (0, guildSync_1.ticketTypeFromId)(interaction.customId);
                if (!type) {
                    await interaction.editReply({ content: '❌ Unknown ticket type.' }).catch(() => { });
                    return;
                }
                const kind = interaction.customId.replace('ticket_', ''); // bug, claim, general...
                const setup = await (0, store_1.getGuildSetup)(interaction.guildId);
                const guild = interaction.guild;
                const topic = `ticket:${kind}:${interaction.user.id}`;
                const existing = guild.channels.cache.find((c) => c.isTextBased() && !c.isDMBased() && c.topic === topic);
                if (existing) {
                    await interaction.editReply({ content: `You already have ${existing}` }).catch(() => { });
                    return;
                }
                // Max 3 open tickets per user (all types combined)
                const MAX_TICKETS = 3;
                const userTickets = guild.channels.cache.filter((c) => c.isTextBased() &&
                    !c.isDMBased() &&
                    c.topic?.startsWith('ticket:') &&
                    c.topic?.endsWith(`:${interaction.user.id}`));
                if (userTickets.size >= MAX_TICKETS) {
                    const list = [...userTickets.values()]
                        .map((c) => `${c}`)
                        .join(', ');
                    await interaction
                        .editReply({
                        content: `❌ You already have ${userTickets.size} open tickets (${list}). Close one before opening another.`,
                    })
                        .catch(() => { });
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
                const overwrites = [
                    { id: guild.roles.everyone.id, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory] },
                ];
                for (const r of staffRoles)
                    overwrites.push({ id: r.id, allow: [discord_js_1.PermissionFlagsBits.ViewChannel, discord_js_1.PermissionFlagsBits.SendMessages, discord_js_1.PermissionFlagsBits.ReadMessageHistory] });
                const channel = await guild.channels.create({
                    name: base,
                    type: discord_js_1.ChannelType.GuildText,
                    parent: setup?.ticketCategoryId ?? undefined,
                    topic,
                    permissionOverwrites: overwrites,
                    reason: `${type.label} opened by ${interaction.user.tag}`,
                });
                const closeRow = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(discord_js_1.ButtonStyle.Danger).setEmoji('🔒'));
                const tpl = await (0, botConfig_1.getTemplate)().catch(() => null);
                const prompts = tpl?.ticketPrompts ?? {
                    bug: 'Describe the bug + attach screenshots + order ID if purchase-related.',
                    claim: 'Send your **order ID + username + proof of payment**. Staff will deliver here.',
                    general: 'Describe your issue (payment, delivery, site).',
                    staff: 'Staff report is **private to Admins**. Provide user, proof, what happened.',
                    partner: 'Tell us about your server/store, members, what partnership you want.',
                };
                await channel.send({
                    content: `${supportRole ?? 'Support'} — new ${type.label} ticket from **${interaction.user.username}**.`,
                    embeds: [new discord_js_1.EmbedBuilder().setTitle(`${type.emoji} ${type.label}`).setDescription(prompts[kind] ?? 'Describe your issue.').setColor(0xe67e22)],
                    components: [closeRow],
                });
                // log to ticket-logs if exists (no pings — plain text so owner isn't pinged)
                if (setup) {
                    const logCh = guild.channels.cache.get(setup.channels['ticketlogs']);
                    if (logCh?.isTextBased()) {
                        await logCh.send({ embeds: [new discord_js_1.EmbedBuilder().setTitle('🎫 Ticket opened').setDescription(`#${channel.name} • ${type.label} • ${interaction.user.username}`).setColor(0x3498db)] }).catch(() => { });
                    }
                }
                await interaction.editReply({ content: `Ticket created: ${channel}` }).catch(() => { });
                return;
            }
            if (interaction.customId === 'ticket_close') {
                if (!interaction.channel?.isTextBased() || interaction.channel.isDMBased())
                    return;
                const ch0 = interaction.channel;
                // Only work inside actual ticket channels — ignore Close pressed in the panel itself
                if (!ch0.name.startsWith('ticket-')) {
                    await interaction.reply({ content: '❌ Use this button inside a ticket channel.', ephemeral: true }).catch(() => { });
                    return;
                }
                let deferred = false;
                try {
                    await interaction.deferReply({ ephemeral: true });
                    deferred = true;
                }
                catch {
                    // token expired — still log the transcript below, just no reply
                }
                const say = async (m) => {
                    if (deferred)
                        await interaction.editReply(m).catch(() => { });
                };
                try {
                    const ch = interaction.channel;
                    // Build one PDF transcript from the complete ticket history.
                    const msgList = await fetchAllMessages(ch).catch(() => []);
                    const setup = await (0, store_1.getGuildSetup)(interaction.guildId).catch(() => null);
                    const guild = interaction.guild;
                    const logCh = setup ? guild.channels.cache.get(setup.channels['ticketlogs']) : undefined;
                    if (logCh?.isTextBased()) {
                        const closer = `${interaction.user.username}`;
                        const embed = new discord_js_1.EmbedBuilder()
                            .setTitle(`🔒 Ticket closed: #${ch.name}`)
                            .setColor(0x95a5a6)
                            .setDescription(`Closed by ${closer}\nTicket: #${ch.name}\nMessages: ${msgList.length}`)
                            .setTimestamp();
                        await logCh.send({ embeds: [embed] }).catch((e) => console.error('[close] log embed fail', e.message));
                        if (msgList.length > 0) {
                            try {
                                const roleMap = new Map();
                                for (const [, r] of guild.roles.cache)
                                    roleMap.set(r.id, r.name);
                                const chanMap = new Map();
                                for (const [, c] of guild.channels.cache)
                                    if ('name' in c)
                                        chanMap.set(c.id, c.name);
                                const openerId = (ch.topic ?? '').startsWith('ticket:') ? ch.topic.split(':')[2] ?? '' : '';
                                let openerTag = 'unknown';
                                if (openerId) {
                                    const om = await guild.members.fetch(openerId).catch(() => null);
                                    if (om)
                                        openerTag = om.user.username ?? om.user.globalName ?? 'unknown';
                                }
                                const file = await (0, transcript_1.buildTranscriptFile)(msgList, { users: new Map(), roles: roleMap, channels: chanMap }, {
                                    channelName: ch.name,
                                    channelId: ch.id,
                                    openedByTag: openerTag,
                                    openedById: openerId || 'unknown',
                                    closedByTag: interaction.user.username,
                                    closedById: interaction.user.id,
                                    closedAtHuman: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
                                });
                                await logCh
                                    .send({ files: [{ attachment: file.data, name: file.name }] })
                                    .catch((e) => console.error('[close] log file fail', e.message));
                            }
                            catch (e) {
                                console.error('[close] transcript build fail', e);
                            }
                        }
                    }
                    else {
                        // Log channel missing (deleted manually?): heal in background, still close the ticket.
                        (0, guildSync_1.queueGuildSync)(guild, 'ticket-log self-heal').catch((error) => {
                            console.error('[sync] ticket-log self-heal failed', error);
                        });
                        await say({ content: '⚠️ No ticket-logs channel right now (auto-sync will recreate it). Deleting anyway in 3s...' });
                    }
                    await say({ content: 'Closing + logged. Deleting in 3s...' });
                }
                catch (e) {
                    console.error('[close]', e);
                    await say({ content: 'Error logging, deleting in 3s...' });
                }
                setTimeout(() => interaction.channel?.delete().catch(() => { }), 3000);
                return;
            }
            return;
        }
        if (!interaction.isChatInputCommand())
            return;
        if (interaction.commandName === 'ping') {
            await interaction.reply(`Pong! ${client.ws.ping}ms`);
            return;
        }
    }
    catch (e) {
        console.error('[interaction]', e);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true }).catch(() => { });
        }
    }
});
async function main() {
    if (!config_1.config.token || !config_1.config.clientId) {
        console.error('Missing DISCORD_TOKEN / CLIENT_ID. Copy .env.example to .env first.');
        process.exit(1);
    }
    (0, dashboard_1.setBotClient)(client);
    (0, guildSync_1.watchTemplateChanges)(client);
    // Dashboard starts before login so admin UI works even while Discord reconnects.
    await (0, dashboard_1.startDashboard)().catch((e) => console.error('[dashboard-failed]', e));
    await deployCommands().catch((e) => console.error('[deploy-failed]', e));
    await client.login(config_1.config.token);
}
main();
