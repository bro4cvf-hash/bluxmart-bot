"use strict";
const path = require("path");
const Module = require("module");

// Allow resolving discord.js, express, pdf-lib, dotenv from wisp-bot/node_modules, ../node_modules, or ../../bluxbot-deploy-safe/node_modules
const extraNodeModules = [
  path.resolve(__dirname, "../../node_modules"),
  path.resolve(__dirname, "../../../node_modules"),
  path.resolve(__dirname, "../../../bluxbot-deploy-safe/node_modules"),
];
const origNodeModulePaths = Module._nodeModulePaths;
Module._nodeModulePaths = function (from) {
  const paths = origNodeModulePaths.call(this, from);
  return [...paths, ...extraNodeModules];
};
module.paths.push(...extraNodeModules);

const discord_js_1 = require("discord.js");
const commands_1 = require("./commands");
const guildSync_1 = require("./lib/guildSync");
const botConfig_1 = require("./botConfig");
const transcript_1 = require("./lib/transcript");
const store_1 = require("./store");
const dashboard_1 = require("./dashboard");

let activeClient = null;
let lastError = null;
let isStarting = false;
let dashboardStarted = false;
let runtimeCredentials = {
  token: process.env.DISCORD_TOKEN || "",
  clientId: process.env.CLIENT_ID || "",
  guildId: process.env.GUILD_ID || "",
};

async function fetchAllMessages(channel) {
  const all = [];
  let before;
  while (true) {
    const page = await channel.messages.fetch({ limit: 100, before });
    const messages = [...page.values()];
    all.push(...messages);
    if (messages.length < 100) break;
    const oldest = messages.reduce((candidate, message) =>
      message.id < candidate.id ? message : candidate
    );
    if (!oldest || oldest.id === before) break;
    before = oldest.id;
  }
  return all;
}

async function resolveReviewChannels(guild, setup, sourceChannelId) {
  const submitId = setup?.channels?.review_submit ?? setup?.channels?.reviews ?? undefined;
  let displayId = setup?.channels?.review_display;
  if (!displayId || displayId === submitId || displayId === sourceChannelId) {
    displayId = undefined;
  }
  let display = null;
  if (displayId) {
    const cached = guild.channels.cache.get(displayId);
    const candidate = cached ?? (await guild.channels.fetch(displayId).catch(() => null));
    if (candidate?.isTextBased() && !candidate.isDMBased()) display = candidate;
  }
  if (!display && !setup) {
    const candidate = guild.channels.cache.find(
      (c) =>
        "name" in c &&
        c.name === botConfig_1.REVIEW_DISPLAY_CHANNEL_NAME &&
        c.id !== submitId &&
        c.id !== sourceChannelId
    );
    if (candidate?.isTextBased() && !candidate.isDMBased()) display = candidate;
  }
  return { submitId, display };
}

async function deployCommands(token, clientId, guildId) {
  const rest = new discord_js_1.REST({ version: "10" }).setToken(token);
  if (guildId) {
    await rest.put(discord_js_1.Routes.applicationGuildCommands(clientId, guildId), {
      body: commands_1.commands,
    });
    console.log("[Discord Bot] Guild slash commands updated");
  } else {
    await rest.put(discord_js_1.Routes.applicationCommands(clientId), {
      body: commands_1.commands,
    });
    console.log("[Discord Bot] Global slash commands updated");
  }
}

function createDiscordClient() {
  const client = new discord_js_1.Client({
    intents: [
      discord_js_1.GatewayIntentBits.Guilds,
      discord_js_1.GatewayIntentBits.GuildMessages,
      discord_js_1.GatewayIntentBits.MessageContent,
    ],
  });

  client.once(discord_js_1.Events.ClientReady, (c) => {
    console.log(`[Discord Bot] Logged in as ${c.user.tag}`);
    lastError = null;
    (0, guildSync_1.syncAllGuilds)(c, "startup").catch((error) => {
      console.error("[Discord Bot] boot sync failed", error);
    });
  });

  client.on(discord_js_1.Events.GuildCreate, () => {
    (0, guildSync_1.syncAllGuilds)(client, "guild joined").catch((error) => {
      console.error("[Discord Bot] guild-join sync failed", error);
    });
  });

  client.on(discord_js_1.Events.GuildMemberAdd, async (member) => {
    const setup = await (0, store_1.getGuildSetup)(member.guild.id).catch(() => null);
    if (!setup) return;
    try {
      if (setup.autoRoleId) await member.roles.add(setup.autoRoleId).catch(() => {});
      const ch = member.guild.channels.cache.get(setup.welcomeChannelId ?? "");
      if (ch?.isTextBased()) {
        const e = new discord_js_1.EmbedBuilder()
          .setTitle(`Welcome ${member.user.username}! 👋`)
          .setColor(0x5865f2)
          .setDescription(`You're member **#${member.guild.memberCount}**. Check rules and say hi!`)
          .setThumbnail(member.user.displayAvatarURL());
        await ch.send({ content: `${member}`, embeds: [e] }).catch(() => {});
      }
    } catch (e) {
      console.error("[Discord Bot welcome]", e);
    }
  });

  client.on(discord_js_1.Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isStringSelectMenu() && interaction.customId === "review_stars") {
        try {
          const rating = interaction.values[0] ?? "5";
          const modal = new discord_js_1.ModalBuilder()
            .setCustomId(`review_modal_${rating}`)
            .setTitle(`Review — ${rating} star${rating === "1" ? "" : "s"}`);
          const why = new discord_js_1.TextInputBuilder()
            .setCustomId("review_text")
            .setLabel("Why this rating? What do you think?")
            .setStyle(discord_js_1.TextInputStyle.Paragraph)
            .setPlaceholder("I bought ... delivery was fast because ...")
            .setMinLength(5)
            .setMaxLength(1000)
            .setRequired(true);
          modal.addComponents(new discord_js_1.ActionRowBuilder().addComponents(why));
          await interaction.showModal(modal);
        } catch {}
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith("review_modal_")) {
        const rating = interaction.customId.replace("review_modal_", "");
        const text = interaction.fields.getTextInputValue("review_text").trim();
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({ content: "❌ Reviews can only be posted from a server.", ephemeral: true });
          return;
        }
        try {
          await interaction.deferReply({ ephemeral: true });
        } catch {
          return;
        }
        const reply = async (content) => {
          await interaction.editReply({ content }).catch(() => {});
        };
        const gm = await guild.members.fetch(interaction.user.id).catch(() => null);
        const hasCustomer = gm?.roles.cache.some((r) => r.name === "Customer");
        if (!hasCustomer) {
          await reply("❌ Only **Customer** rank can review. Buy something first and ask staff for Customer.");
          return;
        }
        const stars = "⭐".repeat(Math.max(1, Math.min(5, parseInt(rating) || 5)));
        const embed = new discord_js_1.EmbedBuilder()
          .setTitle(`${stars} ${rating}/5 — ${interaction.user.username}`)
          .setColor(0xf1c40f)
          .setDescription(text)
          .setThumbnail(interaction.user.displayAvatarURL())
          .setFooter({ text: `Customer review • ${new Date().toLocaleDateString()}` });

        let setup = await (0, store_1.getGuildSetup)(guild.id).catch(() => null);
        let reviewState = await resolveReviewChannels(guild, setup, interaction.channelId);
        if (!reviewState.display) {
          await (0, guildSync_1.queueGuildSync)(guild, "review feed self-heal");
          setup = await (0, store_1.getGuildSetup)(guild.id).catch(() => null);
          reviewState = await resolveReviewChannels(guild, setup, interaction.channelId);
        }
        const display = reviewState.display;
        if (!display) {
          await reply("⚠️ The review feed is not ready yet. Live sync will retry automatically.");
          return;
        }
        try {
          await display.send({ embeds: [embed] });
          await reply(`✅ Thanks! Your review was posted in ${display}.`);
        } catch (error) {
          await reply("⚠️ Your review could not be published. Please try again later.");
        }
        return;
      }

      if (interaction.isButton()) {
        if (interaction.customId === "verify_click") {
          await interaction.reply({ content: "Verify removed — you already have access.", ephemeral: true });
          return;
        }
        if (interaction.customId.startsWith("ticket_") && interaction.customId !== "ticket_close") {
          try {
            await interaction.deferReply({ ephemeral: true });
          } catch {
            return;
          }
          const type =
            (await (0, guildSync_1.ticketTypeFromIdLive)(interaction.customId).catch(() => undefined)) ??
            (0, guildSync_1.ticketTypeFromId)(interaction.customId);
          if (!type) {
            await interaction.editReply({ content: "❌ Unknown ticket type." }).catch(() => {});
            return;
          }
          const kind = interaction.customId.replace("ticket_", "");
          const setup = await (0, store_1.getGuildSetup)(interaction.guildId);
          const guild = interaction.guild;
          const topic = `ticket:${kind}:${interaction.user.id}`;
          const existing = guild.channels.cache.find(
            (c) => c.isTextBased() && !c.isDMBased() && c.topic === topic
          );
          if (existing) {
            await interaction.editReply({ content: `You already have ${existing}` }).catch(() => {});
            return;
          }
          const MAX_TICKETS = 3;
          const userTickets = guild.channels.cache.filter(
            (c) =>
              c.isTextBased() &&
              !c.isDMBased() &&
              c.topic?.startsWith("ticket:") &&
              c.topic?.endsWith(`:${interaction.user.id}`)
          );
          if (userTickets.size >= MAX_TICKETS) {
            const list = [...userTickets.values()].map((c) => `${c}`).join(", ");
            await interaction
              .editReply({
                content: `❌ You already have ${userTickets.size} open tickets (${list}). Close one before opening another.`,
              })
              .catch(() => {});
            return;
          }
          const base = `ticket-${kind}-${interaction.user.username}-${interaction.user.id.slice(-4)}`
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "")
            .slice(0, 90);
          const isStaffReport = kind === "staff";
          const staffNames = isStaffReport
            ? ["Owner", "Admin", "Manager"]
            : ["Owner", "Admin", "Manager", "Dev", "Moderator", "Mod", "Staff", "Support"];
          const staffRoles = staffNames
            .map((n) => guild.roles.cache.find((r) => r.name === n))
            .filter(Boolean);
          const supportRole = isStaffReport
            ? guild.roles.cache.find((r) => r.name === "Admin") ?? guild.roles.cache.find((r) => r.name === "Owner")
            : guild.roles.cache.find((r) => r.name === "Support") ?? guild.roles.cache.find((r) => r.name === "Staff");
          const overwrites = [
            { id: guild.roles.everyone.id, deny: [discord_js_1.PermissionFlagsBits.ViewChannel] },
            {
              id: interaction.user.id,
              allow: [
                discord_js_1.PermissionFlagsBits.ViewChannel,
                discord_js_1.PermissionFlagsBits.SendMessages,
                discord_js_1.PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ];
          for (const r of staffRoles) {
            overwrites.push({
              id: r.id,
              allow: [
                discord_js_1.PermissionFlagsBits.ViewChannel,
                discord_js_1.PermissionFlagsBits.SendMessages,
                discord_js_1.PermissionFlagsBits.ReadMessageHistory,
              ],
            });
          }
          const channel = await guild.channels.create({
            name: base,
            type: discord_js_1.ChannelType.GuildText,
            parent: setup?.ticketCategoryId ?? undefined,
            topic,
            permissionOverwrites: overwrites,
            reason: `${type.label} opened by ${interaction.user.tag}`,
          });
          const closeRow = new discord_js_1.ActionRowBuilder().addComponents(
            new discord_js_1.ButtonBuilder()
              .setCustomId("ticket_close")
              .setLabel("Close Ticket")
              .setStyle(discord_js_1.ButtonStyle.Danger)
              .setEmoji("🔒")
          );
          const tpl = await (0, botConfig_1.getTemplate)().catch(() => null);
          const prompts = tpl?.ticketPrompts ?? {
            bug: "Describe the bug + attach screenshots + order ID if purchase-related.",
            claim: "Send your **order ID + username + proof of payment**. Staff will deliver here.",
            general: "Describe your issue (payment, delivery, site).",
            staff: "Staff report is **private to Admins**. Provide user, proof, what happened.",
            partner: "Tell us about your server/store, members, what partnership you want.",
          };
          await channel.send({
            content: `${supportRole ?? "Support"} — new ${type.label} ticket from **${interaction.user.username}**.`,
            embeds: [
              new discord_js_1.EmbedBuilder()
                .setTitle(`${type.emoji} ${type.label}`)
                .setDescription(prompts[kind] ?? "Describe your issue.")
                .setColor(0xe67e22),
            ],
            components: [closeRow],
          });
          if (setup) {
            const logCh = guild.channels.cache.get(setup.channels["ticketlogs"]);
            if (logCh?.isTextBased()) {
              await logCh
                .send({
                  embeds: [
                    new discord_js_1.EmbedBuilder()
                      .setTitle("🎫 Ticket opened")
                      .setDescription(`#${channel.name} • ${type.label} • ${interaction.user.username}`)
                      .setColor(0x3498db),
                  ],
                })
                .catch(() => {});
            }
          }
          await interaction.editReply({ content: `Ticket created: ${channel}` }).catch(() => {});
          return;
        }

        if (interaction.customId === "ticket_close") {
          if (!interaction.channel?.isTextBased() || interaction.channel.isDMBased()) return;
          const ch0 = interaction.channel;
          if (!ch0.name.startsWith("ticket-")) {
            await interaction
              .reply({ content: "❌ Use this button inside a ticket channel.", ephemeral: true })
              .catch(() => {});
            return;
          }
          let deferred = false;
          try {
            await interaction.deferReply({ ephemeral: true });
            deferred = true;
          } catch {}
          const say = async (m) => {
            if (deferred) await interaction.editReply(m).catch(() => {});
          };
          try {
            const ch = interaction.channel;
            const msgList = await fetchAllMessages(ch).catch(() => []);
            const setup = await (0, store_1.getGuildSetup)(interaction.guildId).catch(() => null);
            const guild = interaction.guild;
            const logCh = setup ? guild.channels.cache.get(setup.channels["ticketlogs"]) : undefined;
            if (logCh?.isTextBased()) {
              const closer = `${interaction.user.username}`;
              const embed = new discord_js_1.EmbedBuilder()
                .setTitle(`🔒 Ticket closed: #${ch.name}`)
                .setColor(0x95a5a6)
                .setDescription(`Closed by ${closer}\nTicket: #${ch.name}\nMessages: ${msgList.length}`)
                .setTimestamp();
              await logCh.send({ embeds: [embed] }).catch(() => {});
              if (msgList.length > 0) {
                try {
                  const roleMap = new Map();
                  for (const [, r] of guild.roles.cache) roleMap.set(r.id, r.name);
                  const chanMap = new Map();
                  for (const [, c] of guild.channels.cache) if ("name" in c) chanMap.set(c.id, c.name);
                  const openerId = (ch.topic ?? "").startsWith("ticket:")
                    ? ch.topic.split(":")[2] ?? ""
                    : "";
                  let openerTag = "unknown";
                  if (openerId) {
                    const om = await guild.members.fetch(openerId).catch(() => null);
                    if (om) openerTag = om.user.username ?? om.user.globalName ?? "unknown";
                  }
                  const file = await (0, transcript_1.buildTranscriptFile)(
                    msgList,
                    { users: new Map(), roles: roleMap, channels: chanMap },
                    {
                      channelName: ch.name,
                      channelId: ch.id,
                      openedByTag: openerTag,
                      openedById: openerId || "unknown",
                      closedByTag: interaction.user.username,
                      closedById: interaction.user.id,
                      closedAtHuman: new Date().toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    }
                  );
                  await logCh.send({ files: [{ attachment: file.data, name: file.name }] }).catch(() => {});
                } catch {}
              }
            } else {
              (0, guildSync_1.queueGuildSync)(guild, "ticket-log self-heal").catch(() => {});
              await say({
                content: "⚠️ No ticket-logs channel right now (auto-sync will recreate it). Deleting anyway in 3s...",
              });
            }
            await say({ content: "Closing + logged. Deleting in 3s..." });
          } catch {
            await say({ content: "Error logging, deleting in 3s..." });
          }
          setTimeout(() => interaction.channel?.delete().catch(() => {}), 3000);
          return;
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === "ping") {
        await interaction.reply(`Pong! ${client.ws.ping}ms`);
        return;
      }
    } catch (e) {
      console.error("[Discord Bot interaction]", e);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ Something went wrong.", ephemeral: true }).catch(() => {});
      }
    }
  });

  return client;
}

async function startOrRestartDiscordBot(customCreds = {}) {
  if (customCreds.token !== undefined) runtimeCredentials.token = String(customCreds.token).trim();
  if (customCreds.clientId !== undefined) runtimeCredentials.clientId = String(customCreds.clientId).trim();
  if (customCreds.guildId !== undefined) runtimeCredentials.guildId = String(customCreds.guildId).trim();

  process.env.DISCORD_TOKEN = runtimeCredentials.token;
  process.env.CLIENT_ID = runtimeCredentials.clientId;
  process.env.GUILD_ID = runtimeCredentials.guildId;

  if (!dashboardStarted) {
    dashboardStarted = true;
    (0, dashboard_1.startDashboard)().catch((e) =>
      console.warn("[Discord Bot Dashboard] Standalone port notice:", e.message)
    );
  }

  if (!runtimeCredentials.token || !runtimeCredentials.clientId) {
    lastError = "Waiting for DISCORD_TOKEN and CLIENT_ID (configure in .env or Discord Bot tab)";
    console.log(`[Discord Bot] ${lastError}`);
    return { ok: false, error: lastError };
  }

  if (isStarting) return { ok: false, error: "Discord bot is already starting" };
  isStarting = true;

  try {
    if (activeClient) {
      try {
        await activeClient.destroy();
      } catch {}
      activeClient = null;
    }

    const client = createDiscordClient();
    activeClient = client;
    (0, dashboard_1.setBotClient)(client);
    (0, guildSync_1.watchTemplateChanges)(client);

    await deployCommands(runtimeCredentials.token, runtimeCredentials.clientId, runtimeCredentials.guildId).catch(
      (e) => console.warn("[Discord Bot deployCommands warning]", e.message)
    );
    await client.login(runtimeCredentials.token);
    lastError = null;
    isStarting = false;
    return { ok: true, tag: client.user?.tag || null };
  } catch (err) {
    lastError = err?.message || String(err);
    isStarting = false;
    console.error("[Discord Bot login failed]", lastError);
    return { ok: false, error: lastError };
  }
}

async function syncAllDiscordGuildsNow() {
  if (!activeClient || !activeClient.isReady()) {
    return { ok: false, error: "Discord bot is not connected yet." };
  }
  await (0, guildSync_1.syncAllGuilds)(activeClient, "manual dashboard sync");
  return { ok: true };
}

async function notifyDiscordOrder(order) {
  if (!activeClient || !activeClient.isReady()) return;
  try {
    for (const [, guild] of activeClient.guilds.cache) {
      const setup = await (0, store_1.getGuildSetup)(guild.id).catch(() => null);
      const logChId = setup?.channels?.["ticketlogs"] || setup?.channels?.["modlog"] || setup?.logChannelId;
      if (!logChId) continue;
      const ch = guild.channels.cache.get(logChId);
      if (!ch || !ch.isTextBased()) continue;

      const items = [];
      if (Number(order.money) > 0) items.push(`💸 $${Number(order.money).toLocaleString()} Money`);
      if (Number(order.spawners) > 0) items.push(`🦴 ${order.spawners}x Skeleton Spawner`);
      if (Number(order.elytras) > 0) items.push(`🪽 ${order.elytras}x Elytra`);

      const statusColor =
        order.status === "completed" ? 0x2ecc71 : order.status === "failed" ? 0xe74c3c : 0x3498db;
      const embed = new discord_js_1.EmbedBuilder()
        .setTitle(`🛒 Bluxmart Auto-Delivery — ${String(order.status || "queued").toUpperCase()}`)
        .setColor(statusColor)
        .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(order.recipient || "MHF_Steve")}/64`)
        .addFields(
          { name: "Buyer (IGN)", value: `\`${order.recipient}\``, inline: true },
          { name: "Order ID", value: `\`${order.id}\``, inline: true },
          { name: "Contents", value: items.join(" + ") || "Custom Order", inline: false }
        )
        .setTimestamp();

      await ch.send({ embeds: [embed] }).catch(() => {});
    }
  } catch {}
}

function getDiscordBotStatus() {
  const ready = Boolean(activeClient && activeClient.isReady());
  const guilds = ready
    ? [...activeClient.guilds.cache.values()].map((g) => ({
        id: g.id,
        name: g.name,
        memberCount: g.memberCount,
      }))
    : [];
  return {
    ready,
    tag: activeClient?.user?.tag || null,
    ping: ready ? activeClient.ws.ping : -1,
    guildCount: guilds.length,
    guilds,
    tokenConfigured: Boolean(runtimeCredentials.token),
    clientId: runtimeCredentials.clientId || "",
    guildId: runtimeCredentials.guildId || "",
    dashboardPort: Number(process.env.DASHBOARD_PORT || 3001),
    lastError,
  };
}

module.exports = {
  startOrRestartDiscordBot,
  syncAllDiscordGuildsNow,
  notifyDiscordOrder,
  getDiscordBotStatus,
  getTemplate: botConfig_1.getTemplate,
  saveTemplate: botConfig_1.saveTemplate,
};
