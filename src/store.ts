import { promises as fs } from 'fs';
import path from 'path';

export interface GuildSetup {
  guildId: string;
  roles: Record<string, string>; // name -> roleId
  channels: Record<string, string>; // key -> channelId
  categoryIds?: Record<string, string>; // category name -> categoryId
  welcomeChannelId?: string;
  logChannelId?: string;
  ticketCategoryId?: string;
  autoRoleId?: string;
  updatedAt: string;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'guilds.json');

async function ensureFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, '{}', 'utf-8');
  }
}

export async function getGuildSetup(guildId: string): Promise<GuildSetup | null> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf-8');
  const all = JSON.parse(raw) as Record<string, GuildSetup>;
  return all[guildId] ?? null;
}

export async function saveGuildSetup(setup: GuildSetup): Promise<void> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf-8');
  const all = JSON.parse(raw) as Record<string, GuildSetup>;
  all[setup.guildId] = setup;
  await fs.writeFile(DATA_FILE, JSON.stringify(all, null, 2), 'utf-8');
}
