require('dotenv').config();

const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const pino = require('pino');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const db = require('./utils/db');
const { loadSlashCommands, loadContextMenus } = require('./utils/commandLoader');
const ZoneService = require('./services/ZoneService');
const PolicyService = require('./services/PolicyService');
const AnonService = require('./services/AnonService');
const EventService = require('./services/EventService');
const ActivityService = require('./services/ActivityService');
const TempGroupService = require('./services/TempGroupService');

const logger = pino({
	level: process.env.LOG_LEVEL || 'info',
	transport: process.env.NODE_ENV !== 'production' ? {
		target: 'pino-pretty',
		options: {
			colorize: true,
			translateTime: 'SYS:standard'
		}
	} : undefined
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
	partials: [
		Partials.Channel,
		Partials.Message,
		Partials.User,
		Partials.Reaction
	]
});

const slashCommands = loadSlashCommands(path.join(__dirname, 'commands'), logger);
const contextMenus = loadContextMenus(path.join(__dirname, 'context'));

client.commands = new Collection(slashCommands);
client.contextMenus = new Collection(contextMenus);

const eventsPath = path.join(__dirname, 'events');
const eventFiles = require('node:fs').readdirSync(eventsPath).filter((file) => file.endsWith('.js'));
for (const file of eventFiles) {
	const event = require(path.join(eventsPath, file));
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args, client));
	} else {
		client.on(event.name, (...args) => event.execute(...args, client));
	}
}

const pool = db.getPool();

const services = {};
services.zone = new ZoneService(client, pool, logger);
services.policy = new PolicyService(client, pool, services.zone, logger);
services.activity = new ActivityService(client, pool, services.zone, logger);
services.anon = new AnonService(client, pool, services.zone, services.activity, logger);
services.event = new EventService(client, pool, services.zone, services.activity, logger);
services.tempGroup = new TempGroupService(client, pool, services.zone, services.activity, logger);

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

process.on('unhandledRejection', (error) => {
	logger.error({ err: error }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
	logger.error({ err: error }, 'Uncaught exception');
});

if (!process.env.DISCORD_TOKEN) {
	logger.error('Missing DISCORD_TOKEN in environment');
	process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).then(() => {
	logger.info('Logging in to Discord...');
}).catch((error) => {
	logger.error({ err: error }, 'Failed to login');
	process.exit(1);
});
