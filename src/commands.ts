import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
  new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Check invite count and 3M/invite reward eligibility')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to check invites for').setRequired(false),
    ),
].map((command) => command.toJSON());
