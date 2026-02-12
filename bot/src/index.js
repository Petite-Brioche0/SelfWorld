
require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const pino = require('pino');

const db = require('./utils/db');
const { loadCommands } = require('./utils/commandLoader');
const { ZoneService } = require('./services/ZoneService');
const { PolicyService } = require('./services/PolicyService');
const { AnonService } = require('./services/AnonService');
const { EventService } = require('./services/EventService');
const { ActivityService } = require('./services/ActivityService');
const { TempGroupService } = require('./services/TempGroupService');
const { PanelService } = require('./services/PanelService');
const { StaffPanelService } = require('./services/StaffPanelService');
const { WelcomeService } = require('./services/WelcomeService');
const { HubService } = require('./services/HubService');
const { ThrottleService } = require('./services/ThrottleService');

const logger = pino({
	level: process.env.LOG_LEVEL || 'info',
	transport: process.env.NODE_ENV !== 'production'
		? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
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
		// Validate required environment variables
		const required = ['DISCORD_TOKEN', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
		const missing = required.filter((key) => !process.env[key]);
		if (missing.length) {
			logger.error({ missing }, 'Missing required environment variables');
			process.exit(1);
		}

		// Load commands
		const { commands, context } = await loadCommands(path.join(__dirname, 'commands'));
		client.commands = new Collection(commands);
		client.contextMenus = new Collection(context);

		// Load events
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

		// Validate database connection
		const pool = db.getPool();
		try {
			await pool.query('SELECT 1');
			logger.info('Database connection verified');
		} catch (dbErr) {
			logger.error({ err: dbErr }, 'Failed to connect to database');
			process.exit(1);
		}

		// Services
		const ownerId = process.env.OWNER_ID || process.env.OWNER_USER_ID;
		const zoneService = new ZoneService(client, pool, ownerId, logger);
		const policyService = new PolicyService(client, pool, logger);
		const services = {
			zone: zoneService,
			policy: policyService,
			activity: new ActivityService(client, pool),
			anon: new AnonService(client, pool, logger),
			event: new EventService(client, pool, logger),
			tempGroup: new TempGroupService(client, pool, logger)
		};
		services.panel = new PanelService(client, pool, logger);
		services.staffPanel = new StaffPanelService(client, pool, logger, services);
		services.throttle = new ThrottleService();
		services.hub = new HubService(client, pool, logger, services);
		zoneService.setPanelService(services.panel);
		policyService.setPanelService(services.panel);
		policyService.setServices(services);
		services.welcome = new WelcomeService(client, pool, logger, services);
		services.hub.setServices(services);

		client.context = {
			logger,
			pool,
			services,
			config: { ownerUserId: ownerId, modRoleId: process.env.MOD_ROLE_ID }
		};

		await client.login(process.env.DISCORD_TOKEN);
		logger.info('Logging in to Discord...');
	} catch (err) {
		logger.error({ err }, 'Failed to start bot');
		process.exit(1);
	}
})();

process.on('SIGINT', async () => {
	logger.info('Shutdown requested (SIGINT)');
	if (client.context.scheduler) {
		await client.context.scheduler.shutdown();
	}
	client.destroy();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	logger.info('Shutdown requested (SIGTERM)');
	if (client.context.scheduler) {
		await client.context.scheduler.shutdown();
	}
	client.destroy();
	process.exit(0);
});

process.on('unhandledRejection', (error) => {
	logger.error({ err: error }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (error) => {
	logger.error({ err: error }, 'Uncaught exception');
});
