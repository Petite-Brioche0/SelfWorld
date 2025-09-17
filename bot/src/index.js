require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const pino = require('pino');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const db = require('./utils/db');
const { loadCommands } = require('./utils/commandLoader');
const { ZoneService } = require('./services/ZoneService');
const { PolicyService } = require('./services/PolicyService');
const { AnonService } = require('./services/AnonService');
const { EventService } = require('./services/EventService');
const { ActivityService } = require('./services/ActivityService');
const { TempGroupService } = require('./services/TempGroupService');

const logger = pino({
	level: process.env.LOG_LEVEL || 'info',
	transport: process.env.NODE_ENV !== 'production'
		? {
			target: 'pino-pretty',
			options: { colorize: true, translateTime: 'SYS:standard' }
		}
		: undefined
});

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.MessageContent
	],
	partials: [Partials.Channel, Partials.Message, Partials.User, Partials.Reaction]
});

(async () => {
	try {
		// Charger commandes
		const { commands, context } = await loadCommands(path.join(__dirname, 'commands'));
		client.commands = new Collection(commands);
		client.contextMenus = new Collection(context);

		// Charger events
		const eventsPath = path.join(__dirname, 'events');
		const eventFiles = fs.readdirSync(eventsPath).filter((f) => f.endsWith('.js'));
		for (const file of eventFiles) {
			const event = require(path.join(eventsPath, file));
			if (event.once) {
				client.once(event.name, (...args) => event.execute(...args, client));
			} else {
				client.on(event.name, (...args) => event.execute(...args, client));
			}
		}

		// Services
		const pool = db.getPool();
		const services = {
            zone:      new ZoneService(client, pool, process.env.OWNER_ID),
            policy:    new PolicyService(client, pool),
            activity:  new ActivityService(client, pool),
            anon:      new AnonService(client, pool),
            event:     new EventService(client, pool),
            tempGroup: new TempGroupService(client, pool)
            };

		client.context = {
			logger,
			pool,
			services,
			rateLimiter: new RateLimiterMemory({ points: 5, duration: 10 }),
			config: {
				ownerUserId: process.env.OWNER_USER_ID,
				modRoleId: process.env.MOD_ROLE_ID
			}
		};

		if (!process.env.DISCORD_TOKEN) {
			logger.error('Missing DISCORD_TOKEN in environment');
			process.exit(1);
		}

		await client.login(process.env.DISCORD_TOKEN);
		logger.info('Logging in to Discord...');
	} catch (err) {
		logger.error({ err }, 'Failed to start bot');
		process.exit(1);
	}
})();

// Handlers globaux
process.on('unhandledRejection', (error) => {
	logger.error({ err: error }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (error) => {
	logger.error({ err: error }, 'Uncaught exception');
});
