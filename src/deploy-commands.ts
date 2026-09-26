import { REST, Routes } from 'discord.js';
import { config } from './config';
import { commands } from './commands';

async function main() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
    console.log('Guild commands deployed');
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('Global commands deployed');
  }
}
main();
