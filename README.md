# 🌍 SelfWorld - Discord Zone Management Bot

> A production-ready Discord bot for creating and managing private community zones with advanced privacy features, anonymous channels, and comprehensive activity tracking.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
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
- Cross-zone anonymity with consistent usernames
- Webhook-based message relaying
- Comprehensive audit logging for moderation
- Mention sanitization for security

### 🎯 **Hub System**
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
- Hot-reloadable commands and events
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
└─────────────┬───────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────┐
│                    Service Layer                            │
│  • ZoneService     • AnonService      • HubService          │
│  • ActivityService • TempGroupService • EventService        │
└─────────────┬───────────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────────┐
│                    Data Layer (MySQL)                       │
│  • Zones  • Members  • Channels  • Activity  • Logs         │
└─────────────────────────────────────────────────────────────┘
```

---

## 📋 Prerequisites

- **Node.js** >= 18.0.0
- **MySQL** >= 8.0
- **Discord Bot Token** with the following intents:
  - `GUILDS`
  - `GUILD_MEMBERS`
  - `GUILD_MESSAGES`
  - `MESSAGE_CONTENT`
  - `GUILD_WEBHOOKS`

---

## 🚀 Installation

### 1. Clone the repository

```bash
git clone https://github.com/yourusername/SelfWorld.git
cd SelfWorld/bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file in the `bot/` directory:

```env
# Discord Configuration
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_client_id_here
GUILD_ID=your_discord_guild_id_here

# Owner Configuration
OWNER_USER_ID=your_discord_user_id_here

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
│   │   ├── admin/         # Owner-only commands
│   │   ├── temp-group/    # Temporary group management
│   │   └── zone/          # Zone management commands
│   ├── events/            # Discord event handlers
│   │   ├── ready.js       # Bot initialization
│   │   ├── messageCreate.js
│   │   ├── interactionCreate.js
│   │   └── guildMemberAdd.js
│   ├── services/          # Business logic layer
│   │   ├── ZoneService.js
│   │   ├── AnonService.js
│   │   ├── HubService.js
│   │   ├── ActivityService.js
│   │   ├── TempGroupService.js
│   │   └── EventService.js
│   ├── utils/             # Utility functions
│   │   ├── TaskScheduler.js
│   │   ├── ids.js
│   │   ├── anonNames.js
│   │   └── embedStyles.js
│   ├── config/            # Configuration files
│   └── index.js           # Entry point
├── schema.sql             # Database schema
├── package.json
└── .env.example
```

---

## 🎮 Key Commands

### Admin Commands (Owner Only)

| Command | Description |
|---------|-------------|
| `/zone-create` | Create a new zone manually |
| `/zone-delete <id>` | Delete a zone and all resources |
| `/zones-list` | List all zones in the guild |
| `/settings-anonlog-set` | Configure anonymous message logging |

### Zone Commands

| Command | Description |
|---------|-------------|
| `/zone-invite <code>` | Join a zone using an invite code |
| `/zone-leave` | Leave the current zone |
| `/zone-settings` | Configure zone settings |

### Temporary Group Commands

| Command | Description |
|---------|-------------|
| `/temp-group-create` | Create a temporary group in your zone |
| `/temp-group-invite` | Invite member to temp group |
| `/temp-group-leave` | Leave a temporary group |

---

## 🛠️ Services Overview

### ZoneService
Manages zone lifecycle including creation, deletion, member management, and permissions. Handles automatic cleanup of orphaned resources and foreign key cascading.

**Key Methods:**
- `createZone(member, guildId, config)` - Creates a new zone with all channels and roles
- `deleteZone(zoneId, guildId)` - Completely removes a zone and all associated data
- `cleanupOrphans()` - Removes zones with missing Discord resources

### AnonService
Provides anonymous messaging functionality with persistent identities per zone. Uses webhooks for message relaying and maintains comprehensive audit logs.

**Key Methods:**
- `handleMessage(message)` - Processes and relays anonymous messages
- `getOrCreateAnonIdentity(userId, zoneId)` - Ensures consistent anonymous names

### HubService
Creates personalized welcome channels for new members with interactive panels. Manages announcements, events, and scheduled tasks.

**Key Methods:**
- `ensureHubChannelForMember(member)` - Creates hub channel for new members
- `sendWizardToUser(channel, options)` - Sends interactive onboarding wizard
- `scheduleAnnouncement(data)` - Schedules staff announcements

### ActivityService
Tracks zone activity and sends alerts for low engagement. Uses a normalized scoring algorithm to compare activity against target metrics.

**Key Methods:**
- `trackActivity(zoneId, channelId)` - Records message activity
- `getZoneActivityScore(zoneId, days)` - Calculates normalized activity score
- `postLowActivityAlerts()` - Sends alerts for zones below 10% target activity

### TempGroupService
Manages temporary groups within zones with automatic expiration. Creates isolated channel structures with custom permissions.

**Key Methods:**
- `createTempGroup(zoneId, member, config)` - Creates temporary group structure
- `sweepExpired()` - Automatically removes expired groups

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
- **Audit Logging**: Comprehensive logs for moderation and debugging

---

## 📊 Database Schema

The bot uses a normalized MySQL schema with proper foreign key constraints and cascading deletes:

- **zones**: Core zone configuration and Discord resource IDs
- **zone_members**: Zone membership tracking
- **zone_roles**: Custom zone role definitions
- **zone_channels**: Custom zone channels
- **temp_groups**: Temporary group structures
- **anon_channels**: Anonymous channel configuration
- **anon_logs**: Anonymous message audit logs
- **zone_activity**: Activity tracking data
- **panel_messages**: Interactive panel state
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

Check the logs at startup for database connection confirmation. The bot will log any connection errors with full details.

---

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Code Style

- Use ESLint for code formatting
- Follow existing naming conventions
- Add JSDoc comments for new methods
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

[Report Bug](https://github.com/yourusername/SelfWorld/issues) · [Request Feature](https://github.com/yourusername/SelfWorld/issues)

</div>
