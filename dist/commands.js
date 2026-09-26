"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.commands = void 0;
const discord_js_1 = require("discord.js");
exports.commands = [
    new discord_js_1.SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
].map((command) => command.toJSON());
