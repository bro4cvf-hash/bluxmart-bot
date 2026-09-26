#!/usr/bin/env bash
# Publish an existing BluxBot checkout without provisioning or recreating a server.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v pm2 >/dev/null 2>&1; then
  echo "PM2 is not installed. This update only reloads an existing bot; it will not install or recreate anything." >&2
  exit 1
fi
if ! pm2 describe bluxbot >/dev/null 2>&1; then
  echo "The existing 'bluxbot' PM2 process was not found. Start the existing service once, then use this command for updates." >&2
  exit 1
fi

npm run build
pm2 reload bluxbot --update-env
pm2 save
echo "BluxBot published without guild setup or resource recreation."
