"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const config_1 = require("./config");
const commands_1 = require("./commands");
async function main() {
    const rest = new discord_js_1.REST({ version: '10' }).setToken(config_1.config.token);
    if (config_1.config.guildId) {
        await rest.put(discord_js_1.Routes.applicationGuildCommands(config_1.config.clientId, config_1.config.guildId), { body: commands_1.commands });
        console.log('Guild commands deployed');
    }
    else {
        await rest.put(discord_js_1.Routes.applicationCommands(config_1.config.clientId), { body: commands_1.commands });
        console.log('Global commands deployed');
    }
}
main();
