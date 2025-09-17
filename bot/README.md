# Discord Zone Server Bot

Starter template for a production-ready Discord bot orchestrating isolated zones with anonymised cross-zone chatter.

## Requirements

- Node.js 18+
- MySQL 8+
- Discord application with a bot token and privileged intents enabled

## Setup

1. Copy the environment template and fill it with your secrets:
   ```bash
   cp .env.example .env
   ```
2. Provision the database schema:
   ```bash
   mysql -u <user> -p <database> < schema.sql
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Deploy guild-scoped commands (only run on development guilds):
   ```bash
   npm run deploy:cmd
   ```
5. Start the bot:
   ```bash
   npm run dev
   ```

## Project structure

- `src/index.js` – bootstraps the Discord client, services and events
- `src/services/` – domain services (zones, policies, anonymity, events, activity, temporary groups)
- `src/commands/` – slash command fragments grouped by domain
- `src/events/` – Discord event handlers (ready, interactions, anonymisation listener)
- `src/utils/` – helper utilities (database pool, id helpers, permissions orchestrator)
- `schema.sql` – MySQL schema covering zones, join requests, anonymity, events and telemetry

## Development notes

- Sensitive command replies are ephemeral to avoid cross-zone leaks.
- Zone owners must use bot commands for privileged actions; no direct role/channel management permissions are granted.
- Anonymous relays fan-out through per-zone webhooks while logging cleartext to the configured admin channel.
