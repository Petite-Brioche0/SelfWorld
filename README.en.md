# 🌍 SelfWorld — Discord Zone Management Bot

> 🇫🇷 [Version française disponible → README.md](README.md)

> A Discord bot for creating and managing private community zones, with anonymous messaging, an interactive admin panel, and activity tracking.

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue.svg)](https://discord.js.org/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0+-orange.svg)](https://www.mysql.com/)

---

## ✨ Features

### 🔒 Zone Management
- Create private zones with configurable permissions
- Automatic channel creation (reception, general, anonymous, voice)
- Role-based access control (Owner / Member roles)
- Low-activity alerts
- Temporary groups with automatic expiration
- Custom zone channels with configurable permissions

### 🎭 Anonymous Messaging
- Persistent anonymous identities per zone
- Webhook-based message relaying
- Comprehensive audit logs for moderation
- Mention sanitization (@everyone, @here)

### 🚪 Welcome & Onboarding
- Interactive wizard sent to new members: zone browsing, invite code redemption, zone join requests, zone creation requests
- Discoverable zones with pagination and activity bar
- Single-use invite codes valid for 24 h (6 characters, A–Z0–9)

### 📋 Zone Access Policy
- Three modes: **open** (immediate access), **ask** (on request), **closed**
- Configurable join request approver: owner or zone members
- `cv-entretien` channel created automatically in `ask / owner` mode
- Public zone profile (title, description, colour, tags)

### 📊 Activity Tracking
- Normalised activity score (60 % messages, 40 % voice minutes)
- Daily alerts for inactive zones
- Per-day tracking in the database

### ⚙️ Infrastructure
- Task scheduler with concurrent-execution protection
- In-memory rate limiting
- Graceful shutdown
- Structured logging with Pino

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Discord Gateway                        │
└─────────────┬───────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────┐
│                    Event Handlers                           │
│  • messageCreate  • interactionCreate  • guildMemberAdd     │
│  • guildMemberRemove                                        │
└─────────────┬───────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────┐
│                    Service Layer                            │
│  • ZoneService       • AnonService       • HubService       │
│  • ActivityService   • TempGroupService  • EventService     │
│  • PolicyService     • PanelService      • WelcomeService   │
│  • StaffPanelService • ThrottleService                      │
└─────────────┬───────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────┐
│                    Data Layer (MySQL)                       │
│  • Zones  • Members  • Channels  • Activity  • Logs         │
└─────────────────────────────────────────────────────────────┘
```

---

## 📋 Prerequisites

- **Node.js** >= 20.0.0
- **MySQL** >= 8.0
- **Discord Bot Token** with the following intents:
  - `GUILDS`
  - `GUILD_MEMBERS`
  - `GUILD_MESSAGES`
  - `MESSAGE_CONTENT`
  - `GUILD_VOICE_STATES`
  - `GUILD_MESSAGE_REACTIONS`

---

## 🚀 Installation

### 1. Clone the repository

```bash
git clone https://github.com/Petite-Brioche0/SelfWorld.git
cd SelfWorld/bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

```env
# Discord
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_client_id_here
GUILD_ID=your_discord_guild_id_here

# Bot owner
OWNER_ID=your_discord_user_id_here

# Database
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=selfworld
DB_PASSWORD=selfworld
DB_NAME=selfworld

# Environment
NODE_ENV=development
```

### 4. Set up the database

```bash
mysql -u root -p
```

```sql
CREATE DATABASE selfworld;
CREATE USER 'selfworld'@'localhost' IDENTIFIED BY 'selfworld';
GRANT ALL PRIVILEGES ON selfworld.* TO 'selfworld'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

```bash
mysql -u selfworld -p selfworld < bot/schema.sql
```

### 5. Deploy slash commands

```bash
npm run deploy:cmd
```

### 6. Start the bot

```bash
npm run dev
```

---

## 📁 Project Structure

```
bot/
├── src/
│   ├── commands/
│   │   └── admin/                    # Owner-only slash commands
│   │       ├── zone.create.js
│   │       ├── zone.delete.js
│   │       ├── zones.list.js
│   │       └── settings.anonlog.set.js
│   ├── events/                       # Discord event handlers
│   │   ├── ready.js
│   │   ├── messageCreate.js
│   │   ├── interactionCreate.js
│   │   ├── guildMemberAdd.js
│   │   └── guildMemberRemove.js
│   ├── i18n/
│   │   └── fr.js                     # French locale (flat key/value)
│   ├── services/
│   │   ├── ZoneService.js
│   │   ├── AnonService.js
│   │   ├── HubService.js             # Coordinator (mixin)
│   │   ├── hub/
│   │   │   ├── requests.js           # Modal handlers + request lifecycle
│   │   │   └── builders.js           # Embed builders, formatters
│   │   ├── ActivityService.js
│   │   ├── TempGroupService.js
│   │   ├── EventService.js
│   │   ├── PolicyService.js          # Coordinator (mixin)
│   │   ├── policy/
│   │   │   ├── creation.js           # Zone creation requests
│   │   │   ├── config.js             # Policy, public profile, interview room
│   │   │   ├── joinRequests.js       # Join request lifecycle
│   │   │   └── inviteCodes.js        # Code generation & redemption
│   │   ├── PanelService.js           # Coordinator (mixin)
│   │   ├── panel/
│   │   │   ├── render.js             # Panel renderers (members, roles, channels, policy)
│   │   │   ├── members.js            # Member interaction handlers
│   │   │   ├── roles.js              # Role interaction handlers
│   │   │   └── channels.js           # Channel interaction handlers
│   │   ├── StaffPanelService.js
│   │   ├── WelcomeService.js
│   │   └── ThrottleService.js
│   └── utils/
│       ├── TaskScheduler.js
│       ├── db.js
│       ├── discord.js                # safeReply, safeDefer, fetchChannel…
│       ├── embeds.js                 # errorEmbed, successEmbed, infoEmbed + colour constants
│       ├── i18n.js                   # t(key, vars) — {variable} interpolation
│       ├── ids.js                    # shortId
│       ├── anonNames.js
│       ├── commandLoader.js
│       ├── permissions.js
│       ├── serviceHelpers.js         # normalizeColor, parseParticipants…
│       └── validation.js
├── tests/
│   ├── helpers/
│   │   ├── mockDb.js
│   │   ├── mockClient.js
│   │   └── mockInteraction.js
│   ├── services/
│   │   └── ActivityService.test.js
│   └── utils/
│       └── serviceHelpers.test.js
├── schema.sql
├── vitest.config.js
├── package.json
└── .env.example
```

> **Note:** User-facing interactions (joining zones, invite codes, events, etc.) are handled through button/modal/select-menu interactions routed via `interactionCreate.js`, not through dedicated slash command files.
>
> **Note:** Large services (HubService, PolicyService, PanelService) are decomposed into domain sub-modules using a prototype mixin pattern. The coordinator handles routing and shared infrastructure; sub-modules hold the business logic.

---

## 🎮 Commands

### Admin Commands (Owner Only)

| Command | Description |
|---------|-------------|
| `/zone-create` | Create a new zone manually |
| `/zone-delete <id>` | Delete a zone and all its resources |
| `/zones-list` | List all zones in the guild |
| `/settings-anonlog-set` | Configure the anonymous message log channel |

---

## 🛠️ Services Overview

### ZoneService
Manages the zone lifecycle: creation, deletion, member management, and permissions. Handles cleanup of orphaned resources.

### AnonService
Anonymous messaging with persistent identities per zone. Webhook-based relay with comprehensive audit logs.

### HubService
Manages personalised hub channels per member. Hub request lifecycle (announcements, events) with draft/review/approval workflow.

### WelcomeService
Interactive onboarding wizard sent to new members. Lets users browse zones with pagination, join via invite code (6 characters, 24 h, single-use), submit a zone join request, or request the creation of a new zone.

### PolicyService
Manages zone access policies (open/ask/closed), join requests, invite codes, public profiles (title, description, colour, tags), and the list of discoverable zones. Automatically creates/removes the `cv-entretien` channel based on the approver mode.

### PanelService
Interactive admin panel inside each zone: policy and public profile configuration, member management, custom roles, and channel management.

### StaffPanelService
Staff announcement and event scheduling panels with preview/approval workflow.

### ActivityService
Zone activity tracking. Normalised score (60 % messages, 40 % voice minutes). Daily alerts for inactive zones.

### TempGroupService
Temporary groups within zones with automatic expiration and isolated channel structures.

### EventService
Event lifecycle management: scheduling, participant tracking, associated temporary groups.

### ThrottleService
In-memory rate limiting and cooldown system across all interaction types.

---

## 🧪 Testing

The project uses [Vitest](https://vitest.dev/).

```bash
# Run all tests once
npm test

# Watch mode
npm run test:watch
```

Tests cover critical business logic (activity scoring, utility functions) via lightweight mocks — no real database or Discord connection required.

---

## 🔄 Task Scheduler

The bot includes a scheduler managing periodic operations:

- **Sweep expired groups** — hourly cleanup
- **Low-activity alerts** — daily zone checks
- **Process scheduled tasks** — announcements and events, every minute

All tasks include concurrent-execution prevention, timeout protection, error counting, and graceful shutdown support.

---

## 🔐 Security

- **Mention sanitization** — prevents @everyone / @here abuse in anonymous channels
- **Rate limiting** — prevents spam across all interaction types
- **Permission validation** — strict checks on all commands
- **Webhook security** — unique anonymous identities per zone
- **Parameterised queries** — SQL injection prevention with column whitelisting
- **Audit logging** — comprehensive logs for moderation
- **Startup DB check** — the bot validates the MySQL connection at launch and exits clearly on failure

---

## 📊 Database Schema

Normalised MySQL schema with foreign key constraints and cascading deletes:

- **zones** — core configuration and Discord resource IDs
- **zone_members** — zone membership
- **zone_member_roles** — custom role assignments per member
- **zone_roles** — custom zone role definitions
- **zone_invite_codes** — invite codes
- **zone_join_requests** — join request tracking
- **zone_creation_requests** — zone creation request workflows
- **temp_groups** — temporary group structures
- **temp_group_members** — temporary group membership
- **temp_group_channels** — temporary group channels
- **events** — event definitions and scheduling
- **event_participants** — event participant tracking
- **anon_channels** — anonymous channel configuration
- **anon_logs** — anonymous message audit logs
- **zone_activity** — daily activity data
- **hub_channels** — hub channel assignments per member
- **hub_requests** — hub request workflows
- **staff_announcements** — staff announcement scheduling
- **panel_messages** — interactive panel state
- **panel_message_registry** — panel message tracking
- **settings** — guild-level configuration

---

## 🐛 Debugging

- Set `NODE_ENV=development` for human-readable logs with full stack traces.
- The task scheduler logs execution counts, error counts, and the last successful run timestamp.
- The bot validates the MySQL connection at startup and exits with a clear error message if unreachable.

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Open a Pull Request

### Code Style
- ESLint is strict — always run `npm run lint` after editing
- Follow existing naming conventions

---

## 📝 License

MIT — see the LICENSE file for details.

---

## 🙏 Acknowledgments

- [Discord.js](https://discord.js.org/) — Discord API wrapper
- [Pino](https://getpino.io/) — fast JSON logger
- [MySQL2](https://github.com/sidorares/node-mysql2) — MySQL driver

---

<div align="center">

[Report a Bug](https://github.com/Petite-Brioche0/SelfWorld/issues) · [Request a Feature](https://github.com/Petite-Brioche0/SelfWorld/issues)

</div>
