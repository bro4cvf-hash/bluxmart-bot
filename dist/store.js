"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGuildSetup = getGuildSetup;
exports.saveGuildSetup = saveGuildSetup;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const DATA_DIR = path_1.default.join(process.cwd(), 'data');
const DATA_FILE = path_1.default.join(DATA_DIR, 'guilds.json');
async function ensureFile() {
    await fs_1.promises.mkdir(DATA_DIR, { recursive: true });
    try {
        await fs_1.promises.access(DATA_FILE);
    }
    catch {
        await fs_1.promises.writeFile(DATA_FILE, '{}', 'utf-8');
    }
}
async function getGuildSetup(guildId) {
    await ensureFile();
    const raw = await fs_1.promises.readFile(DATA_FILE, 'utf-8');
    const all = JSON.parse(raw);
    return all[guildId] ?? null;
}
async function saveGuildSetup(setup) {
    await ensureFile();
    const raw = await fs_1.promises.readFile(DATA_FILE, 'utf-8');
    const all = JSON.parse(raw);
    all[setup.guildId] = setup;
    await fs_1.promises.writeFile(DATA_FILE, JSON.stringify(all, null, 2), 'utf-8');
}
