# BluxBot — live Discord server manager

BluxBot manages an **existing** Discord server in place. It does not create a Discord guild, delete the server, or require a `/setup` command for routine changes.

- Roles, channels, permissions, welcome/autorole, panels, and ticket configuration are reconciled incrementally.
- Reviews use separate `⭐・leave-a-review` (submission picker) and `🌟・reviews` (published customer-review feed) channels.
- Existing managed IDs are reused. Missing resources are created; removed template entries are left alone rather than deleted.
- The bot automatically syncs its configured guild on startup and when the bot joins a guild.
- If `GUILD_ID` (or the newer guild allowlist setting) is set, only those guilds are managed. Without an allowlist, the bot manages the guilds it can see.

## Requirements

- Node.js 24.x
- A Discord application with a bot token and **Server Members Intent**
- `.env` containing `DISCORD_TOKEN` and `CLIENT_ID`
- Optional `GUILD_ID` or `ALLOWED_GUILD_IDS` for scoped management and instant guild command updates

See `.env.example` for the dashboard settings. Never commit `.env` or `data/*.json`.

## Run locally (visible terminal)

```text
npm install
copy .env.example .env
# edit .env, then:
npm run dev:visible
```

`dev:visible` opens a normal interactive PowerShell window. It is intentionally not launched with a hidden-window flag. The development supervisor watches `src/`, reloads the TypeScript process when files change, and retries a failed login visibly, so you do not need to run a setup command or manually restart the bot after each edit. The same output is mirrored to `logs/bluxbot.log`.

For a non-interactive health check:

```text
npm run server:status
```

## Live configuration changes

The dashboard at `http://localhost:3001` is the normal configuration surface:

1. Edit **Roles & Channels**, **Tickets & Panels**, or **Servers**.
2. Save.
3. The running process applies the change in place and returns the sync result.

The same applies when an automation or the OpenCode server skill edits `data/bot-config.json`: a file watcher queues an incremental sync. `data/guilds.json` is read on demand, so mapping changes are also live. The bot never runs a destructive clean operation as part of sync.

The only Discord command exposed by the bot is:

```text
/ping
```

`/setup`, `/setup full`, `/setup status`, and `/setup clean` are intentionally not registered.

## Publish source changes to an existing VPS

Dependencies must already be installed and the existing `bluxbot` PM2 process must already exist:

```text
bash scripts/server-update.sh
```

The script builds and performs a PM2 reload. It does not install Node, install PM2, delete the process, delete Discord resources, or provision a new server. Run `npm ci` separately only when dependencies or the lockfile changed.

For Docker, publish a new image and replace the container as usual; a container cannot execute changed source code without being replaced.

## Development checks

```text
npm run check
npm run build
```

The build cleans `dist/` first so removed source files cannot remain as stale runtime modules.

## Project skill

The reusable OpenCode skill at `.opencode/skills/bluxbot-server/SKILL.md` describes the safe live-edit workflow. It explicitly forbids `/setup`, destructive cleanup, and recreating the server for small changes.
