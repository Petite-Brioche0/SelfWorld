# 🌍 SelfWorld - Discord Zone Management Bot

> A production-ready Discord bot for creating and managing private community zones with advanced privacy features, anonymous channels, and comprehensive activity tracking.

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue.svg)](https://discord.js.org/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0+-orange.svg)](https://www.mysql.com/)

## ✨ Features

### 🔒 **Zone Management**
- Create private zones with customizable permissions
- Automatic channel creation (reception, general, anonymous, voice)
- Role-based access control (owner/member roles)
- Zone activity monitoring and alerts
- Temporary groups with automatic expiration
- Custom zone channels with configurable permissions

### 🎭 **Anonymous Messaging**
- Persistent anonymous identities per zone
- Webhook-based message relaying
- Comprehensive audit logging for moderation
- Mention sanitization for security

### 🎯 **Hub & Welcome System**
- Personalized welcome channels for new members
- Interactive panel-based navigation
- Wizard-style onboarding experience
- Staff announcement system
- Event scheduling and management

### 📊 **Activity & Analytics**
- Normalized activity scoring algorithm
- Low-activity alerts for inactive zones
- Daily activity tracking
- Zone engagement metrics

### ⚙️ **Advanced Features**
- Task scheduler with lifecycle management
- Rate limiting and spam protection
- Graceful shutdown handling
- Structured logging with Pino
- Owner-only administrative commands

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

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

```env
# Discord Configuration
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_client_id_here
GUILD_ID=your_discord_guild_id_here

# Owner Configuration
OWNER_ID=your_discord_user_id_here

# Database Configuration
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
# Create MySQL database
mysql -u root -p

# In MySQL shell:
CREATE DATABASE selfworld;
CREATE USER 'selfworld'@'localhost' IDENTIFIED BY 'selfworld';
GRANT ALL PRIVILEGES ON selfworld.* TO 'selfworld'@'localhost';
FLUSH PRIVILEGES;
EXIT;

# Import schema
mysql -u selfworld -p selfworld < bot/schema.sql
```

### 5. Deploy slash commands

```bash
npm run deploy:cmd
```

### 6. Start the bot

```bash
# Development mode with pretty logs
npm run dev
```

---

## 📁 Project Structure

```
bot/
├── src/
│   ├── commands/          # Slash commands
│   │   └── admin/         # Owner-only commands
│   │       ├── zone.create.js
│   │       ├── zone.delete.js
│   │       ├── zones.list.js
│   │       └── settings.anonlog.set.js
│   ├── events/            # Discord event handlers
│   │   ├── ready.js
│   │   ├── messageCreate.js
│   │   ├── interactionCreate.js
│   │   ├── guildMemberAdd.js
│   │   └── guildMemberRemove.js
│   ├── i18n/              # Locale strings
│   │   └── fr.js          # French locale (flat key/value)
│   ├── services/          # Business logic layer
│   │   ├── ZoneService.js
│   │   ├── AnonService.js
│   │   ├── HubService.js
│   │   │   ├── hub/requests.js   # Modal handlers + request lifecycle
│   │   │   └── hub/builders.js   # Embed/form builders + formatters
│   │   ├── ActivityService.js
│   │   ├── TempGroupService.js
│   │   ├── EventService.js
│   │   ├── PolicyService.js
│   │   │   ├── policy/creation.js     # Zone creation requests
│   │   │   ├── policy/config.js       # Policy config interactions
│   │   │   ├── policy/joinRequests.js # Join request lifecycle
│   │   │   └── policy/inviteCodes.js  # Invite code CRUD
│   │   ├── PanelService.js
│   │   │   ├── panel/render.js    # Panel embed renderers
│   │   │   ├── panel/members.js   # Member interaction handlers
│   │   │   ├── panel/roles.js     # Role interaction handlers
│   │   │   └── panel/channels.js  # Channel interaction handlers
│   │   ├── StaffPanelService.js
│   │   ├── WelcomeService.js
│   │   └── ThrottleService.js
│   └── utils/             # Utility functions
│       ├── TaskScheduler.js
│       ├── db.js
│       ├── discord.js        # Shared Discord helpers (safeReply, fetchChannel…)
│       ├── embeds.js         # Shared embed builders + color constants
│       ├── i18n.js           # t(key, vars) localisation helper
│       ├── ids.js
│       ├── anonNames.js
│       ├── commandLoader.js
│       ├── permissions.js
│       ├── serviceHelpers.js # normalizeColor, parseParticipants, …
│       └── validation.js
├── tests/                 # Vitest unit tests
│   ├── helpers/
│   │   ├── mockDb.js
│   │   ├── mockClient.js
│   │   └── mockInteraction.js
│   ├── services/
│   │   └── ActivityService.test.js
│   └── utils/
│       └── serviceHelpers.test.js
├── schema.sql             # Database schema
├── vitest.config.js       # Test runner configuration
├── package.json
└── .env.example
```

> **Note:** User-facing interactions (joining zones, browsing, invite codes, events, etc.) are handled through button/modal/select-menu interactions routed via `interactionCreate.js`, not through dedicated slash command files.
>
> **Note:** Large services (HubService, PolicyService, PanelService) are decomposed into domain sub-modules using a prototype mixin pattern. The coordinator file handles routing and shared infrastructure; domain files hold the business logic.

---

## 🎮 Key Commands

### Admin Commands (Owner Only)

| Command | Description |
|---------|-------------|
| `/zone-create` | Create a new zone manually |
| `/zone-delete <id>` | Delete a zone and all resources |
| `/zones-list` | List all zones in the guild |
| `/settings-anonlog-set` | Configure anonymous message logging |

---

## 🛠️ Services Overview

### ZoneService
Manages zone lifecycle including creation, deletion, member management, and permissions. Handles automatic cleanup of orphaned resources and foreign key cascading.

### AnonService
Provides anonymous messaging functionality with persistent identities per zone. Uses webhooks for message relaying and maintains comprehensive audit logs.

### HubService
Creates personalized welcome channels for new members with interactive panels. Manages hub requests for announcements and events, including draft/review/approval workflows.

### PolicyService
Handles zone access policies (open/ask/closed), join requests, invite code generation, and zone creation request workflows.

### PanelService
Manages the admin panel channels within each zone, providing interactive controls for zone configuration, member management, role assignment, and channel management.

### StaffPanelService
Manages staff-level announcement and event scheduling panels with preview/approval workflows.

### WelcomeService
Handles the welcome flow for new members joining the server, including zone browsing and join-code redemption.

### ActivityService
Tracks zone activity and sends alerts for low engagement. Uses a normalized scoring algorithm (60% messages, 40% voice minutes) to compare activity against target metrics.

### TempGroupService
Manages temporary groups within zones with automatic expiration. Creates isolated channel structures with custom permissions.

### EventService
Handles event lifecycle management including scheduling, participant tracking, and event-specific temporary groups.

### ThrottleService
In-memory rate limiting and cooldown system to prevent spam and abuse across all interaction types.

---

## 🧪 Testing

The project uses [Vitest](https://vitest.dev/) for unit testing.

```bash
# Run all tests once
npm test

# Watch mode
npm run test:watch
```

Tests cover critical business logic (activity scoring, utility functions) using lightweight mocks — no real database or Discord connection required.

---

## 🔄 Task Scheduler

The bot includes a robust task scheduler that manages periodic operations:

- **Sweep Expired Groups**: Hourly cleanup of expired temporary groups
- **Low Activity Alerts**: Daily checks for inactive zones
- **Process Scheduled Tasks**: Minute-by-minute processing of announcements and events

All tasks include:
- Timeout protection
- Concurrent execution prevention
- Error tracking and logging
- Graceful shutdown support

---

## 🔐 Security Features

- **Mention Sanitization**: Prevents @everyone and @here abuse in anonymous channels
- **Rate Limiting**: Prevents spam and abuse with flexible rate limiters
- **Permission Validation**: Strict permission checks on all commands
- **Webhook Security**: Unique anonymous identities prevent cross-zone tracking
- **SQL Injection Prevention**: Parameterized queries with column whitelisting
- **Audit Logging**: Comprehensive logs for moderation and debugging
- **Database Validation**: Connection health check at startup

---

## 📊 Database Schema

The bot uses a normalized MySQL schema with proper foreign key constraints and cascading deletes:

- **zones**: Core zone configuration and Discord resource IDs
- **zone_members**: Zone membership tracking
- **zone_member_roles**: Custom role assignments per zone member
- **zone_roles**: Custom zone role definitions
- **zone_invite_codes**: Invite code management
- **zone_join_requests**: Join request tracking
- **zone_creation_requests**: Zone creation request workflows
- **temp_groups**: Temporary group structures
- **temp_group_members**: Temporary group membership
- **temp_group_channels**: Temporary group channels
- **events**: Event definitions and scheduling
- **event_participants**: Event participant tracking
- **anon_channels**: Anonymous channel configuration
- **anon_logs**: Anonymous message audit logs
- **zone_activity**: Activity tracking data
- **hub_channels**: Hub channel assignments per member
- **hub_requests**: Hub request workflows
- **staff_announcements**: Staff announcement scheduling
- **panel_messages**: Interactive panel state
- **panel_message_registry**: Panel message tracking
- **settings**: Guild-level configuration

---

## 🐛 Debugging

### Enable verbose logging

Set `NODE_ENV=development` in your `.env` file to enable pretty-printed logs with full stack traces.

### Check task scheduler status

The task scheduler provides status information in logs:
- Task execution counts
- Error counts
- Last successful run timestamp

### Verify database connections

The bot validates the database connection at startup and will exit with a clear error message if MySQL is unreachable.

---

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

Quick start:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Code Style

- Use ESLint for code formatting (`npm run lint`)
- Follow existing naming conventions
- Add JSDoc comments for new public methods
- Update documentation for new features

---

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

---

## 🙏 Acknowledgments

- [Discord.js](https://discord.js.org/) - Powerful Discord API wrapper
- [Pino](https://getpino.io/) - Super fast JSON logger
- [MySQL2](https://github.com/sidorares/node-mysql2) - Fast MySQL driver

---

## 💡 Support

For questions, issues, or feature requests:

- Open an issue on GitHub
- Check existing documentation
- Review the code comments for implementation details

---

<div align="center">

**Made with ❤️ for Discord communities**

[Report Bug](https://github.com/Petite-Brioche0/SelfWorld/issues) · [Request Feature](https://github.com/Petite-Brioche0/SelfWorld/issues)

</div>
